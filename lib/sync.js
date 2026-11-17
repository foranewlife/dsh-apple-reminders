/**
 * The plans that keep the DSH list and its Apple Reminders lists together.
 *
 * Both are pure: they read snapshots and say what to do, so every case is
 * testable without Reminders.app. The Host executes them.
 *
 * Each task carries `synced` — what the plugin last told Reminders about it.
 * Comparing three values per field (baseline, here, there) tells "edited in
 * DSH" from "edited on the phone", which is what makes a two-way merge
 * possible:
 *
 * - Only one side changed → that side is the new truth, on both sides.
 * - Both changed → DSH wins (the user asked for DSH to be authoritative).
 * - A reminder vanished → the task was deleted on the phone, so it goes here.
 * - A whole list vanished → rebuild it instead of deleting every task.
 *
 * Field values use `undefined` for "not set"; {@link toMirror} turns that into
 * the concrete value Reminders needs when writing.
 */

/** Completed tasks stay mirrored this long, so the phone keeps a short history. */
export const PRUNE_MS = 30 * 24 * 60 * 60 * 1000
/** A reminder created this recently may not be indexed yet; never call it deleted. */
export const RACE_MS = 60 * 1000
/** Every merged field. */
export const FIELDS = ['text', 'done', 'notes', 'due', 'flagged', 'priority']
/** What a cheap poll compares; the rest needs the detailed read. */
export const CHEAP_FIELDS = ['text', 'done']

/**
 * @param {object} item - DSH task.
 * @param {number} now - clock.
 * @param {number} pruneMs - how long a completed task stays mirrored.
 * @returns {boolean} whether to create a reminder for it.
 */
function belongsInMirror(item, now, pruneMs) {
  if (!item.done) return true
  return Number.isFinite(item.doneAt) && now - item.doneAt <= pruneMs
}

/** @param {unknown} value - any field value. @returns {unknown} undefined when unset. */
function clean(value) {
  if (value === null || value === '' || value === false || value === 0) return undefined
  return value
}

/**
 * @param {object} item - DSH task.
 * @returns {object} its fields, unset values removed.
 */
export function fromItem(item) {
  return {
    text: item.text,
    done: item.done === true,
    notes: clean(item.notes),
    due: clean(item.due),
    flagged: item.flagged === true ? true : undefined,
    priority: clean(item.priority),
  }
}

/**
 * @param {object} entry - one mirror reminder.
 * @returns {object} its fields, unset values removed.
 */
export function fromMirror(entry) {
  return {
    text: entry.name,
    done: entry.completed === true,
    notes: clean(entry.notes),
    due: clean(entry.due),
    flagged: entry.flagged === true ? true : undefined,
    priority: clean(entry.priority),
  }
}

/**
 * Turn a planned value into what Reminders should store.
 * @param {string} field - field name.
 * @param {unknown} value - planned value, possibly undefined.
 * @returns {unknown} the concrete write value.
 */
export function toMirror(field, value) {
  if (field === 'notes') return typeof value === 'string' ? value : ''
  if (field === 'due') return typeof value === 'string' ? value : null
  if (field === 'flagged') return value === true
  if (field === 'priority') return typeof value === 'number' ? value : 0
  if (field === 'done') return value === true
  return value
}

/**
 * Compare one field on both sides against its baseline.
 * @param {string} field - field name.
 * @param {unknown} base - last synced value.
 * @param {unknown} here - DSH value.
 * @param {unknown} there - mirror value.
 * @returns {{push?: unknown, pull?: unknown}} at most one direction.
 */
function mergeField(field, base, here, there) {
  if (base === undefined) {
    // No baseline yet (a document from before this field existed). Text stays
    // as DSH wrote it; a completion or flag on either side is kept; anything
    // else comes from the mirror, the only side that had the field.
    if (field === 'text') return here !== there ? { push: here } : {}
    if (field === 'done' || field === 'flagged') {
      if (here === there) return {}
      // Whichever side has it set wins; DSH setting it is a push.
      return here === true ? { push: here } : { pull: there }
    }
    return here === there ? {} : { pull: there }
  }
  const hereChanged = here !== base
  const thereChanged = there !== base
  if (!hereChanged && !thereChanged) return {}
  if (hereChanged && !thereChanged) return { push: here }
  if (!hereChanged && thereChanged) return { pull: there }
  if (here === there) return {}
  return { push: here }
}

/**
 * What one local edit needs: pushes only, so no mirror read is on the critical path.
 * @param {object[]} items - DSH tasks.
 * @param {{now?: number, pruneMs?: number, fields?: string[], listOf?: (item: object) => string}} [options] - clock, pruning age, fields, list resolver.
 * @returns {{create: object[], update: object[], prune: object[], move: object[]}} the pending work.
 */
export function planPush(items, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const pruneMs = Number.isFinite(options.pruneMs) ? options.pruneMs : PRUNE_MS
  const fields = options.fields ?? FIELDS
  const listOf = options.listOf ?? (() => '')
  const create = []
  const update = []
  const prune = []
  const move = []

  for (const item of items) {
    const list = listOf(item)
    if (typeof item.reminderId !== 'string' || item.reminderId === '') {
      if (belongsInMirror(item, now, pruneMs)) create.push({ itemId: item.id, list, task: fromItem(item) })
      continue
    }
    if (item.done && Number.isFinite(item.doneAt) && now - item.doneAt > pruneMs) {
      prune.push({ itemId: item.id, list, reminderId: item.reminderId })
      continue
    }
    if (item.synced === undefined) continue
    const here = fromItem(item)
    const patch = {}
    for (const field of fields) {
      if (here[field] === item.synced[field]) continue
      patch[field] = here[field]
    }
    if (Object.keys(patch).length > 0) update.push({ itemId: item.id, list, reminderId: item.reminderId, patch })
    const baseList = item.synced.list ?? list
    if (list !== baseList) move.push({ itemId: item.id, reminderId: item.reminderId, from: baseList, to: list })
  }

  return { create, update, prune, move }
}

