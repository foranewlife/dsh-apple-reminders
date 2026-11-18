/**
 * The to-do list itself: one JSON document in the DSH home directory, read and
 * written only by the Host half of this plugin.
 *
 * Every write goes through one serialized chain, so a burst of clicks cannot
 * interleave two read-modify-write cycles, and the replacement is atomic.
 *
 * Each task may carry `synced`: what this plugin last told Apple Reminders about
 * it. That baseline is what makes a two-way merge possible — with it, "the user
 * edited this here" and "the user edited this there" are different facts.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** On-disk format; 2 added per-item `synced` baselines and `tombstones`. */
const VERSION = 4
/** A tombstone only has to outlive one failed AppleScript call. */
const TOMBSTONE_MS = 7 * 24 * 60 * 60 * 1000
/** Soft-deleted tasks stay in Recently Deleted (`trash`) for 30 days. */
export const TRASH_MS = 30 * 24 * 60 * 60 * 1000
/** Supported recurrence cycles for repeating tasks. */
export const REPEAT_VALUES = new Set(['daily', 'weekdays', 'weekly', 'biweekly', 'monthly', 'yearly'])

const SYNCED_OPTIONAL_FIELDS = ['notes', 'due', 'dueTime', 'urgent', 'flagged', 'priority', 'list']

/**
 * Resolve the DSH home the same way the rest of the app does.
 * @returns {string} absolute home directory.
 */
export function dshHome() {
  const explicit = process.env.DSH_HOME
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
  return join(homedir(), '.dsh')
}

/**
 * @returns {string} absolute path of the list document.
 */
export function defaultFilePath(dirName = 'dsh-apple-reminders') {
  return join(dshHome(), dirName, 'todos.json')
}

/** Where the plugin kept its list before it was renamed. */
export function legacyFilePath() {
  return defaultFilePath('dsh-todo')
}

/**
 * @returns {{version: number, rev: number, items: object[], trash: object[], tombstones: object[], settings: object}} an empty list.
 */
export function emptyState() {
  return { version: VERSION, rev: 0, items: [], trash: [], tombstones: [], settings: {} }
}

/**
 * @returns {string} a list-local id; nothing else reads it.
 */
export function newId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Format a timestamp as local `YYYY-MM-DD`.
 * @param {number} [ms] - epoch milliseconds.
 * @returns {string} local date string.
 */
export function localDateString(ms = Date.now()) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * Normalize a 24-hour local time string (`HH:MM`).
 * @param {unknown} raw - candidate time value.
 * @returns {string|undefined} normalized `HH:MM`, or undefined when invalid/empty.
 */
export function normalizeDueTime(raw) {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  const match = /^(\d{1,2}):([0-5]\d)$/.exec(trimmed)
  if (match === null) return undefined
  const hour = Number(match[1])
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return undefined
  return `${String(hour).padStart(2, '0')}:${match[2]}`
}

/**
 * Normalize tag names: trimmed, leading `#` stripped, lowercased, unique.
 * @param {unknown} raw - array of strings or comma/space-separated string.
 * @returns {string[]} clean tag list.
 */
export function normalizeTags(raw) {
  const parts = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/[\s,，]+/)
      : []
  const seen = new Set()
  const out = []
  for (const entry of parts) {
    if (typeof entry !== 'string') continue
    const cleaned = entry.replace(/^#+/, '').trim().toLowerCase()
    if (cleaned === '' || seen.has(cleaned)) continue
    seen.add(cleaned)
    out.push(cleaned)
  }
  return out
}

/**
 * Extract inline `#tag` tokens from free-form text or notes without mutating the source text.
 * @param {...unknown} texts - candidate strings.
 * @returns {string[]} normalized unique tags.
 */
export function extractInlineTags(...texts) {
  const found = []
  const pattern = /(?:^|[\s,，;；])#([\p{L}\p{N}_-]+)/gu
  for (const text of texts) {
    if (typeof text !== 'string' || !text.includes('#')) continue
    for (const match of text.matchAll(pattern)) {
      found.push(match[1])
    }
  }
  return normalizeTags(found)
}

