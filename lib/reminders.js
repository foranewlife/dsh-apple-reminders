/**
 * The Apple Reminders mirror: every call drives Reminders.app through one
 * `osascript` process running JXA, so nothing here blocks the Host event loop.
 *
 * Reminders answers one Apple event per object and property, so reads are
 * batched per property and the Host asks for the expensive fields (notes, due,
 * flag, priority) less often than the cheap ones (name, completed).
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'

const run = promisify(execFile)
const OSASCRIPT = '/usr/bin/osascript'
/** Reminders answers slowly on big lists; one call must never hang a sync pass. */
const CALL_TIMEOUT_MS = 60000

/**
 * @returns {boolean} whether this Host can drive Apple Reminders at all.
 */
export function remindersAvailable() {
  return process.platform === 'darwin' && existsSync(OSASCRIPT)
}

/**
 * Run one JXA body and parse its JSON result.
 * @param {string} body - statements that end with `return JSON.stringify(...)`.
 * @returns {Promise<unknown>} the decoded result, or null for an empty answer.
 */
async function jxa(body) {
  const script = `(() => {
  const R = Application("Reminders")
  const before = new Date(); before.setMilliseconds(0)
  const dstr = (d) => {
    if (d === null || d === undefined) return null
    const x = new Date(d)
    if (isNaN(x.getTime())) return null
    const pad = (n) => (n < 10 ? "0" + n : "" + n)
    return x.getFullYear() + "-" + pad(x.getMonth() + 1) + "-" + pad(x.getDate())
  }
  const dval = (s) => {
    if (typeof s !== "string" || s === "") return null
    const parts = s.split("-").map(Number)
    return new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0)
  }
  ${body}
})()`
  const { stdout } = await run(OSASCRIPT, ['-l', 'JavaScript', '-e', script], {
    timeout: CALL_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  })
  const text = stdout.trim()
  if (text === '') return null
  return JSON.parse(text)
}

/** @param {string} value - embed as a JS string literal. */
const lit = (value) => JSON.stringify(String(value))

/** @param {unknown} list - list of names. @returns {string} a JS array literal. */
const litList = (list) => `[${[...list].map(lit).join(', ')}]`

/**
 * Read one or more lists in a single call.
 * @param {string[]} listNames - Reminders list names.
 * @param {{detailed?: boolean}} [options] - read notes/due/flag/priority too.
 * @returns {Promise<{name: string, exists: boolean, items: object[]}[]>} their tasks.
 */
export async function readLists(listNames, options = {}) {
  const detailed = options.detailed === true
  const result = await jxa(`
  const NAMES = ${litList(listNames)}
  const existing = R.lists.name()
  return JSON.stringify(NAMES.map((name) => {
    if (existing.indexOf(name) < 0) return { name, exists: false, items: [] }
    const list = R.lists.byName(name)
    const ids = list.reminders.id()
    const titles = list.reminders.name()
    const done = list.reminders.completed()
    let bodies = ${detailed ? 'list.reminders.body()' : '[]'}
    let dues = ${detailed ? 'list.reminders.dueDate()' : '[]'}
    let flags = ${detailed ? 'list.reminders.flagged()' : '[]'}
    let prios = ${detailed ? 'list.reminders.priority()' : '[]'}
    const items = ids.map((id, i) => {
      const item = {
        id: String(id),
        name: String(titles[i] === undefined || titles[i] === null ? "" : titles[i]),
        completed: done[i] === true,
      }
      if (${detailed}) {
        item.notes = String(bodies[i] === undefined || bodies[i] === null ? "" : bodies[i])
        item.due = dstr(dues[i])
        item.flagged = flags[i] === true
        item.priority = Number(prios[i] || 0)
      }
      return item
    })
    return { name, exists: true, items }
  }))`)
  return Array.isArray(result) ? result : []
}

/**
 * Read every list name in Reminders.
 * @returns {Promise<string[]>} the names, in Reminders order.
 */
export async function listNames() {
  const result = await jxa('return JSON.stringify(R.lists.name())')
  return Array.isArray(result) ? result.map(String) : []
}

/**
 * Move one reminder into another list, creating it when missing.
 * @param {string} fromList - the list it is in now.
 * @param {string} id - reminder id.
 * @param {string} toList - the list it should be in.
 * @returns {Promise<boolean>} whether it was found and moved.
 */
export async function moveReminder(fromList, id, toList) {
  const result = await jxa(`
  const FROM = ${lit(fromList)}
  const TO = ${lit(toList)}
  const TARGET = ${lit(id)}
  const existing = R.lists.name()
  if (existing.indexOf(TO) < 0) R.lists.push(R.List({ name: TO }))
  if (existing.indexOf(FROM) < 0) return JSON.stringify({ found: false })
  const list = R.lists.byName(FROM)
  const index = list.reminders.id().map(String).indexOf(TARGET)
  if (index < 0) return JSON.stringify({ found: false })
  R.move(list.reminders[index], { to: R.lists.byName(TO) })
  return JSON.stringify({ found: true })`)
  return result !== null && result.found === true
}

