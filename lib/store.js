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
 * @returns {{version: number, rev: number, items: object[], tombstones: object[], settings: object}} an empty list.
 */
export function emptyState() {
  return { version: VERSION, rev: 0, items: [], tombstones: [], settings: {} }
}

/**
 * @param {string} text - task text.
 * @returns {string} a list-local id; nothing else reads it.
 */
export function newId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
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
  if (typeof raw.notes === 'string' && raw.notes.trim() !== '') item.notes = raw.notes
  if (typeof raw.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.due)) item.due = raw.due
  if (raw.flagged === true) item.flagged = true
  if (Number.isFinite(raw.priority) && raw.priority > 0) item.priority = raw.priority
  if (typeof raw.list === 'string' && raw.list.trim() !== '') item.list = raw.list.trim()
  const synced = raw.synced
  if (synced !== null && typeof synced === 'object' && typeof synced.text === 'string') {
    item.synced = { text: synced.text, done: synced.done === true }
    for (const field of ['notes', 'due', 'flagged', 'priority', 'list']) {
      if (synced[field] !== undefined) item.synced[field] = synced[field]
    }
  }
  return item
}

/**
 * @param {unknown} raw - parsed document.
 * @returns {{version: number, rev: number, items: object[], tombstones: object[]}} a usable state.
 */
export function normalizeState(raw) {
  if (raw === null || typeof raw !== 'object' || !Array.isArray(raw.items)) return emptyState()
  const tombstones = Array.isArray(raw.tombstones)
    ? raw.tombstones
      .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.reminderId === 'string')
      .map((entry) => ({ reminderId: entry.reminderId, at: Number.isFinite(entry.at) ? entry.at : Date.now() }))
    : []
  const chosen = raw.settings !== null && typeof raw.settings === 'object' && Array.isArray(raw.settings.lists)
    ? raw.settings.lists
      .filter((name) => typeof name === 'string' && name.trim() !== '')
      .map((name) => name.trim())
    : undefined
  return {
    version: VERSION,
    rev: Number.isFinite(raw.rev) ? raw.rev : 0,
    items: raw.items.map(normalizeItem).filter((item) => item !== null),
    tombstones,
    settings: chosen === undefined || chosen.length === 0 ? {} : { lists: [...new Set(chosen)] },
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
        items: this.state.items.map((item) => ({ ...item })),
        tombstones: this.state.tombstones.map((entry) => ({ ...entry })),
        settings: { ...this.state.settings },
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