/**
 * Compute the next `YYYY-MM-DD` occurrence for a repeating task.
 * @param {string|undefined} due - current `YYYY-MM-DD`, or undefined to step from today.
 * @param {string} repeat - one of {@link REPEAT_VALUES}.
 * @param {number} [now] - reference clock when `due` is missing.
 * @returns {string} the advanced `YYYY-MM-DD`.
 */
export function nextDueDate(due, repeat, now = Date.now()) {
  const baseStr = typeof due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(due)
    ? due
    : localDateString(now)
  const [year, month, day] = baseStr.split('-').map(Number)
  const pad = (n) => String(n).padStart(2, '0')
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

  if (repeat === 'monthly') {
    const targetMonthIndex = month // 1-based `month` equals 0-based `monthIndex + 1`
    const targetYear = year + Math.floor(targetMonthIndex / 12)
    const modMonth = ((targetMonthIndex % 12) + 12) % 12
    const maxDay = new Date(targetYear, modMonth + 1, 0).getDate()
    return fmt(new Date(targetYear, modMonth, Math.min(day, maxDay), 12, 0, 0))
  }
  if (repeat === 'yearly') {
    const targetYear = year + 1
    const maxDay = new Date(targetYear, month, 0).getDate()
    return fmt(new Date(targetYear, month - 1, Math.min(day, maxDay), 12, 0, 0))
  }

  const cursor = new Date(year, month - 1, day, 12, 0, 0)
  if (repeat === 'weekdays') {
    cursor.setDate(cursor.getDate() + 1)
    while (cursor.getDay() === 0 || cursor.getDay() === 6) {
      cursor.setDate(cursor.getDate() + 1)
    }
    return fmt(cursor)
  }
  if (repeat === 'weekly') {
    cursor.setDate(cursor.getDate() + 7)
    return fmt(cursor)
  }
  if (repeat === 'biweekly') {
    cursor.setDate(cursor.getDate() + 14)
    return fmt(cursor)
  }
  // Default / 'daily'
  cursor.setDate(cursor.getDate() + 1)
  return fmt(cursor)
}

/**
 * Accept only well-formed tasks, so a hand-edited file cannot crash the panel.
 * @param {unknown} raw - one stored entry.
 * @returns {object|null} the normalized task, or null when it is unusable.
 */
export function normalizeItem(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const text = typeof raw.text === 'string' ? raw.text.trim() : ''
  if (text === '') return null
  const item = {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : newId(),
    text,
    done: raw.done === true,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
  }
  if (item.done) {
    // A task completed before this field existed is assumed completed when it
    // was created, so the mirror can still decide whether it is recent.
    item.doneAt = Number.isFinite(raw.doneAt) ? raw.doneAt : item.createdAt
  }
  if (typeof raw.reminderId === 'string' && raw.reminderId !== '') item.reminderId = raw.reminderId
  if (Number.isFinite(raw.pushedAt)) item.pushedAt = raw.pushedAt
  if (typeof raw.notes === 'string' && raw.notes.trim() !== '') item.notes = raw.notes
  if (typeof raw.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.due)) item.due = raw.due
  const dueTime = normalizeDueTime(raw.dueTime)
  if (dueTime !== undefined) item.dueTime = dueTime
  if (raw.urgent === true) item.urgent = true
  if (raw.flagged === true) item.flagged = true
  if (Number.isFinite(raw.priority) && raw.priority > 0) {
    item.priority = Math.min(9, Math.max(1, Math.round(raw.priority)))
  }
  if (typeof raw.list === 'string' && raw.list.trim() !== '') item.list = raw.list.trim()
  const tags = normalizeTags(raw.tags)
  if (tags.length > 0) item.tags = tags
  if (typeof raw.url === 'string' && raw.url.trim() !== '') item.url = raw.url.trim()
  if (typeof raw.repeat === 'string' && REPEAT_VALUES.has(raw.repeat)) item.repeat = raw.repeat
  if (typeof raw.location === 'string' && raw.location.trim() !== '') item.location = raw.location.trim()
  if (typeof raw.parentId === 'string' && raw.parentId.trim() !== '' && raw.parentId.trim() !== item.id) {
    item.parentId = raw.parentId.trim()
  }
  if (typeof raw.section === 'string' && raw.section.trim() !== '') item.section = raw.section.trim()
  if (Number.isFinite(raw.order)) item.order = raw.order
  if (Number.isFinite(raw.deletedAt)) item.deletedAt = raw.deletedAt

  const synced = raw.synced
  if (synced !== null && typeof synced === 'object' && typeof synced.text === 'string') {
    item.synced = { text: synced.text, done: synced.done === true }
    for (const field of SYNCED_OPTIONAL_FIELDS) {
      if (synced[field] !== undefined) item.synced[field] = synced[field]
    }
  }
  return item
}