/**
 * What a full round needs: everything {@link planPush} would do, plus what the
 * mirror changed on its own.
 * @param {object[]} items - DSH tasks.
 * @param {{name: string, exists: boolean, items: object[]}[]} lists - Reminders snapshots.
 * @param {{reminderId: string, at: number}[]} [tombstones] - reminders this plugin deleted.
 * @param {{now?: number, pruneMs?: number, raceMs?: number, fields?: string[], listOf?: (item: object) => string}} [options] - clock, pruning age, race window, fields, list resolver.
 * @returns {{create: object[], update: object[], move: object[], pull: object[], adopt: object[], dropItems: object[], importItems: object[], dropReminders: object[], prune: object[], fields: string[]}} the pass.
 */
export function planMerge(items, lists, tombstones = [], options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const pruneMs = Number.isFinite(options.pruneMs) ? options.pruneMs : PRUNE_MS
  const raceMs = Number.isFinite(options.raceMs) ? options.raceMs : RACE_MS
  const fields = options.fields ?? FIELDS
  const listOf = options.listOf ?? (() => '')
  const blocked = new Set(tombstones.map((entry) => entry.reminderId))

  const listByName = new Map(lists.map((list) => [list.name, list]))
  const entries = new Map()
  for (const list of lists) {
    for (const entry of list.items) entries.set(entry.id, { ...fromMirror(entry), list: list.name, id: entry.id })
  }
  const byReminder = new Map()
  for (const item of items) {
    if (typeof item.reminderId === 'string' && item.reminderId !== '') byReminder.set(item.reminderId, item)
  }

  const updates = new Map()
  const create = []
  const moves = []
  const pull = []
  const adopt = []
  const dropItems = []
  const importItems = []
  const dropReminders = []
  const prune = []

  /** Merge one field into the single mirror write planned for this task. */
  const push = (item, field, value) => {
    const key = item.id
    const existing = updates.get(key)
    if (existing === undefined) {
      updates.set(key, { itemId: key, list: listOf(item), reminderId: item.reminderId, patch: { [field]: value } })
      return
    }
    existing.patch[field] = value
  }

  // A reminder nobody here knows about was added on the phone.
  for (const reminder of entries.values()) {
    if (byReminder.has(reminder.id)) continue
    if (blocked.has(reminder.id)) {
      dropReminders.push({ list: reminder.list, reminderId: reminder.id })
      continue
    }
    if (reminder.text.trim() === '') continue
    importItems.push({ list: reminder.list, reminderId: reminder.id, task: reminder })
  }

  for (const item of items) {
    const list = listOf(item)
    if (typeof item.reminderId !== 'string' || item.reminderId === '') {
      if (belongsInMirror(item, now, pruneMs)) create.push({ itemId: item.id, list, task: fromItem(item) })
      continue
    }
    if (item.done && Number.isFinite(item.doneAt) && now - item.doneAt > pruneMs) {
      prune.push({ itemId: item.id, list, reminderId: item.reminderId })
      continue
    }
    const reminder = entries.get(item.reminderId)
    if (reminder === undefined) {
      const known = listByName.get(list)
      if (known !== undefined && !known.exists) {
        // The list itself is gone: rebuild it rather than delete the list here.
        if (belongsInMirror(item, now, pruneMs)) create.push({ itemId: item.id, list, task: fromItem(item) })
      } else if (!(Number.isFinite(item.pushedAt) && now - item.pushedAt < raceMs)) {
        // Indexed long ago and gone now: deleted on the phone.
        dropItems.push({ itemId: item.id, list, reminderId: item.reminderId })
      }
      continue
    }

    const here = fromItem(item)
    const base = item.synced ?? {}
    const patch = {}
    const pulled = {}
    let pushing = false
    let pulling = false
    for (const field of fields) {
      const result = mergeField(field, base[field], here[field], reminder[field])
      if ('push' in result) {
        patch[field] = result.push
        pushing = true
      } else if ('pull' in result) {
        pulled[field] = result.pull
        pulling = true
      }
    }
    if (pushing) updates.set(item.id, { itemId: item.id, list, reminderId: item.reminderId, patch })

    // The owning list is a container, not a property: a change is a move.
    const baseList = base.list ?? list
    if (list !== baseList && reminder.list === baseList) {
      moves.push({ itemId: item.id, reminderId: item.reminderId, from: reminder.list, to: list })
    } else if (reminder.list !== baseList && list === baseList) {
      pulled.list = reminder.list
      pulling = true
    } else if (list !== reminder.list) {
      moves.push({ itemId: item.id, reminderId: item.reminderId, from: reminder.list, to: list })
    }

    if (pulling) pull.push({ itemId: item.id, fields: pulled })
    if (item.synced === undefined) {
      const converged = {}
      for (const field of fields) {
        if (field in patch) converged[field] = patch[field]
        else if (field in pulled) converged[field] = pulled[field]
        else converged[field] = here[field]
      }
      adopt.push({ itemId: item.id, fields: converged })
    }
  }

  return {
    create,
    update: [...updates.values()],
    pull,
    adopt,
    move: moves,
    dropItems,
    importItems,
    dropReminders,
    prune,
    fields,
  }
}
