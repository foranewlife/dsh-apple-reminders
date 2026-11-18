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
import { existsSync, watch } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

import {
  createList,
  createReminder,
  deleteList,
  deleteReminder,
  ensureLists,
  listDetails,
  listNames,
  moveReminder,
  readLists,
  remindersAvailable,
  updateListMirror,
  updateReminder,
} from './lib/reminders.js'
import {
  defaultFilePath,
  extractInlineTags,
  legacyFilePath,
  loadState,
  localDateString,
  newId,
  nextDueDate,
  normalizeDueTime,
  normalizeTags,
  pruneTombstones,
  pruneTrash,
  REPEAT_VALUES,
  TodoStore,
} from './lib/store.js'
import { CHEAP_FIELDS, FIELDS, planMerge, planPush, toMirror } from './lib/sync.js'

/** The model-facing tool name; `todo_write` and `run_code` belong to the product. */
const TOOL_NAME = 'personal_todos'
/** Reminders list that mirrors the tasks when nothing else is configured. */
const DEFAULT_LIST_NAME = 'DSH 待办'
/** Background merge while a panel is open; a full pass costs one mirror read. */
const DEFAULT_SYNC_INTERVAL_MS = 60000
/** Every Nth background pass reads the expensive fields (notes, due, dueTime, flag, priority). */
const DETAIL_EVERY = 5
/** Coalesce a burst of local edits into one push. */
const PUSH_DEBOUNCE_MS = 600
/** Reuse the last merge when a panel opens within this window. */
const FRESH_MERGE_MS = 60000
/** One pass creates at most this many reminders, so a big import stays responsive. */
const MAX_CREATES_PER_PASS = 20
/** Cross-process sync lock polling step, max wait, and stale-lock horizon. */
const SYNC_LOCK_POLL_MS = 150
const SYNC_LOCK_WAIT_MS = 15000
const SYNC_LOCK_STALE_MS = 90000
/** Fields the panel or tool may set on one task. */
const PATCHABLE = [
  'text',
  'done',
  'notes',
  'due',
  'dueTime',
  'urgent',
  'flagged',
  'priority',
  'list',
  'tags',
  'url',
  'repeat',
  'location',
  'parentId',
  'section',
  'order',
]

/** Shared task item schema properties for strict JSON Schema validation. */
const TASK_ITEM_PROPERTIES = {
  id: { type: 'string' },
  text: { type: 'string' },
  done: { type: 'boolean' },
  list: { type: 'string' },
  createdAt: { type: 'number' },
  doneAt: { type: 'number' },
  notes: { type: 'string' },
  due: { type: 'string' },
  dueTime: { type: 'string' },
  urgent: { type: 'boolean' },
  flagged: { type: 'boolean' },
  priority: { type: 'number' },
  tags: { type: 'array', items: { type: 'string' } },
  url: { type: 'string' },
  repeat: { type: 'string', enum: ['daily', 'weekdays', 'weekly', 'biweekly', 'monthly', 'yearly'] },
  location: { type: 'string' },
  parentId: { type: 'string' },
  section: { type: 'string' },
  order: { type: 'number' },
}

/** @param {unknown} error - any thrown value. @returns {string} a short message. */
const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/** @param {object} config - plugin config. @returns {string[]} normalized list names. */
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

