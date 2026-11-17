/**
 * Host half of the to-do bundle.
 *
 * It owns the list document (`$DSH_HOME/dsh-apple-reminders/todos.json`), keeps one or
 * more Apple Reminders lists in two-way sync with it, exposes the list to the
 * model as one tool, and serves the right-sidebar panel over two exact Fetch
 * routes on the shared `/api` channel.
 *
 * Sync is a three-way merge per field: each task remembers what was last
 * written to Reminders, so an edit made here and an edit made on the phone are
 * told apart. A field changed on one side wins there; a field changed on both
 * resolves in DSH's favour.
 *
 * @module dsh-apple-reminders
 */
import {
  createReminder, deleteReminder, ensureLists, listNames, moveReminder, readLists, remindersAvailable, updateReminder,
} from './lib/reminders.js'
import { existsSync } from 'node:fs'

import { defaultFilePath, legacyFilePath, loadState, newId, pruneTombstones, TodoStore } from './lib/store.js'
import { CHEAP_FIELDS, FIELDS, fromItem, planMerge, planPush, toMirror } from './lib/sync.js'

/** The model-facing tool name; `todo_write` and `run_code` belong to the product. */
const TOOL_NAME = 'personal_todos'
/** Reminders list that mirrors the tasks when nothing else is configured. */
const DEFAULT_LIST_NAME = 'DSH 待办'
/** Background merge while a panel is open; a full pass costs one mirror read. */
const DEFAULT_SYNC_INTERVAL_MS = 60000
/** Every Nth background pass reads the expensive fields (notes, due, flag, priority). */
const DETAIL_EVERY = 5
/** Coalesce a burst of local edits into one push. */
const PUSH_DEBOUNCE_MS = 600
/** Reuse the last merge when a panel opens within this window. */
const FRESH_MERGE_MS = 60000
/** One pass creates at most this many reminders, so a big import stays responsive. */
const MAX_CREATES_PER_PASS = 20
/** Fields the panel may set on one task. */
const PATCHABLE = ['text', 'done', 'notes', 'due', 'flagged', 'priority', 'list']

/** @param {unknown} error - any thrown value. @returns {string} a short message. */
const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/** @param {unknown} value - config value. @returns {string[]} normalized list names. */
function readListNames(config) {
  const raw = Array.isArray(config.lists) ? config.lists : []
  const names = raw
    .filter((name) => typeof name === 'string' && name.trim() !== '')
    .map((name) => name.trim())
  if (names.length > 0) return [...new Set(names)]
  const single = typeof config.listName === 'string' && config.listName.trim() !== ''
    ? config.listName.trim() : DEFAULT_LIST_NAME
  return [single]
}

/**
 * Host entry point.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} [config] - this row's config from `cordis.patch.yml`.
 * @param {string} [config.file] - absolute path of the list document.
 * @param {string[]} [config.lists] - Apple Reminders lists to keep in sync.
 * @param {string} [config.listName] - single-list shorthand.
 * @param {boolean} [config.reminders] - set false to keep everything local.
 * @param {number} [config.syncIntervalMs] - background merge period.
 * @param {number} [config.raceWindowMs] - how long a freshly pushed reminder is exempt from being read as deleted.
 */