/**
 * Normalize a soft-deleted trash item (never carries mirror bindings).
 * @param {unknown} raw - candidate trash entry.
 * @returns {object|null} normalized trash item, or null.
 */
export function normalizeTrashItem(raw) {
  const item = normalizeItem(raw)
  if (item === null) return null
  delete item.reminderId
  delete item.synced
  delete item.pushedAt
  if (!Number.isFinite(item.deletedAt)) item.deletedAt = Date.now()
  return item
}

/**
 * Normalize per-list metadata (`color`, `icon`, `pinned`, `sections`).
 * @param {unknown} raw - candidate `settings.listMeta` map.
 * @returns {Record<string, object>} normalized map.
 */
export function normalizeListMeta(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const [rawName, entry] of Object.entries(raw)) {
    const name = rawName.trim()
    if (name === '' || entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const meta = {}
    if (typeof entry.color === 'string' && entry.color.trim() !== '') meta.color = entry.color.trim()
    if (typeof entry.icon === 'string' && entry.icon.trim() !== '') meta.icon = entry.icon.trim()
    if (entry.pinned === true) meta.pinned = true
    if (Array.isArray(entry.sections)) {
      const sections = [...new Set(
        entry.sections
          .filter((sec) => typeof sec === 'string' && sec.trim() !== '')
          .map((sec) => sec.trim()),
      )]
      if (sections.length > 0) meta.sections = sections
    }
    out[name] = meta
  }
  return out
}

/**
 * @param {unknown} raw - parsed document.
 * @returns {{version: number, rev: number, items: object[], trash: object[], tombstones: object[], settings: object}} a usable state.
 */
export function normalizeState(raw) {
  if (raw === null || typeof raw !== 'object' || !Array.isArray(raw.items)) return emptyState()
  const now = Date.now()
  const tombstones = Array.isArray(raw.tombstones)
    ? raw.tombstones
      .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.reminderId === 'string')
      .map((entry) => {
        const tomb = {
          reminderId: entry.reminderId,
          at: Number.isFinite(entry.at) ? entry.at : now,
        }
        if (typeof entry.list === 'string' && entry.list.trim() !== '') tomb.list = entry.list.trim()
        return tomb
      })
    : []
  const trash = Array.isArray(raw.trash)
    ? raw.trash
      .map(normalizeTrashItem)
      .filter((item) => item !== null && now - item.deletedAt <= TRASH_MS)
    : []
  const settings = {}
  if (raw.settings !== null && typeof raw.settings === 'object') {
    if (Array.isArray(raw.settings.lists)) {
      const chosen = raw.settings.lists
        .filter((name) => typeof name === 'string' && name.trim() !== '')
        .map((name) => name.trim())
      if (chosen.length > 0) settings.lists = [...new Set(chosen)]
    }
    const listMeta = normalizeListMeta(raw.settings.listMeta)
    if (Object.keys(listMeta).length > 0) settings.listMeta = listMeta
  }
  return {
    version: VERSION,
    rev: Number.isFinite(raw.rev) ? raw.rev : 0,
    items: raw.items.map(normalizeItem).filter((item) => item !== null),
    trash,
    tombstones,
    settings,
  }
}

/**
 * Read the list document.
 * @param {string} file - absolute path.
 * @returns {Promise<object>} the stored list.
 */