/**
 * Read every list colour, so the panel can show the same dots Reminders does.
 * @returns {Promise<Record<string, string>>} colour by list name; empty when unset.
 */
export async function listColors() {
  const result = await jxa(`
  const out = {}
  for (const name of R.lists.name()) {
    let colour = ""
    try { colour = String(R.lists.byName(String(name)).color() || "") } catch (e) { colour = "" }
    out[String(name)] = colour
  }
  return JSON.stringify(out)`)
  return result !== null && typeof result === "object" ? result : {}
}

/**
 * Create the mirror lists that do not exist yet.
 * @param {string[]} listNames - Reminders list names.
 * @returns {Promise<void>} resolution after every list exists.
 */
export async function ensureLists(listNames) {
  await jxa(`
  const NAMES = ${litList(listNames)}
  const existing = R.lists.name()
  for (const name of NAMES) if (existing.indexOf(name) < 0) R.lists.push(R.List({ name }))
  return JSON.stringify({ ok: true })`)
}

/**
 * Write Reminders properties from a task patch.
 * @param {object} patch - `{text, done, notes, due, flagged, priority}` (all optional).
 * @param {string} varName - JXA variable holding the reminder.
 * @returns {string} assignment statements.
 */
function assignments(patch, varName) {
  const lines = []
  if (typeof patch.text === 'string') lines.push(`${varName}.name = ${lit(patch.text)}`)
  if (typeof patch.done === 'boolean') lines.push(`${varName}.completed = ${patch.done === true}`)
  if (typeof patch.notes === 'string') lines.push(`${varName}.body = ${lit(patch.notes)}`)
  if (patch.due === null) lines.push(`${varName}.dueDate = null`)
  else if (typeof patch.due === 'string') lines.push(`${varName}.dueDate = dval(${lit(patch.due)})`)
  if (typeof patch.flagged === 'boolean') lines.push(`${varName}.flagged = ${patch.flagged === true}`)
  if (typeof patch.priority === 'number') lines.push(`${varName}.priority = ${patch.priority}`)
  return lines.join('\n  ')
}

/**
 * Add one task to a list, creating the list when it is missing.
 * @param {string} listName - Reminders list name.
 * @param {{text: string, done?: boolean, notes?: string, due?: string, flagged?: boolean, priority?: number}} task - initial properties.
 * @returns {Promise<string>} the new reminder id.
 */
export async function createReminder(listName, task) {
  const result = await jxa(`
  const NAME = ${lit(listName)}
  if (R.lists.name().indexOf(NAME) < 0) R.lists.push(R.List({ name: NAME }))
  const list = R.lists.byName(NAME)
  // push() answers the new element's 1-based index, so the id costs one lookup
  // instead of a full property read of the whole list.
  const index = list.reminders.push(R.Reminder({ name: ${lit(task.text)} }))
  const rem = list.reminders[index - 1]
  ${assignments({ ...task, text: undefined }, 'rem')}
  return JSON.stringify({ id: String(rem.id()) })`)
  if (result === null || typeof result.id !== 'string') throw new Error('Reminders did not return the new reminder id')
  return result.id
}

/**
 * Write a patch to one reminder.
 * @param {string} listName - Reminders list name.
 * @param {string} id - reminder id.
 * @param {object} patch - `{text, done, notes, due, flagged, priority}`.
 * @returns {Promise<boolean>} whether the reminder was found.
 */
export async function updateReminder(listName, id, patch) {
  const body = assignments(patch, 'rem')
  if (body === '') return true
  const result = await jxa(`
  const NAME = ${lit(listName)}
  const TARGET = ${lit(id)}
  if (R.lists.name().indexOf(NAME) < 0) return JSON.stringify({ found: false })
  const list = R.lists.byName(NAME)
  const index = list.reminders.id().map(String).indexOf(TARGET)
  if (index < 0) return JSON.stringify({ found: false })
  const rem = list.reminders[index]
  ${body}
  return JSON.stringify({ found: true })`)
  return result !== null && result.found === true
}

/**
 * @param {string} listName - Reminders list name.
 * @param {string} id - reminder id.
 * @returns {Promise<boolean>} whether it was found and deleted.
 */
export async function deleteReminder(listName, id) {
  const result = await jxa(`
  const NAME = ${lit(listName)}
  const TARGET = ${lit(id)}
  if (R.lists.name().indexOf(NAME) < 0) return JSON.stringify({ found: false })
  const list = R.lists.byName(NAME)
  const index = list.reminders.id().map(String).indexOf(TARGET)
  if (index < 0) return JSON.stringify({ found: false })
  list.reminders[index].delete()
  return JSON.stringify({ found: true })`)
  return result !== null && result.found === true
}