export function apply(ctx, config = {}) {
  const settings = {
    file: typeof config.file === 'string' && config.file.trim() !== '' ? config.file : defaultFilePath(),
    lists: readListNames(config),
    reminders: config.reminders !== false && remindersAvailable(),
    syncIntervalMs: Number.isFinite(config.syncIntervalMs) && config.syncIntervalMs > 0
      ? config.syncIntervalMs : DEFAULT_SYNC_INTERVAL_MS,
    raceWindowMs: Number.isFinite(config.raceWindowMs) && config.raceWindowMs >= 0
      ? config.raceWindowMs : undefined,
  }
  const log = ctx.logger ?? console
  const store = new TodoStore(settings.file)
  /**
   * Load the list, importing the file the plugin used before it was renamed.
   * @returns {Promise<object>} the loaded state.
   */
  const ready = (async () => {
    const state = await store.load()
    // Only the default location is ever migrated; an explicitly configured file is left alone.
    if (settings.file !== defaultFilePath() || state.items.length > 0 || existsSync(settings.file)) return state
    const legacy = await loadState(legacyFilePath()).catch(() => null)
    if (legacy === null || legacy.items.length === 0) return state
    log.info?.(`dsh-apple-reminders: importing the list from ${legacyFilePath()}`)
    return store.commit((draft) => {
      draft.items = legacy.items
      draft.tombstones = legacy.tombstones
      draft.settings = legacy.settings
    })
  })()
  ready.catch((error) => { log.error?.(`dsh-apple-reminders: cannot read ${settings.file}: ${messageOf(error)}`) })

  /** SSE writers of every open panel. */
  const panels = new Set()
  /** Last known mirror state, published to the panel with the list. */
  let mirrorStatus = { status: settings.reminders ? 'idle' : 'off', lastSyncAt: null, error: null }
  let debounce = null
  let interval = null
  let ticks = 0
  let chain = Promise.resolve()
  /** Every Reminders list name, once somebody asked for it. */
  let availableLists = null

  /**
   * @param {object} item - stored task.
   * @returns {string} the Reminders list it belongs to.
   */
  const listOf = (item) => (typeof item.list === 'string' && item.list !== '' ? item.list : chosenLists()[0])

  /** @returns {string[]} the lists the user chose to sync; the config seeds this. */
  const chosenLists = () => {
    const stored = store.get().settings?.lists
    return Array.isArray(stored) && stored.length > 0 ? stored : settings.lists
  }

  /** @returns {string[]} every list that has to be read: chosen ones plus any task's own. */
  const readNames = () => [...new Set([...chosenLists(), ...store.get().items.map(listOf).filter(Boolean)])]

  /**
   * Run one pass after the previous one; a failure never blocks the queue.
   * @param {() => Promise<void>} task - the pass.
   * @returns {Promise<void>} resolution when it finished.
   */
  function enqueue(task) {
    const next = chain.then(task, task)
    chain = next.then(() => {}, () => {})
    return next
  }

  /** @returns {object} what the panel and the tool read. */
  function snapshot() {
    const state = store.get()
    const sync = {
      enabled: settings.reminders,
      status: mirrorStatus.status,
      listName: chosenLists()[0],
      lists: chosenLists(),
    }
    if (Array.isArray(availableLists)) sync.available = availableLists
    if (mirrorStatus.lastSyncAt !== null) sync.lastSyncAt = mirrorStatus.lastSyncAt
    if (mirrorStatus.error !== null) sync.error = mirrorStatus.error
    return {
      rev: state.rev,
      items: state.items.map((item) => {
        const view = { id: item.id, text: item.text, done: item.done, list: listOf(item) }
        if (item.notes !== undefined) view.notes = item.notes
        if (item.due !== undefined) view.due = item.due
        if (item.flagged === true) view.flagged = true
        if (item.priority !== undefined) view.priority = item.priority
        return view
      }),
      sync,
    }
  }

  /** Push the current snapshot to every open panel. */
  function publish() {
    const data = snapshot()
    for (const write of panels) write(data)
  }

  store.subscribe(() => { publish() })

  /**
   * @param {'idle'|'syncing'|'error'} status - new mirror state.
   * @param {string|null} [error] - reason, when it failed.
   * @param {boolean} [stamped] - record this pass as a successful merge.
   */
  function setStatus(status, error = null, stamped = false) {
    mirrorStatus = {
      status,
      lastSyncAt: stamped ? Date.now() : mirrorStatus.lastSyncAt,
      error,
    }
    publish()
  }

  /** Queue a push shortly after a local edit. */
  function schedulePush() {
    if (!settings.reminders || debounce !== null) return
    debounce = setTimeout(() => {
      debounce = null
      void pushNow()
    }, PUSH_DEBOUNCE_MS)
    debounce.unref?.()
  }

  /** Delete the reminders of tasks that left the list, then forget them. */
  async function flushTombstones() {
    for (const entry of store.get().tombstones) {
      await deleteReminder(entry.list ?? settings.lists[0], entry.reminderId)
      await store.commit((draft) => {
        draft.tombstones = draft.tombstones.filter((candidate) => candidate.reminderId !== entry.reminderId)
      })
    }
  }

  /** @param {object} task - normalized fields. @returns {object} what Reminders should store. */
  function mirrorProps(task) {
    const props = { text: task.text }
    for (const field of FIELDS) {
      if (field === 'text') continue
      if (task[field] !== undefined || field === 'done') props[field] = toMirror(field, task[field])
    }
    return props
  }

  /**
   * Mirror one task into Reminders and record the reminder id plus the baseline.
   * @param {{itemId: string, list: string, task: object}} entry - planned task.
   */
  async function createMirror(entry) {
    const reminderId = await createReminder(entry.list, mirrorProps(entry.task))
    const state = await store.commit((draft) => {
      const item = draft.items.find((candidate) => candidate.id === entry.itemId)
      if (item === undefined) return
      item.reminderId = reminderId
      item.list = entry.list
      item.synced = { ...entry.task, done: entry.task.done === true, list: entry.list }
      item.pushedAt = Date.now()
    })
    // The task may have been deleted while the write was in flight; a leftover
    // reminder would come back as a new task on the next pass.
    const item = state.items.find((candidate) => candidate.id === entry.itemId)
    if (item === undefined || item.reminderId !== reminderId) {
      await deleteReminder(entry.list, reminderId).catch(() => {})
    }
  }

  /**
   * Write one changed task to its reminder and record what was written.
   * @param {{itemId: string, list: string, reminderId: string, patch: object}} entry - planned write.
   */
  async function pushUpdate(entry) {
    const props = {}
    for (const [field, value] of Object.entries(entry.patch)) props[field] = toMirror(field, value)
    const found = await updateReminder(entry.list, entry.reminderId, props)
    await store.commit((draft) => {
      const item = draft.items.find((candidate) => candidate.id === entry.itemId)
      if (item === undefined || item.reminderId !== entry.reminderId) return
      if (!found) {
        // The reminder is gone; forget it so the next push recreates it.
        delete item.reminderId
        delete item.synced
        return
      }
      item.pushedAt = Date.now()
      if (item.synced === undefined) return
      for (const [field, value] of Object.entries(entry.patch)) {
        if (value === undefined) delete item.synced[field]
        else item.synced[field] = value
      }
    })
  }

  /**
   * @param {{itemId: string, list: string, reminderId: string}} entry - a task deleted on the phone.
   */
  async function dropItem(entry) {
    await store.commit((draft) => {
      const index = draft.items.findIndex((candidate) => (
        candidate.id === entry.itemId && candidate.reminderId === entry.reminderId
      ))
      if (index >= 0) draft.items.splice(index, 1)
    })
  }

  /**
   * @param {{list: string, reminderId: string, task: object}} entry - a task added on the phone.
   */
  async function importItem(entry) {
    await store.commit((draft) => {
      if (draft.items.some((item) => item.reminderId === entry.reminderId)) return
      const item = {
        id: newId(),
        text: entry.task.text,
        done: entry.task.done === true,
        createdAt: Date.now(),
        list: entry.list,
        reminderId: entry.reminderId,
        synced: { ...entry.task, done: entry.task.done === true, list: entry.list },
      }
      if (item.done) item.doneAt = Date.now()
      for (const field of ['notes', 'due', 'flagged', 'priority']) {
        if (entry.task[field] !== undefined) item[field] = entry.task[field]
      }
      draft.items.push(item)
    })
  }

  /**
   * @param {{itemId: string, list: string, reminderId: string}} entry - a completed task old enough to stop mirroring.
   */
  async function pruneItem(entry) {
    await deleteReminder(entry.list, entry.reminderId).catch(() => {})
    await store.commit((draft) => {
      const item = draft.items.find((candidate) => candidate.id === entry.itemId)
      if (item === undefined || item.reminderId !== entry.reminderId) return
      delete item.reminderId
      delete item.synced
      delete item.pushedAt
    })
  }

  /**
   * @param {{itemId: string, reminderId: string, from: string, to: string}} entry - a task that changed list.
   */
  async function moveEntry(entry) {
    const found = await moveReminder(entry.from, entry.reminderId, entry.to)
    await store.commit((draft) => {
      const item = draft.items.find((candidate) => candidate.id === entry.itemId)
      if (item === undefined || item.reminderId !== entry.reminderId) return
      if (!found) {
        delete item.reminderId
        delete item.synced
        return
      }
      item.list = entry.to
      item.pushedAt = Date.now()
      if (item.synced !== undefined) item.synced.list = entry.to
    })
  }

  /**
   * @param {{itemId: string, fields: object}} entry - fields pulled from the phone.
   */
  async function applyPull(entry) {
    await store.commit((draft) => {
      const item = draft.items.find((candidate) => candidate.id === entry.itemId)
      if (item === undefined) return
      for (const [field, value] of Object.entries(entry.fields)) {
        if (field === 'text') item.text = value
        else if (field === 'done') {
          item.done = value === true
          if (item.done) item.doneAt = Date.now()
          else delete item.doneAt
        } else if (value === undefined) delete item[field]
        else item[field] = value
        if (item.synced !== undefined) {
          if (field === 'done') item.synced.done = value === true
          else if (value === undefined) delete item.synced[field]
          else item.synced[field] = value
        }
      }
    })
  }

  /**
   * Execute one plan, in an order that keeps the two sides converging.
   * @param {object} plan - from {@link planPush} or {@link planMerge}.
   */
  async function runPlan(plan) {
    for (const entry of plan.dropReminders ?? []) {
      await deleteReminder(entry.list, entry.reminderId)
      await store.commit((draft) => {
        draft.tombstones = draft.tombstones.filter((candidate) => candidate.reminderId !== entry.reminderId)
      })
    }
    for (const entry of plan.dropItems ?? []) await dropItem(entry)
    for (const entry of plan.pull ?? []) await applyPull(entry)
    for (const entry of plan.importItems ?? []) await importItem(entry)
    for (const entry of plan.prune ?? []) await pruneItem(entry)
    for (const entry of plan.move ?? []) await moveEntry(entry)
    const creates = plan.create ?? []
    for (const entry of creates.slice(0, MAX_CREATES_PER_PASS)) await createMirror(entry)
    if (creates.length > MAX_CREATES_PER_PASS) schedulePush()
    for (const entry of plan.update ?? []) await pushUpdate(entry)
    for (const entry of plan.adopt ?? []) {
      await store.commit((draft) => {
        const item = draft.items.find((candidate) => candidate.id === entry.itemId)
        if (item === undefined || item.reminderId === undefined) return
        item.synced = { ...entry.fields, done: entry.fields.done === true, list: entry.list ?? item.list }
        if (entry.list !== undefined) item.list = entry.list
      })
    }
    await store.commit((draft) => { pruneTombstones(draft) })
  }

  /** Push local edits and deletions; no mirror read, so a click stays fast. */
  async function pushPass() {
    await ready
    if (!settings.reminders) return
    setStatus('syncing')
    try {
      await flushTombstones()
      await runPlan(planPush(store.get().items, { listOf }))
      setStatus('idle')
    } catch (error) {
      setStatus('error', messageOf(error))
      log.warn?.(`dsh-apple-reminders: Apple Reminders push failed: ${messageOf(error)}`)
    }
  }

  /**
   * Read the mirror and merge both sides.
   * @param {boolean} detailed - read notes, due, flag and priority too.
   */
  async function mergePass(detailed) {
    await ready
    if (!settings.reminders) return
    setStatus('syncing')
    try {
      await flushTombstones()
      const names = readNames()
      const lists = await readLists(names, { detailed })
      // An empty mirror is still worth creating: it is how the user sees that
      // the sync exists at all.
      const missing = lists.filter((list) => !list.exists).map((list) => list.name)
      if (missing.length > 0) await ensureLists(missing)
      await runPlan(planMerge(store.get().items, lists, store.get().tombstones, {
        fields: detailed ? FIELDS : CHEAP_FIELDS,
        listOf,
        ...(settings.raceWindowMs === undefined ? {} : { raceMs: settings.raceWindowMs }),
      }))
      setStatus('idle', null, detailed)
    } catch (error) {
      setStatus('error', messageOf(error))
      log.warn?.(`dsh-apple-reminders: Apple Reminders merge failed: ${messageOf(error)}`)
    }
  }

  const pushNow = () => enqueue(pushPass)
  const mergeNow = (detailed = true) => enqueue(() => mergePass(detailed))

  /**
   * @param {object} patch - `{text, done, notes, due, flagged, priority}`.
   * @param {object} item - stored task to edit in place.
   */
  function applyPatch(patch, item) {
    for (const field of PATCHABLE) {
      if (patch[field] === undefined) continue
      if (field === 'text') {
        const text = String(patch.text).trim()
        if (text !== '') item.text = text
      } else if (field === 'done') {
        const done = patch.done === true
        if (item.done === done) continue
        item.done = done
        if (done) item.doneAt = Date.now()
        else delete item.doneAt
      } else if (field === 'notes') {
        const notes = String(patch.notes ?? '')
        if (notes.trim() === '') delete item.notes
        else item.notes = notes
      } else if (field === 'due') {
        const due = typeof patch.due === 'string' ? patch.due : ''
        if (due === '') delete item.due
        else item.due = due
      } else if (field === 'flagged') {
        if (patch.flagged === true) item.flagged = true
        else delete item.flagged
      } else if (field === 'list') {
        const list = typeof patch.list === 'string' ? patch.list.trim() : ''
        if (list !== '') item.list = list
      } else if (field === 'priority') {
        const priority = Number(patch.priority)
        if (Number.isFinite(priority) && priority > 0) item.priority = priority
        else delete item.priority
      }
    }
  }

  /**
   * Run one panel operation.
   * @param {object} op - `{op, ...}`.
   * @returns {Promise<object>} the state after the operation.
   */
  async function applyOp(op) {
    await ready
    const kind = typeof op.op === 'string' ? op.op : 'list'
    switch (kind) {
      case 'list':
        return snapshot()
      case 'add': {
        const text = String(op.text ?? '').trim()
        if (text === '') throw new Error('task text is empty')
        await store.commit((draft) => {
          const item = { id: newId(), text, done: false, createdAt: Date.now() }
          const list = typeof op.list === 'string' && op.list !== '' ? op.list : settings.lists[0]
          if (list !== settings.lists[0]) item.list = list
          applyPatch(op, item)
          draft.items.push(item)
        })
        schedulePush()
        return snapshot()
      }
      case 'toggle': {
        const id = String(op.id ?? '')
        await store.commit((draft) => {
          const item = draft.items.find((candidate) => candidate.id === id)
          if (item === undefined) return
          item.done = !item.done
          if (item.done) item.doneAt = Date.now()
          else delete item.doneAt
        })
        schedulePush()
        return snapshot()
      }
      case 'update': {
        const id = String(op.id ?? '')
        const patch = op.patch !== null && typeof op.patch === 'object' ? op.patch : {}
        await store.commit((draft) => {
          const item = draft.items.find((candidate) => candidate.id === id)
          if (item === undefined) return
          applyPatch(patch, item)
        })
        schedulePush()
        return snapshot()
      }
      case 'remove': {
        const id = String(op.id ?? '')
        let removed
        await store.commit((draft) => {
          const index = draft.items.findIndex((candidate) => candidate.id === id)
          if (index < 0) return
          removed = draft.items[index]
          draft.items.splice(index, 1)
        })
        if (removed?.reminderId !== undefined) {
          await store.commit((draft) => {
            draft.tombstones.push({ reminderId: removed.reminderId, list: listOf(removed), at: Date.now() })
          })
          schedulePush()
        }
        return snapshot()
      }
      case 'clear_done': {
        await store.commit((draft) => {
          for (const item of draft.items) {
            if (item.done && item.reminderId !== undefined) {
              draft.tombstones.push({ reminderId: item.reminderId, list: listOf(item), at: Date.now() })
            }
          }
          draft.items = draft.items.filter((item) => !item.done)
        })
        schedulePush()
        return snapshot()
      }
      case 'migrate': {
        const incoming = Array.isArray(op.items) ? op.items : []
        if (incoming.length === 0) return snapshot()
        await store.commit((draft) => {
          // Merge instead of refusing when the list already has something: the
          // usual order is a task added through the model, then the panel opens.
          const known = new Set(draft.items.map((item) => item.text))
          for (const raw of incoming) {
            const text = String(raw?.text ?? '').trim()
            if (text === '' || known.has(text)) continue
            known.add(text)
            const done = raw?.done === true
            const createdAt = Date.now()
            const item = { id: newId(), text, done, createdAt }
            if (done) item.doneAt = createdAt
            draft.items.push(item)
          }
        })
        schedulePush()
        return snapshot()
      }
      case 'lists':
        if (settings.reminders) availableLists = await listNames().catch(() => availableLists)
        return snapshot()
      case 'select': {
        const wanted = Array.isArray(op.lists)
          ? [...new Set(op.lists
            .filter((name) => typeof name === 'string' && name.trim() !== '')
            .map((name) => name.trim()))]
          : []
        await store.commit((draft) => {
          draft.settings = { ...draft.settings }
          if (wanted.length === 0) delete draft.settings.lists
          else draft.settings.lists = wanted
        })
        if (settings.reminders) availableLists = await listNames().catch(() => availableLists)
        schedulePush()
        if (settings.reminders) void mergeNow(true)
        return snapshot()
      }
      case 'sync':
        await mergeNow(true)
        return snapshot()
      default:
        throw new Error(`unknown operation "${kind}"`)
    }
  }

  // The list is model-facing: one tool, one flat schema, no approval bypass.
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => toolCtx.tools.register({
      name: TOOL_NAME,
      description: [
        'The user\'s personal to-do list, the same one shown in the right sidebar of the app.',
        'ops: list (default), add, toggle, update, remove, clear_done, sync (reconcile Apple Reminders now).',
        'add takes text plus optional list, due (YYYY-MM-DD), notes, flagged, priority (1 low, 5 medium, 9 high).',
        'toggle and remove need an id; update needs an id and any of text, notes, due, flagged, priority, done.',
        'The lists are kept in two-way sync with Apple Reminders, so edits made there appear here too.',
        'Complete or remove a task only when the user asks.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['list', 'add', 'toggle', 'update', 'remove', 'clear_done', 'sync'] },
          id: { type: 'string', description: 'Task id from a previous list result; required by toggle, update and remove.' },
          text: { type: 'string', description: 'Task text for add, or the replacement text for update.' },
          list: { type: 'string', description: 'Reminders list for a new task; defaults to the first configured one.' },
          due: { type: 'string', description: 'Due date as YYYY-MM-DD, or an empty string to clear it.' },
          notes: { type: 'string', description: 'Free-form notes; an empty string clears them.' },
          flagged: { type: 'boolean', description: 'Whether the task is flagged.' },
          priority: { type: 'number', description: 'Priority: 0 none, 1 low, 5 medium, 9 high.' },
          done: { type: 'boolean', description: 'Completion state for update.' },
        },
        required: ['op'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            rev: { type: 'number' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  text: { type: 'string' },
                  done: { type: 'boolean' },
                  list: { type: 'string' },
                  notes: { type: 'string' },
                  due: { type: 'string' },
                  flagged: { type: 'boolean' },
                  priority: { type: 'number' },
                },
                required: ['id', 'text', 'done', 'list'],
                additionalProperties: false,
              },
            },
            sync: {
              type: 'object',
              properties: {
                enabled: { type: 'boolean' },
                status: { type: 'string' },
                listName: { type: 'string' },
                lists: { type: 'array', items: { type: 'string' } },
                available: { type: 'array', items: { type: 'string' } },
                lastSyncAt: { type: 'number' },
                error: { type: 'string' },
              },
              required: ['enabled', 'status', 'listName', 'lists'],
              additionalProperties: false,
            },
          },
          required: ['rev', 'items', 'sync'],
          additionalProperties: false,
        },
        render(_args, value) {
          return [{ type: 'text', text: renderList(value) }]
        },
      },
      execute: async (args) => applyOp(args ?? { op: 'list' }),
    }), 'dsh-apple-reminders: tool')
  })

  /**
   * Open one panel's event stream: a snapshot now, then every change.
   * @param {Request} request - the carrier's request; its abort ends the stream.
   * @returns {Response} the `text/event-stream` response.
   */
  function openStream(request) {
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        const write = (data) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
          } catch {
            // The panel closed between the change and this frame.
          }
        }
        panels.add(write)
        void ready.then(() => {
          write(snapshot())
          // A newly opened panel is a cheap moment to pick up phone edits, but
          // not on every tab switch: skip a merge that just ran.
          const age = mirrorStatus.lastSyncAt === null ? Infinity : Date.now() - mirrorStatus.lastSyncAt
          if (settings.reminders && age > FRESH_MERGE_MS) void mergeNow(true)
        }, () => {})
        request.signal.addEventListener('abort', () => {
          panels.delete(write)
          try {
            controller.close()
          } catch {
            // Already closed by the carrier.
          }
        })
      },
    })
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
      },
    })
  }

  // The browser panel: one command route and one event stream, both on the
  // shared authenticated `/api` channel.
  ctx.inject(['connection'], (webCtx) => {
    webCtx.effect(() => webCtx.connection.fetch.register({
      path: '/api/dsh-apple-reminders/op',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body = {}
        try {
          body = await request.json()
        } catch {
          return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 })
        }
        try {
          const state = await applyOp(body ?? {})
          return Response.json({ ok: true, state }, { headers: { 'cache-control': 'no-store' } })
        } catch (error) {
          return Response.json({ ok: false, error: messageOf(error) }, {
            status: 400,
            headers: { 'cache-control': 'no-store' },
          })
        }
      },
    }), 'dsh-apple-reminders: op route')

    webCtx.effect(() => webCtx.connection.fetch.register({
      path: '/api/dsh-apple-reminders/events',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: (request) => Promise.resolve(openStream(request)),
    }), 'dsh-apple-reminders: event stream')
  })

  // Background merge only while somebody is looking at the panel. Cheap fields
  // every tick; notes, due, flag and priority every Nth tick because reading
  // them costs an Apple event per task.
  if (settings.reminders) {
    interval = setInterval(() => {
      if (panels.size === 0) return
      ticks += 1
      void mergeNow(ticks % DETAIL_EVERY === 0)
    }, settings.syncIntervalMs)
    interval.unref?.()
  }

  ctx.effect(() => () => {
    if (debounce !== null) clearTimeout(debounce)
    if (interval !== null) clearInterval(interval)
    panels.clear()
  }, 'dsh-apple-reminders: timers')
}