export async function loadState(file) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState()
    throw error
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    // Keep the unreadable document beside the new one instead of destroying it.
    const aside = `${file}.corrupt-${Date.now()}`
    await rename(file, aside).catch(() => {})
    return emptyState()
  }
  return normalizeState(parsed)
}

/**
 * Replace the list document atomically: a fresh file renamed over the old one.
 * @param {string} file - absolute path.
 * @param {object} state - the complete next state.
 * @returns {Promise<void>} resolution after the replacement.
 */
export async function saveState(file, state) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  await rename(temp, file)
}

/** @param {object} state - the state to age. @returns {object} the same state, tombstones pruned. */
export function pruneTombstones(state) {
  const cutoff = Date.now() - TOMBSTONE_MS
  state.tombstones = state.tombstones.filter((entry) => entry.at > cutoff)
  return state
}

/**
 * Prune soft-deleted trash items older than {@link TRASH_MS}.
 * @param {object} state - the state to age.
 * @param {number} [now] - reference timestamp.
 * @returns {object} the same state, old trash pruned.
 */
export function pruneTrash(state, now = Date.now()) {
  const cutoff = now - TRASH_MS
  state.trash = (Array.isArray(state.trash) ? state.trash : []).filter(
    (entry) => Number.isFinite(entry.deletedAt) && entry.deletedAt > cutoff,
  )
  return state
}

/** Clone a single task or trash item safely for draft editing. */
function cloneItem(item) {
  const copy = { ...item }
  if (Array.isArray(item.tags)) copy.tags = [...item.tags]
  if (item.synced !== undefined && item.synced !== null) copy.synced = { ...item.synced }
  return copy
}

/** Clone `settings` safely so draft mutations never leak into previous snapshots. */
function cloneSettings(settings) {
  const src = settings !== null && typeof settings === 'object' ? settings : {}
  const out = { ...src }
  if (Array.isArray(src.lists)) out.lists = [...src.lists]
  if (src.listMeta !== null && typeof src.listMeta === 'object') {
    const metaCopy = {}
    for (const [k, v] of Object.entries(src.listMeta)) {
      if (v === null || typeof v !== 'object') continue
      metaCopy[k] = {
        ...v,
        ...(Array.isArray(v.sections) ? { sections: [...v.sections] } : {}),
      }
    }
    out.listMeta = metaCopy
  }
  return out
}

/**
 * The list: current state, serialized writes, and change notification.
 */
export class TodoStore {
  /**
   * @param {string} file - absolute path of the list document.
   */
  constructor(file) {
    this.file = file
    this.state = emptyState()
    this.chain = Promise.resolve()
    this.listeners = new Set()
  }

  /** @returns {Promise<object>} the loaded state. */
  async load() {
    this.state = await loadState(this.file)
    return this.state
  }

  /** @returns {object} the committed state (read-only by convention). */
  get() {
    return this.state
  }

  /**
   * @param {(state: object) => void} listener - called after every commit.
   * @returns {() => void} unsubscribe.
   */
  subscribe(listener) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Apply one read-modify-write cycle on the list, then persist it.
   * @param {(draft: object) => void} mutate - edits the draft in place; may be async.
   * @returns {Promise<object>} the committed state.
   */
  commit(mutate) {
    const run = async () => {
      const draft = {
        ...this.state,
        items: this.state.items.map(cloneItem),
        trash: (Array.isArray(this.state.trash) ? this.state.trash : []).map(cloneItem),
        tombstones: this.state.tombstones.map((entry) => ({ ...entry })),
        settings: cloneSettings(this.state.settings),
      }
      await mutate(draft)
      draft.version = VERSION
      draft.rev = this.state.rev + 1
      await saveState(this.file, draft)
      this.state = draft
      for (const listener of this.listeners) {
        try {
          listener(draft)
        } catch {
          // A broken listener must not fail the write that notified it.
        }
      }
      return draft
    }
    const next = this.chain.then(run, run)
    this.chain = next.then(() => {}, () => {})
    return next
  }
}