/** Strip mirror bindings when converting an active item into a soft-deleted trash entry. */
function toTrashEntry(item, listName, now) {
  const entry = { ...item, list: listName, deletedAt: now }
  if (Array.isArray(item.tags)) entry.tags = [...item.tags]
  delete entry.reminderId
  delete entry.synced
  delete entry.pushedAt
  return entry
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
  const hasCustomMirror = config.mirror !== null && typeof config.mirror === 'object'
  const mirror = {
    createList,
    createReminder,
    deleteList,
    deleteReminder,
    ensureLists,
    listDetails,
    listNames,
    moveReminder,
    readLists,
    updateListMirror,
    updateReminder,
    ...(hasCustomMirror ? config.mirror : {}),
  }
  const autoDiscoverLists = config.autoDiscoverLists !== undefined
    ? config.autoDiscoverLists === true
    : (!Array.isArray(config.lists) && typeof config.listName !== 'string')
  const settings = {
    file: typeof config.file === 'string' && config.file.trim() !== '' ? config.file : defaultFilePath(),
    lists: readListNames(config),
    reminders: config.reminders !== false && (hasCustomMirror || remindersAvailable()),
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
      draft.trash = legacy.trash ?? []
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
  /** Colour per list name, so the panel can draw the same dots Reminders does. */
  let colourByName = null
  /** Emblem icon per list name when reported by Apple Reminders. */
  let emblemByName = null

  /** @returns {string[]} the lists the user chose to sync; the config seeds this. */
  const chosenLists = () => {
    const stored = store.get().settings?.lists
    return Array.isArray(stored) && stored.length > 0 ? stored : settings.lists
  }

  /**
   * @param {object} item - stored task.
   * @returns {string} the Reminders list it belongs to.
   */
  const listOf = (item) => (typeof item.list === 'string' && item.list !== '' ? item.list : chosenLists()[0])

  /** @returns {string[]} every list that has to be read: chosen ones plus any task's own. */
  const readNames = () => [...new Set([...chosenLists(), ...store.get().items.map(listOf).filter(Boolean)])]

  /** Refresh `availableLists`, `colourByName`, and `emblemByName` from Apple Reminders. */
  async function refreshAvailableLists() {
    if (!settings.reminders) {
      const state = store.get()
      const metaNames = Object.keys(state.settings?.listMeta ?? {})
      availableLists = [...new Set([...chosenLists(), ...metaNames, ...state.items.map(listOf).filter(Boolean)])]
      return
    }
    try {
      const details = await mirror.listDetails()
      availableLists = details.map((entry) => entry.name)
      const nextColors = { ...(colourByName ?? {}) }
      const nextEmblems = { ...(emblemByName ?? {}) }
      for (const entry of details) {
        if (entry.color !== '') nextColors[entry.name] = entry.color
        if (entry.emblem !== '') nextEmblems[entry.name] = entry.emblem
      }
      colourByName = nextColors
      emblemByName = nextEmblems
    } catch {
      // Keep previous cached metadata when Reminders cannot be queried right now.
    }
  }

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

  /** Project a single stored item into its public snapshot shape. */
  function viewItem(item, isTrash = false) {
    const view = { id: item.id, text: item.text, done: item.done, list: listOf(item) }
    if (Number.isFinite(item.createdAt)) view.createdAt = item.createdAt
    if (item.done && Number.isFinite(item.doneAt)) view.doneAt = item.doneAt
    if (item.notes !== undefined) view.notes = item.notes
    if (item.due !== undefined) view.due = item.due
    if (item.dueTime !== undefined) view.dueTime = item.dueTime
    if (item.urgent === true) view.urgent = true
    if (item.flagged === true) view.flagged = true
    if (item.priority !== undefined) view.priority = item.priority
    if (Array.isArray(item.tags) && item.tags.length > 0) view.tags = [...item.tags]
    if (item.url !== undefined) view.url = item.url
    if (item.repeat !== undefined) view.repeat = item.repeat
    if (item.location !== undefined) view.location = item.location
    if (item.parentId !== undefined) view.parentId = item.parentId
    if (item.section !== undefined) view.section = item.section
    if (Number.isFinite(item.order)) view.order = item.order
    if (isTrash) view.deletedAt = Number.isFinite(item.deletedAt) ? item.deletedAt : Date.now()
    return view
  }

  /**
   * @param {{includeTrash?: boolean}} [options] - whether to attach top-level `trash` array (default true).
   * @returns {object} what the panel and the tool read.
   */
  function snapshot(options = {}) {
    const includeTrash = options.includeTrash !== false
    const state = store.get()
    const lists = chosenLists()
    const metaMap = state.settings?.listMeta ?? {}
    const colorFor = (name) => metaMap[name]?.color || colourByName?.[name] || ''
    const iconFor = (name) => metaMap[name]?.icon || emblemByName?.[name] || ''

    const knownNames = [...new Set([
      ...lists,
      ...Object.keys(metaMap),
      ...(Array.isArray(availableLists) ? availableLists : []),
      ...state.items.map(listOf).filter(Boolean),
    ])]
    const listMeta = knownNames.map((name) => {
      const m = metaMap[name] ?? {}
      const out = { name }
      const color = colorFor(name)
      const icon = iconFor(name)
      if (color !== '') out.color = color
      if (icon !== '') out.icon = icon
      if (m.pinned === true) out.pinned = true
      if (Array.isArray(m.sections) && m.sections.length > 0) out.sections = [...m.sections]
      return out
    })

    const rawTrash = Array.isArray(state.trash) ? state.trash : []
    const sync = {
      enabled: settings.reminders,
      status: mirrorStatus.status,
      listName: lists[0],
      lists,
      listColors: lists.map(colorFor),
      listMeta,
      trashCount: rawTrash.length,
    }
    if (Array.isArray(availableLists)) {
      sync.available = availableLists
      sync.availableColors = availableLists.map(colorFor)
      sync.availableLists = availableLists.map((name) => {
        const entry = { name }
        const color = colorFor(name)
        const icon = iconFor(name)
        if (color !== '') entry.color = color
        if (icon !== '') entry.icon = icon
        return entry
      })
    }
    if (mirrorStatus.lastSyncAt !== null) sync.lastSyncAt = mirrorStatus.lastSyncAt
    if (mirrorStatus.error !== null) sync.error = mirrorStatus.error

    const result = {
      rev: state.rev,
      items: state.items.map((item) => viewItem(item, false)),
      sync,
    }
    if (includeTrash) {
      result.trash = rawTrash.map((item) => viewItem(item, true))
    }
    return result
  }

  /** Push the current snapshot to every open panel. */
  function publish() {
    const data = snapshot()
    for (const write of panels) write(data)
  }

  let fileWatcher = null
  let watchDebounce = null
  let disposed = false
  const targetDir = dirname(settings.file)
  const targetBase = basename(settings.file)

  /** Watch `dirname(settings.file)` so writes from other processes reload into `store`. */
  function startFileWatcher() {
    if (disposed || fileWatcher !== null) return
    try {
      fileWatcher = watch(targetDir, (_eventType, filename) => {
        if (filename !== null && filename !== undefined && filename !== '' && String(filename) !== targetBase) return
        if (watchDebounce !== null) clearTimeout(watchDebounce)
        watchDebounce = setTimeout(() => {
          watchDebounce = null
          if (!disposed) void store.reloadIfChanged().catch(() => {})
        }, 120)
        watchDebounce.unref?.()
      })
      fileWatcher.on?.('error', () => {
        try {
          fileWatcher?.close()
        } catch {}
        fileWatcher = null
      })
      fileWatcher.unref?.()
    } catch {
      fileWatcher = null
    }
  }

  void ready.then(() => { startFileWatcher() }, () => {})

  store.subscribe(() => {
    startFileWatcher()
    publish()
  })

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
      await mirror.deleteReminder(entry.list ?? chosenLists()[0], entry.reminderId)
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
    const reminderId = await mirror.createReminder(entry.list, mirrorProps(entry.task))
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
      await mirror.deleteReminder(entry.list, reminderId).catch(() => {})
    }
  }

  /**
   * Write one changed task to its reminder and record what was written.
   * @param {{itemId: string, list: string, reminderId: string, patch: object}} entry - planned write.
   */
  async function pushUpdate(entry) {
    const current = store.get().items.find((candidate) => candidate.id === entry.itemId)
    const targetList = current !== undefined ? listOf(current) : entry.list
    const props = {}
    for (const [field, value] of Object.entries(entry.patch)) props[field] = toMirror(field, value)
    if ('due' in entry.patch || 'dueTime' in entry.patch) {
      const effectiveDue = 'due' in entry.patch ? entry.patch.due : current?.due
      const effectiveDueTime = effectiveDue !== undefined
        ? ('dueTime' in entry.patch ? entry.patch.dueTime : current?.dueTime)
        : undefined
      props.due = toMirror('due', effectiveDue)
      props.dueTime = toMirror('dueTime', effectiveDueTime)
    }
    const found = await mirror.updateReminder(targetList, entry.reminderId, props)
    const replacedId = typeof found === 'string' && found !== '' && found !== entry.reminderId ? found : null
    const state = await store.commit((draft) => {
      const item = draft.items.find((candidate) => candidate.id === entry.itemId)
      if (item === undefined || item.reminderId !== entry.reminderId) return
      if (!found) {
        // The reminder is gone; forget it so the next push recreates it.
        delete item.reminderId
        delete item.synced
        return
      }
      const now = Date.now()
      if (replacedId !== null) {
        if (!draft.tombstones.some((candidate) => candidate.reminderId === entry.reminderId)) {
          draft.tombstones.push({ reminderId: entry.reminderId, list: targetList, at: now })
        }
        item.reminderId = replacedId
      }
      item.pushedAt = now
      if (item.synced === undefined) return
      for (const [field, value] of Object.entries(entry.patch)) {
        if (value === undefined) delete item.synced[field]
        else item.synced[field] = value
      }
      if ('due' in entry.patch && entry.patch.due === undefined) {
        delete item.synced.dueTime
      }
    })
    if (replacedId !== null) {
      const item = state.items.find((candidate) => candidate.id === entry.itemId)
      if (item === undefined || item.reminderId !== replacedId) {
        await mirror.deleteReminder(targetList, replacedId).catch(() => {})
      }
    }
  }

  /**
   * @param {{itemId: string, list: string, reminderId: string}} entry - a task deleted on the phone.
   */
  async function dropItem(entry) {
    await store.commit((draft) => {
      const index = draft.items.findIndex((candidate) => (
        candidate.id === entry.itemId && candidate.reminderId === entry.reminderId
      ))
      if (index < 0) return
      const [removed] = draft.items.splice(index, 1)
      const now = Date.now()
      draft.trash.push(toTrashEntry(removed, listOf(removed), now))
      pruneTrash(draft, now)
    })
  }

  /**
   * @param {{list: string, reminderId: string, task: object}} entry - a task added on the phone.
   */
  async function importItem(entry) {
    await store.commit((draft) => {
      if (draft.items.some((item) => item.reminderId === entry.reminderId)) return
      const now = Date.now()
      const synced = { ...entry.task, done: entry.task.done === true, list: entry.list }
      delete synced.id
      delete synced.completedAt
      const item = {
        id: newId(),
        text: entry.task.text,
        done: entry.task.done === true,
        createdAt: now,
        list: entry.list,
        reminderId: entry.reminderId,
        synced,
      }
      if (item.done) {
        item.doneAt = Number.isFinite(entry.task.completedAt) ? entry.task.completedAt : now
      }
      for (const field of ['notes', 'due', 'dueTime', 'flagged', 'priority']) {
        if (entry.task[field] !== undefined) item[field] = entry.task[field]
      }
      const inlineTags = extractInlineTags(entry.task.text, entry.task.notes)
      if (inlineTags.length > 0) item.tags = inlineTags
      draft.items.push(item)
    })
  }

  /**
   * @param {{itemId: string, list: string, reminderId: string}} entry - a completed task old enough to stop mirroring.
   */
  async function pruneItem(entry) {
    await mirror.deleteReminder(entry.list, entry.reminderId).catch(() => {})
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
    const found = await mirror.moveReminder(entry.from, entry.reminderId, entry.to)
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
      const now = Date.now()
      const wasDone = item.done === true
      for (const [field, value] of Object.entries(entry.fields)) {
        if (field === 'text') item.text = value
        else if (field === 'done') {
          item.done = value === true
          if (item.done) item.doneAt = now
          else delete item.doneAt
        } else if (value === undefined) {
          delete item[field]
          if (field === 'due') delete item.dueTime
        } else {
          item[field] = value
        }
        if (item.synced !== undefined) {
          if (field === 'done') item.synced.done = value === true
          else if (value === undefined) {
            delete item.synced[field]
            if (field === 'due') delete item.synced.dueTime
          } else {
            item.synced[field] = value
          }
        }
      }
      if (!wasDone && item.done === true && item.repeat !== undefined && REPEAT_VALUES.has(item.repeat)) {
        const nextTask = buildNextRepeatOccurrence(item, now)
        delete item.repeat
        draft.items.push(nextTask)
      }
    })
  }

  /**
   * Execute one plan, in an order that keeps the two sides converging.
   * @param {object} plan - from {@link planPush} or {@link planMerge}.
   */
  async function runPlan(plan) {
    for (const entry of plan.dropReminders ?? []) {
      await mirror.deleteReminder(entry.list, entry.reminderId)
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
    await store.commit((draft) => {
      pruneTombstones(draft)
      pruneTrash(draft)
    })
  }

  const syncLockDir = `${settings.file}.synclock`

  /**
   * Serialize Apple Reminders sync passes across processes (DSH, Sidecar, MCP)
   * using an atomic directory lock beside `todos.json`.
   * @template T
   * @param {() => Promise<T>} fn - critical section.
   * @returns {Promise<T>} result of `fn`.
   */
  async function withSyncLock(fn) {
    await mkdir(dirname(syncLockDir), { recursive: true, mode: 0o700 })
    const deadline = Date.now() + SYNC_LOCK_WAIT_MS
    let acquired = false
    while (!acquired) {
      try {
        await mkdir(syncLockDir, { mode: 0o700 })
        acquired = true
        break
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        try {
          const info = await stat(syncLockDir)
          if (Number.isFinite(info.mtimeMs) && Date.now() - info.mtimeMs > SYNC_LOCK_STALE_MS) {
            await rm(syncLockDir, { recursive: true, force: true }).catch(() => {})
            continue
          }
        } catch {
          continue
        }
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for sync lock ${syncLockDir}`)
        }
        await new Promise((resolve) => setTimeout(resolve, SYNC_LOCK_POLL_MS))
      }
    }
    try {
      return await fn()
    } finally {
      if (acquired) {
        await rm(syncLockDir, { recursive: true, force: true }).catch(() => {})
      }
    }
  }

  /** Push local edits and deletions; no mirror read, so a click stays fast. */
  async function pushPass() {
    await ready
    if (!settings.reminders) return
    setStatus('syncing')
    try {
      await withSyncLock(async () => {
        await store.reloadIfChanged()
        await flushTombstones()
        await runPlan(planPush(store.get().items, { listOf }))
      })
      setStatus('idle')
    } catch (error) {
      setStatus('error', messageOf(error))
      log.warn?.(`dsh-apple-reminders: Apple Reminders push failed: ${messageOf(error)}`)
    }
  }

  /**
   * Read the mirror and merge both sides.
   * @param {boolean} detailed - read notes, due, dueTime, flag and priority too.
   */
  async function mergePass(detailed) {
    await ready
    if (!settings.reminders) return
    setStatus('syncing')
    try {
      let stampedDetailed = detailed
      await withSyncLock(async () => {
        await store.reloadIfChanged()
        await flushTombstones()
        let refreshedDetails = false
        if (autoDiscoverLists) {
          const currentNames = detailed
            ? (await refreshAvailableLists(), (refreshedDetails = true), availableLists ?? [])
            : await mirror.listNames().catch(() => availableLists ?? [])
          const currentChosen = chosenLists()
          const excluded = new Set(store.get().settings?.excludedLists ?? [])
          const newLists = currentNames.filter((name) => !currentChosen.includes(name) && !excluded.has(name))
          if (newLists.length > 0) {
            if (!detailed) {
              await refreshAvailableLists()
              refreshedDetails = true
              detailed = true
              stampedDetailed = true
            }
            await store.commit((draft) => {
              const base = Array.isArray(draft.settings?.lists) && draft.settings.lists.length > 0
                ? draft.settings.lists
                : settings.lists
              draft.settings.lists = [...new Set([...base, ...newLists])]
            })
          }
        }
        const names = readNames()
        const lists = await mirror.readLists(names, { detailed })
        // List metadata (names, colours, emblems) changes rarely; refresh on detailed pass.
        if (detailed && !refreshedDetails) await refreshAvailableLists()
        // An empty mirror is still worth creating: it is how the user sees that
        // the sync exists at all.
        const missing = lists.filter((list) => !list.exists).map((list) => list.name)
        if (missing.length > 0) {
          await mirror.ensureLists(missing)
          if (Array.isArray(availableLists)) {
            availableLists = [...new Set([...availableLists, ...missing])]
          }
        }
        await runPlan(planMerge(store.get().items, lists, store.get().tombstones, {
          fields: detailed ? FIELDS : CHEAP_FIELDS,
          listOf,
          ...(settings.raceWindowMs === undefined ? {} : { raceMs: settings.raceWindowMs }),
        }))
      })
      setStatus('idle', null, stampedDetailed)
    } catch (error) {
      setStatus('error', messageOf(error))
      log.warn?.(`dsh-apple-reminders: Apple Reminders merge failed: ${messageOf(error)}`)
    }
  }

  const pushNow = () => enqueue(pushPass)
  const mergeNow = (detailed = true) => enqueue(() => mergePass(detailed))

  /** Build the next open occurrence when a repeating task is marked done. */
  function buildNextRepeatOccurrence(item, now = Date.now()) {
    const next = {
      id: newId(),
      text: item.text,
      done: false,
      createdAt: now,
      due: nextDueDate(item.due, item.repeat, now),
      repeat: item.repeat,
      list: listOf(item),
    }
    for (const field of ['notes', 'dueTime', 'urgent', 'flagged', 'priority', 'url', 'location', 'parentId', 'section', 'order']) {
      if (item[field] !== undefined) next[field] = item[field]
    }
    if (Array.isArray(item.tags) && item.tags.length > 0) next.tags = [...item.tags]
    return next
  }

  /**
   * Apply a partial task patch onto `item` in place.
   * @param {object} patch - partial fields.
   * @param {object} item - stored task to edit in place.
   */
  function applyPatch(patch, item) {
    const explicitDueClear = patch.due === '' || patch.due === null
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
        const due = typeof patch.due === 'string' ? patch.due.trim() : ''
        if (due === '') {
          delete item.due
          delete item.dueTime
        } else if (/^\d{4}-\d{2}-\d{2}$/.test(due)) {
          item.due = due
        }
      } else if (field === 'dueTime') {
        if (explicitDueClear) continue
        const rawTime = patch.dueTime === null ? '' : String(patch.dueTime).trim()
        if (rawTime === '') {
          delete item.dueTime
        } else {
          const normalized = normalizeDueTime(rawTime)
          if (normalized !== undefined) {
            item.dueTime = normalized
            if (item.due === undefined) item.due = localDateString()
          }
        }
      } else if (field === 'urgent') {
        if (patch.urgent === true) item.urgent = true
        else delete item.urgent
      } else if (field === 'flagged') {
        if (patch.flagged === true) item.flagged = true
        else delete item.flagged
      } else if (field === 'priority') {
        const priority = Number(patch.priority)
        if (Number.isFinite(priority) && priority > 0) {
          item.priority = Math.min(9, Math.max(1, Math.round(priority)))
        } else {
          delete item.priority
        }
      } else if (field === 'list') {
        const list = typeof patch.list === 'string' ? patch.list.trim() : ''
        if (list !== '') item.list = list
      } else if (field === 'tags') {
        if (patch.tags === null || patch.tags === '') {
          delete item.tags
        } else {
          const tags = normalizeTags(patch.tags)
          if (tags.length > 0) item.tags = tags
          else delete item.tags
        }
      } else if (field === 'url') {
        const url = patch.url === null ? '' : String(patch.url).trim()
        if (url === '') delete item.url
        else item.url = url
      } else if (field === 'repeat') {
        const repeat = patch.repeat === null ? '' : String(patch.repeat).trim().toLowerCase()
        if (repeat === '' || repeat === 'none') delete item.repeat
        else if (REPEAT_VALUES.has(repeat)) item.repeat = repeat
      } else if (field === 'location') {
        const loc = patch.location === null ? '' : String(patch.location).trim()
        if (loc === '') delete item.location
        else item.location = loc
      } else if (field === 'parentId') {
        const pid = patch.parentId === null ? '' : String(patch.parentId).trim()
        if (pid === '' || pid === item.id) delete item.parentId
        else item.parentId = pid
      } else if (field === 'section') {
        const sec = patch.section === null ? '' : String(patch.section).trim()
        if (sec === '') delete item.section
        else item.section = sec
      } else if (field === 'order') {
        if (patch.order === null || patch.order === '') {
          delete item.order
        } else {
          const num = Number(patch.order)
          if (Number.isFinite(num)) item.order = num
        }
      }
    }
  }

  /** Ensure an explicitly targeted or newly created list is tracked in `draft.settings.lists` and un-excluded. */
  function includeListInSettings(draft, listName) {
    if (typeof listName !== 'string' || listName.trim() === '') return
    const target = listName.trim()
    draft.settings = { ...draft.settings }
    const hasStoredLists = Array.isArray(draft.settings.lists) && draft.settings.lists.length > 0
    const current = hasStoredLists ? draft.settings.lists : settings.lists
    if (!current.includes(target) && (hasStoredLists || target !== settings.lists[0])) {
      draft.settings.lists = [...current, target]
    }
    if (Array.isArray(draft.settings.excludedLists)) {
      const nextExcluded = draft.settings.excludedLists.filter((entry) => entry !== target)
      if (nextExcluded.length > 0) draft.settings.excludedLists = nextExcluded
      else delete draft.settings.excludedLists
    }
  }

  /**
   * Run one panel or model operation.
   * @param {object} op - `{op, ...}`.
   * @param {{includeTrash?: boolean}} [viewOptions] - snapshot projection options.
   * @returns {Promise<object>} the state after the operation.
   */
  async function applyOp(op, viewOptions = {}) {
    await ready
    const kind = typeof op.op === 'string' ? op.op : 'list'
    switch (kind) {
      case 'list':
        await store.reloadIfChanged()
        return snapshot(viewOptions)
      case 'add': {
        const text = String(op.text ?? '').trim()
        if (text === '') throw new Error('task text is empty')
        await store.commit((draft) => {
          const activeLists = Array.isArray(draft.settings?.lists) && draft.settings.lists.length > 0
            ? draft.settings.lists
            : settings.lists
          const parent = typeof op.parentId === 'string' && op.parentId.trim() !== ''
            ? draft.items.find((candidate) => candidate.id === op.parentId.trim())
            : undefined
          const fallbackList = parent !== undefined
            ? (typeof parent.list === 'string' && parent.list !== '' ? parent.list : activeLists[0])
            : activeLists[0]
          const explicitList = typeof op.list === 'string' && op.list.trim() !== '' ? op.list.trim() : fallbackList
          const now = Date.now()
          const item = { id: newId(), text, done: false, createdAt: now, list: explicitList }
          if (parent !== undefined && op.section === undefined && parent.section !== undefined) {
            item.section = parent.section
          }
          applyPatch(op, item)
          includeListInSettings(draft, item.list)
          draft.items.push(item)
        })
        schedulePush()
        return snapshot(viewOptions)
      }
      case 'toggle': {
        const id = String(op.id ?? '')
        await store.commit((draft) => {
          const item = draft.items.find((candidate) => candidate.id === id)
          if (item === undefined) return
          const now = Date.now()
          const wasDone = item.done === true
          item.done = !wasDone
          if (item.done) {
            item.doneAt = now
            if (item.repeat !== undefined && REPEAT_VALUES.has(item.repeat)) {
              const nextTask = buildNextRepeatOccurrence(item, now)
              delete item.repeat
              draft.items.push(nextTask)
            }
          } else {
            delete item.doneAt
          }
        })
        schedulePush()
        return snapshot(viewOptions)
      }
      case 'update': {
        const id = String(op.id ?? '')
        const patch = op.patch !== null && typeof op.patch === 'object' ? op.patch : op
        await store.commit((draft) => {
          const item = draft.items.find((candidate) => candidate.id === id)
          if (item === undefined) return
          const wasDone = item.done === true
          applyPatch(patch, item)
          if (typeof patch.list === 'string' && patch.list.trim() !== '') {
            includeListInSettings(draft, item.list)
          }
          if (!wasDone && item.done === true && item.repeat !== undefined && REPEAT_VALUES.has(item.repeat)) {
            const now = Date.now()
            const nextTask = buildNextRepeatOccurrence(item, now)
            delete item.repeat
            draft.items.push(nextTask)
          }
        })
        schedulePush()
        return snapshot(viewOptions)
      }
      case 'reorder': {
        const ids = Array.isArray(op.ids) ? op.ids.map(String) : []
        if (ids.length > 0) {
          await store.commit((draft) => {
            ids.forEach((targetId, index) => {
              const item = draft.items.find((candidate) => candidate.id === targetId)
              if (item !== undefined) item.order = index
            })
          })
        }
        return snapshot(viewOptions)
      }
      case 'remove': {
        const id = String(op.id ?? '')
        const permanent = op.permanent === true
        let touchedReminders = false
        await store.commit((draft) => {
          const now = Date.now()
          const targetSet = new Set([id])
          for (const candidate of draft.items) {
            if (candidate.parentId === id) targetSet.add(candidate.id)
          }
          const remaining = []
          const removedItems = []
          for (const candidate of draft.items) {
            if (targetSet.has(candidate.id)) removedItems.push(candidate)
            else remaining.push(candidate)
          }
          draft.items = remaining
          for (const removed of removedItems) {
            const ownerList = listOf(removed)
            if (removed.reminderId !== undefined) {
              draft.tombstones.push({ reminderId: removed.reminderId, list: ownerList, at: now })
              touchedReminders = true
            }
            if (!permanent) {
              draft.trash.push(toTrashEntry(removed, ownerList, now))
            }
          }
          if (removedItems.length === 0 && permanent) {
            draft.trash = draft.trash.filter((entry) => entry.id !== id && entry.parentId !== id)
          }
          pruneTrash(draft, now)
        })
        if (touchedReminders) schedulePush()
        return snapshot(viewOptions)
      }
      case 'restore': {
        const restoreAll = op.all === true
        const id = String(op.id ?? '')
        let restoredAny = false
        await store.commit((draft) => {
          if (restoreAll) {
            if (draft.trash.length === 0) return
            for (const entry of draft.trash) {
              const copy = { ...entry }
              delete copy.deletedAt
              draft.items.push(copy)
            }
            draft.trash = []
            restoredAny = true
            return
          }
          if (id === '') return
          const targetSet = new Set([id])
          for (const entry of draft.trash) {
            if (entry.parentId === id) targetSet.add(entry.id)
          }
          const keepTrash = []
          const restored = []
          for (const entry of draft.trash) {
            if (targetSet.has(entry.id)) restored.push(entry)
            else keepTrash.push(entry)
          }
          if (restored.length === 0) return
          draft.trash = keepTrash
          const activeIds = new Set([...draft.items.map((x) => x.id), ...restored.map((x) => x.id)])
          for (const entry of restored) {
            const copy = { ...entry }
            delete copy.deletedAt
            if (copy.parentId !== undefined && !activeIds.has(copy.parentId)) {
              delete copy.parentId
            }
            draft.items.push(copy)
          }
          restoredAny = true
        })
        if (restoredAny) schedulePush()
        return snapshot(viewOptions)
      }
      case 'destroy': {
        const id = String(op.id ?? '')
        if (id !== '') {
          await store.commit((draft) => {
            draft.trash = draft.trash.filter((entry) => entry.id !== id && entry.parentId !== id)
          })
        }
        return snapshot(viewOptions)
      }
      case 'empty_trash': {
        await store.commit((draft) => {
          draft.trash = []
        })
        return snapshot(viewOptions)
      }
      case 'clear_done': {
        const scopeList = typeof op.list === 'string' && op.list.trim() !== '' ? op.list.trim() : null
        const permanent = op.permanent === true
        await store.commit((draft) => {
          const now = Date.now()
          const keep = []
          for (const item of draft.items) {
            const itemList = listOf(item)
            const matchesScope = scopeList === null || itemList === scopeList
            if (item.done && matchesScope) {
              if (item.reminderId !== undefined) {
                draft.tombstones.push({ reminderId: item.reminderId, list: itemList, at: now })
              }
              if (!permanent) draft.trash.push(toTrashEntry(item, itemList, now))
            } else {
              keep.push(item)
            }
          }
          draft.items = keep
          pruneTrash(draft, now)
        })
        schedulePush()
        return snapshot(viewOptions)
      }
      case 'migrate': {
        const incoming = Array.isArray(op.items) ? op.items : []
        if (incoming.length === 0) return snapshot(viewOptions)
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
            if (raw !== null && typeof raw === 'object') applyPatch(raw, item)
            draft.items.push(item)
          }
        })
        schedulePush()
        return snapshot(viewOptions)
      }
      case 'lists':
        await store.reloadIfChanged()
        await refreshAvailableLists()
        return snapshot(viewOptions)
      case 'select': {
        const wanted = Array.isArray(op.lists)
          ? [...new Set(op.lists
            .filter((name) => typeof name === 'string' && name.trim() !== '')
            .map((name) => name.trim()))]
          : []
        if (settings.reminders && availableLists === null) {
          await refreshAvailableLists()
        }
        await store.commit((draft) => {
          const currentChosen = Array.isArray(draft.settings?.lists) && draft.settings.lists.length > 0
            ? draft.settings.lists
            : settings.lists
          const knownPool = [...new Set([
            ...(availableLists ?? []),
            ...currentChosen,
            ...(Array.isArray(draft.settings?.excludedLists) ? draft.settings.excludedLists : []),
          ])]
          const effectiveWanted = wanted.length > 0 ? wanted : settings.lists
          const excludedLists = knownPool.filter((name) => !effectiveWanted.includes(name))
          draft.settings = { ...draft.settings }
          if (wanted.length === 0) delete draft.settings.lists
          else draft.settings.lists = wanted
          if (excludedLists.length > 0) draft.settings.excludedLists = excludedLists
          else delete draft.settings.excludedLists
        })
        await refreshAvailableLists()
        schedulePush()
        if (settings.reminders) void mergeNow(true)
        return snapshot(viewOptions)
      }
      case 'create_list': {
        const name = String(op.name ?? op.list ?? '').trim()
        if (name === '') throw new Error('list name is empty')
        const color = typeof op.color === 'string' && op.color.trim() !== '' ? op.color.trim() : undefined
        const icon = typeof op.icon === 'string' && op.icon.trim() !== '' ? op.icon.trim() : undefined
        const pinned = op.pinned === true
        const sections = Array.isArray(op.sections)
          ? [...new Set(op.sections.filter((s) => typeof s === 'string' && s.trim() !== '').map((s) => s.trim()))]
          : undefined
        await store.commit((draft) => {
          const current = Array.isArray(draft.settings.lists) && draft.settings.lists.length > 0
            ? draft.settings.lists
            : settings.lists
          draft.settings.lists = [...new Set([...current, name])]
          if (Array.isArray(draft.settings.excludedLists)) {
            const nextExcluded = draft.settings.excludedLists.filter((entry) => entry !== name)
            if (nextExcluded.length > 0) draft.settings.excludedLists = nextExcluded
            else delete draft.settings.excludedLists
          }
          draft.settings.listMeta = { ...(draft.settings.listMeta ?? {}) }
          const meta = { ...(draft.settings.listMeta[name] ?? {}) }
          if (color !== undefined) meta.color = color
          if (icon !== undefined) meta.icon = icon
          if (pinned) meta.pinned = true
          if (sections !== undefined && sections.length > 0) meta.sections = sections
          draft.settings.listMeta[name] = meta
        })
        if (Array.isArray(availableLists) && !availableLists.includes(name)) {
          availableLists = [...availableLists, name]
        }
        if (color !== undefined) colourByName = { ...(colourByName ?? {}), [name]: color }
        if (icon !== undefined) emblemByName = { ...(emblemByName ?? {}), [name]: icon }
        if (settings.reminders) {
          await mirror.createList(name, { color, emblem: icon }).catch((error) => {
            log.warn?.(`dsh-apple-reminders: createList("${name}") failed: ${messageOf(error)}`)
          })
        }
        return snapshot(viewOptions)
      }
      case 'update_list': {
        const name = String(op.name ?? op.list ?? '').trim()
        if (name === '') throw new Error('list name is empty')
        const nextName = typeof op.newName === 'string' && op.newName.trim() !== '' ? op.newName.trim() : name
        const renamed = nextName !== name
        await store.commit((draft) => {
          const current = Array.isArray(draft.settings.lists) && draft.settings.lists.length > 0
            ? [...draft.settings.lists]
            : [...settings.lists]
          const defaultBefore = current[0]
          if (renamed) {
            const updatedLists = current.map((entry) => (entry === name ? nextName : entry))
            if (!updatedLists.includes(nextName)) updatedLists.push(nextName)
            draft.settings.lists = [...new Set(updatedLists)]
            if (Array.isArray(draft.settings.excludedLists)) {
              const nextExcluded = draft.settings.excludedLists.filter((entry) => entry !== nextName)
              if (nextExcluded.length > 0) draft.settings.excludedLists = nextExcluded
              else delete draft.settings.excludedLists
            }
            for (const item of draft.items) {
              const eff = typeof item.list === 'string' && item.list !== '' ? item.list : defaultBefore
              if (eff === name) {
                item.list = nextName
                if (item.synced !== undefined && (item.synced.list === name || item.synced.list === undefined)) {
                  item.synced.list = nextName
                }
              }
            }
            for (const item of draft.trash) {
              if (item.list === name) item.list = nextName
            }
          }
          draft.settings.listMeta = { ...(draft.settings.listMeta ?? {}) }
          const meta = { ...(draft.settings.listMeta[name] ?? draft.settings.listMeta[nextName] ?? {}) }
          if (renamed) delete draft.settings.listMeta[name]

          if (op.color !== undefined) {
            const c = op.color === null ? '' : String(op.color).trim()
            if (c === '') delete meta.color
            else meta.color = c
          }
          if (op.icon !== undefined) {
            const ic = op.icon === null ? '' : String(op.icon).trim()
            if (ic === '') delete meta.icon
            else meta.icon = ic
          }
          if (op.pinned !== undefined) {
            if (op.pinned === true) meta.pinned = true
            else delete meta.pinned
          }
          let sections = Array.isArray(meta.sections) ? [...meta.sections] : []
          if (Array.isArray(op.sections)) {
            sections = [...new Set(
              op.sections.filter((s) => typeof s === 'string' && s.trim() !== '').map((s) => s.trim()),
            )]
          }
          if (typeof op.addSection === 'string' && op.addSection.trim() !== '') {
            const sec = op.addSection.trim()
            if (!sections.includes(sec)) sections.push(sec)
          }
          if (typeof op.removeSection === 'string' && op.removeSection.trim() !== '') {
            const remSec = op.removeSection.trim()
            sections = sections.filter((s) => s !== remSec)
            for (const item of draft.items) {
              const eff = typeof item.list === 'string' && item.list !== '' ? item.list : draft.settings.lists?.[0] ?? settings.lists[0]
              if (eff === nextName && item.section === remSec) delete item.section
            }
          }
          if (op.renameSection !== null && typeof op.renameSection === 'object') {
            const fromSec = String(op.renameSection.from ?? '').trim()
            const toSec = String(op.renameSection.to ?? '').trim()
            if (fromSec !== '' && toSec !== '') {
              sections = [...new Set(sections.map((s) => (s === fromSec ? toSec : s)))]
              for (const item of draft.items) {
                const eff = typeof item.list === 'string' && item.list !== '' ? item.list : draft.settings.lists?.[0] ?? settings.lists[0]
                if (eff === nextName && item.section === fromSec) item.section = toSec
              }
            }
          }
          if (sections.length > 0) meta.sections = sections
          else delete meta.sections

          draft.settings.listMeta[nextName] = meta
        })
        if (renamed && Array.isArray(availableLists)) {
          availableLists = [...new Set(availableLists.map((entry) => (entry === name ? nextName : entry)))]
        }
        if (colourByName !== null) {
          if (renamed && colourByName[name] !== undefined) {
            colourByName[nextName] = colourByName[name]
            delete colourByName[name]
          }
          if (typeof op.color === 'string' && op.color.trim() !== '') colourByName[nextName] = op.color.trim()
        }
        if (settings.reminders && (renamed || op.color !== undefined || op.icon !== undefined)) {
          await mirror.updateListMirror(name, {
            newName: renamed ? nextName : undefined,
            color: typeof op.color === 'string' ? op.color : undefined,
            emblem: typeof op.icon === 'string' ? op.icon : undefined,
          }).catch((error) => {
            log.warn?.(`dsh-apple-reminders: updateListMirror("${name}") failed: ${messageOf(error)}`)
          })
        }
        return snapshot(viewOptions)
      }
      case 'delete_list': {
        const name = String(op.name ?? op.list ?? '').trim()
        if (name === '') throw new Error('list name is empty')
        const deleteInReminders = op.deleteReminders === true
        let queuedTombstones = false
        await store.commit((draft) => {
          const now = Date.now()
          const current = Array.isArray(draft.settings.lists) && draft.settings.lists.length > 0
            ? [...draft.settings.lists]
            : [...settings.lists]
          const defaultBefore = current[0]
          const remainingLists = current.filter((entry) => entry !== name)
          const fallback = remainingLists[0] ?? (settings.lists[0] !== name ? settings.lists[0] : DEFAULT_LIST_NAME)
          draft.settings.lists = remainingLists.length > 0 ? remainingLists : [fallback]
          const prevExcluded = Array.isArray(draft.settings.excludedLists) ? draft.settings.excludedLists : []
          const nextExcluded = deleteInReminders
            ? prevExcluded.filter((entry) => entry !== name)
            : [...new Set([...prevExcluded, name])]
          if (nextExcluded.length > 0) draft.settings.excludedLists = nextExcluded
          else delete draft.settings.excludedLists
          if (draft.settings.listMeta !== undefined) {
            delete draft.settings.listMeta[name]
            if (Object.keys(draft.settings.listMeta).length === 0) delete draft.settings.listMeta
          }
          const keepItems = []
          for (const item of draft.items) {
            const eff = typeof item.list === 'string' && item.list !== '' ? item.list : defaultBefore
            if (eff === name) {
              if (!deleteInReminders && item.reminderId !== undefined) {
                draft.tombstones.push({ reminderId: item.reminderId, list: name, at: now })
                queuedTombstones = true
              }
              draft.trash.push(toTrashEntry(item, fallback, now))
            } else {
              keepItems.push(item)
            }
          }
          draft.items = keepItems
          pruneTrash(draft, now)
        })
        if (Array.isArray(availableLists) && deleteInReminders) {
          availableLists = availableLists.filter((entry) => entry !== name)
        }
        if (settings.reminders && deleteInReminders) {
          await mirror.deleteList(name).catch((error) => {
            log.warn?.(`dsh-apple-reminders: deleteList("${name}") failed: ${messageOf(error)}`)
          })
        } else if (queuedTombstones) {
          schedulePush()
        }
        return snapshot(viewOptions)
      }
      case 'sync':
        await mergeNow(true)
        return snapshot(viewOptions)
      default:
        throw new Error(`unknown operation "${kind}"`)
    }
  }

  // The list is model-facing: one tool, one flat schema, no approval bypass.
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => toolCtx.tools.register({
      name: TOOL_NAME,
      description: [
        'The user\'s personal to-do list (Apple Reminders parity), shown in the right sidebar of the app.',
        'ops: list (default), add, toggle, update, remove, restore, destroy, empty_trash, clear_done, create_list, update_list, delete_list, sync.',
        'add/update support text, list, due (YYYY-MM-DD), dueTime (HH:MM 24h), notes, urgent, flagged, priority (0 none, 1 high, 5 medium, 9 low), tags, url, repeat (daily|weekdays|weekly|biweekly|monthly|yearly), location, parentId, section, order, done.',
        'remove soft-deletes into Recently Deleted (30-day retention) unless permanent: true; restore recovers from trash.',
        'The lists are kept in two-way sync with Apple Reminders, so edits made there appear here too.',
        'Complete or remove a task only when the user asks.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          op: {
            type: 'string',
            enum: [
              'list',
              'add',
              'toggle',
              'update',
              'remove',
              'restore',
              'destroy',
              'empty_trash',
              'clear_done',
              'create_list',
              'update_list',
              'delete_list',
              'sync',
            ],
          },
          id: { type: 'string', description: 'Task id; required by toggle, update, remove, destroy, and single-item restore.' },
          text: { type: 'string', description: 'Task title for add, or replacement title for update.' },
          list: { type: 'string', description: 'Target list name; defaults to the primary configured list.' },
          name: { type: 'string', description: 'List name for create_list, update_list, or delete_list.' },
          newName: { type: 'string', description: 'Replacement list name for update_list.' },
          color: { type: 'string', description: 'List colour (hex or Apple colour name) for create_list or update_list.' },
          icon: { type: 'string', description: 'List icon/emoji for create_list or update_list.' },
          pinned: { type: 'boolean', description: 'Whether the list is pinned to the top smart grid.' },
          sections: { type: 'array', items: { type: 'string' }, description: 'Ordered section names inside a list.' },
          due: { type: 'string', description: 'Due date as YYYY-MM-DD, or empty string to clear.' },
          dueTime: { type: 'string', description: 'Due time as 24h HH:MM (e.g. 09:00, 15:00, 20:00), or empty string to clear.' },
          notes: { type: 'string', description: 'Free-form notes; empty string clears them.' },
          urgent: { type: 'boolean', description: 'Whether the task is marked urgent (alarm).' },
          flagged: { type: 'boolean', description: 'Whether the task is flagged.' },
          priority: { type: 'number', description: 'Priority matching Apple Reminders: 0 none, 1 high, 5 medium, 9 low.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tag names without leading #.' },
          url: { type: 'string', description: 'Optional associated URL; empty string clears it.' },
          repeat: {
            type: 'string',
            enum: ['daily', 'weekdays', 'weekly', 'biweekly', 'monthly', 'yearly', 'none', ''],
            description: 'Recurrence rule; completing a repeating task spawns the next occurrence.',
          },
          location: { type: 'string', description: 'Location label (e.g. Arriving Home); empty string clears it.' },
          parentId: { type: 'string', description: 'Parent task id for subtasks; empty string outdents.' },
          section: { type: 'string', description: 'Section name within the list; empty string clears it.' },
          order: { type: 'number', description: 'Manual sort order number within a list or section.' },
          done: { type: 'boolean', description: 'Completion state for update.' },
          all: { type: 'boolean', description: 'When true with restore, recovers all items from Recently Deleted.' },
          permanent: { type: 'boolean', description: 'When true with remove or clear_done, skips Recently Deleted.' },
          deleteReminders: { type: 'boolean', description: 'When true with delete_list, also deletes the list in Apple Reminders.' },
          includeTrash: { type: 'boolean', description: 'Include soft-deleted Recently Deleted items in the returned snapshot.' },
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
                properties: { ...TASK_ITEM_PROPERTIES },
                required: ['id', 'text', 'done', 'list'],
                additionalProperties: false,
              },
            },
            trash: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  ...TASK_ITEM_PROPERTIES,
                  deletedAt: { type: 'number' },
                },
                required: ['id', 'text', 'done', 'list', 'deletedAt'],
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
                listColors: { type: 'array', items: { type: 'string' } },
                listMeta: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      color: { type: 'string' },
                      icon: { type: 'string' },
                      pinned: { type: 'boolean' },
                      sections: { type: 'array', items: { type: 'string' } },
                    },
                    required: ['name'],
                    additionalProperties: false,
                  },
                },
                available: { type: 'array', items: { type: 'string' } },
                availableColors: { type: 'array', items: { type: 'string' } },
                availableLists: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      color: { type: 'string' },
                      icon: { type: 'string' },
                    },
                    required: ['name'],
                    additionalProperties: false,
                  },
                },
                trashCount: { type: 'number' },
                lastSyncAt: { type: 'number' },
                error: { type: 'string' },
              },
              required: ['enabled', 'status', 'listName', 'lists', 'listColors', 'listMeta', 'trashCount'],
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
      execute: async (args) => {
        const req = args ?? { op: 'list' }
        const includeTrash = req.includeTrash === true || ['restore', 'destroy', 'empty_trash'].includes(req.op)
        return applyOp(req, { includeTrash })
      },
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
  // every tick; notes, due, dueTime, flag and priority every Nth tick because
  // reading them costs an Apple event per task.
  if (settings.reminders) {
    interval = setInterval(() => {
      if (panels.size === 0) return
      ticks += 1
      void mergeNow(ticks % DETAIL_EVERY === 0)
    }, settings.syncIntervalMs)
    interval.unref?.()
  }

  ctx.effect(() => () => {
    disposed = true
    if (debounce !== null) clearTimeout(debounce)
    if (watchDebounce !== null) clearTimeout(watchDebounce)
    if (interval !== null) clearInterval(interval)
    if (fileWatcher !== null) {
      try {
        fileWatcher.close()
      } catch {}
      fileWatcher = null
    }
    panels.clear()
  }, 'dsh-apple-reminders: timers')
}

/**
 * Render the list as terse text for the transcript.
 * @param {{rev: number, items: object[], trash?: object[], sync: object}} value - tool result.
 * @returns {string} the lines the user reads.
 */
function renderList(value) {
  const items = Array.isArray(value?.items) ? value.items : []
  const trashCount = Number.isFinite(value?.sync?.trashCount)
    ? value.sync.trashCount
    : (Array.isArray(value?.trash) ? value.trash.length : 0)
  const open = items.filter((item) => !item.done).length
  if (items.length === 0) {
    return trashCount > 0 ? `待办清单是空的。（最近删除 ${trashCount} 项）` : '待办清单是空的。'
  }
  const lines = items.map((item) => {
    const marks = []
    if (item.urgent === true) marks.push('⏰紧急')
    if (item.flagged === true) marks.push('⚑')
    if (typeof item.due === 'string') {
      marks.push(`截止 ${item.due}${typeof item.dueTime === 'string' ? ` ${item.dueTime}` : ''}`)
    }
    if (typeof item.repeat === 'string') marks.push(`重复:${item.repeat}`)
    if (typeof item.priority === 'number') marks.push(`优先级 ${item.priority}`)
    if (Array.isArray(item.tags) && item.tags.length > 0) marks.push(item.tags.map((t) => `#${t}`).join(' '))
    if (typeof item.location === 'string') marks.push(`📍${item.location}`)
    if (typeof item.section === 'string') marks.push(`分组:${item.section}`)
    if (typeof item.list === 'string') marks.push(item.list)
    const indent = typeof item.parentId === 'string' ? '  ↳ ' : ''
    const tail = marks.length > 0 ? `  （${marks.join(' · ')}）` : ''
    return `${indent}${item.done ? '[x]' : '[ ]'} ${item.text}${tail}`
  })
  const trashSuffix = trashCount > 0 ? ` · 最近删除 ${trashCount} 项` : ''
  const head = `待办 · ${items.length} 项（${open} 未完成）${trashSuffix}`
  const STATUS = { idle: '已同步', syncing: '同步中', error: '同步失败', off: '未启用' }
  const lists = Array.isArray(value?.sync?.lists) ? value.sync.lists.join('、') : ''
  const mirror = value?.sync?.enabled === true
    ? `镜像：${lists} · ${STATUS[value.sync.status] ?? value.sync.status}${value.sync.error === undefined ? '' : ` · ${value.sync.error}`}`
    : '镜像：未启用'
  return [head, ...lines, mirror].join('\n')
}