/**
 * Render the list as terse text for the transcript.
 * @param {{rev: number, items: object[], sync: object}} value - tool result.
 * @returns {string} the lines the user reads.
 */
function renderList(value) {
  const items = Array.isArray(value?.items) ? value.items : []
  const open = items.filter((item) => !item.done).length
  if (items.length === 0) return '待办清单是空的。'
  const lines = items.map((item) => {
    const marks = []
    if (item.flagged === true) marks.push('⚑')
    if (typeof item.due === 'string') marks.push(`截止 ${item.due}`)
    if (typeof item.priority === 'number') marks.push(`优先级 ${item.priority}`)
    if (typeof item.list === 'string') marks.push(item.list)
    const tail = marks.length > 0 ? `  （${marks.join(' · ')}）` : ''
    return `${item.done ? '[x]' : '[ ]'} ${item.text}${tail}`
  })
  const head = `待办 · ${items.length} 项（${open} 未完成）`
  const STATUS = { idle: '已同步', syncing: '同步中', error: '同步失败', off: '未启用' }
  const lists = Array.isArray(value?.sync?.lists) ? value.sync.lists.join('、') : ''
  const mirror = value?.sync?.enabled === true
    ? `镜像：${lists} · ${STATUS[value.sync.status] ?? value.sync.status}${value.sync.error === undefined ? '' : ` · ${value.sync.error}`}`
    : '镜像：未启用'
  return [head, ...lines, mirror].join('\n')
}
