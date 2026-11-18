/**
 * The Apple Reminders mirror: every call drives Reminders.app through one
 * `osascript` process running JXA, so nothing here blocks the Host event loop.
 *
 * Reminders answers one Apple event per object and property, so reads are
 * batched per property and the Host asks for the expensive fields (notes, due,
 * dueTime, flag, priority) less often than the cheap ones (name, completed).
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
  const pad = (n) => (n < 10 ? "0" + n : "" + n)
  const dstr = (d) => {
    if (d === null || d === undefined) return null
    const x = new Date(d)
    if (isNaN(x.getTime())) return null
    return x.getFullYear() + "-" + pad(x.getMonth() + 1) + "-" + pad(x.getDate())
  }
  const tstr = (d) => {
    if (d === null || d === undefined) return null
    const x = new Date(d)
    if (isNaN(x.getTime())) return null
    return pad(x.getHours()) + ":" + pad(x.getMinutes())
  }
  const dval = (s) => {
    if (typeof s !== "string" || s === "") return null
    const parts = s.split("-").map(Number)
    return new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0)
  }
  const dtval = (s, t) => {
    if (typeof s !== "string" || s === "") return null
    const dp = s.split("-").map(Number)
    const tp = typeof t === "string" && t.indexOf(":") >= 0 ? t.split(":").map(Number) : [0, 0]
    return new Date(dp[0], dp[1] - 1, dp[2], tp[0] || 0, tp[1] || 0, 0)
  }
  const normPrio = (p) => {
    const n = Number(p || 0)
    if (!n || n <= 0) return 0
    if (n <= 4) return 1
    if (n === 5) return 5
    return 9
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
 * @param {{detailed?: boolean}} [options] - read notes/due/dueTime/flag/priority too.
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
    let alldays = []
    let reminds = []
    if (${detailed}) {
      try { alldays = list.reminders.alldayDueDate() } catch (e) { alldays = [] }
      try { reminds = list.reminders.remindMeDate() } catch (e) { reminds = [] }
    }
    let flags = ${detailed ? 'list.reminders.flagged()' : '[]'}
    let prios = ${detailed ? 'list.reminders.priority()' : '[]'}
    const items = ids.map((id, i) => {
      const item = {
        id: String(id),
        name: String(titles[i] === undefined || titles[i] === null ? "" : titles[i]),
        completed: done[i] === true,
      }
      if (${detailed}) {
        const rawDue = dues[i] || alldays[i] || reminds[i]
        item.notes = String(bodies[i] === undefined || bodies[i] === null ? "" : bodies[i])
        item.due = dstr(rawDue)
        let dueTime = null
        if (item.due !== null) {
          if (reminds[i] !== null && reminds[i] !== undefined) {
            dueTime = tstr(dues[i] || reminds[i])
          } else if (dues[i] !== null && dues[i] !== undefined) {
            const xd = new Date(dues[i])
            if (!isNaN(xd.getTime()) && (xd.getHours() !== 0 || xd.getMinutes() !== 0)) {
              dueTime = tstr(xd)
            }
          }
        }
        item.dueTime = dueTime
        item.flagged = flags[i] === true
        item.priority = normPrio(prios[i])
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
 * Pull a displayable emoji out of whatever Apple stores in a list emblem.
 * Apple writes a bare emoji when the plugin sets one, but its own emoji emblems
 * round-trip as JSON such as {"Emoji":"👏"}; an image emblem has no text form.
 * @param {unknown} raw - the emblem value.
 * @returns {string} the emoji, or an empty string when there is none to show.
 */
export function emojiFrom(raw) {
  const text = typeof raw === "string" ? raw.trim() : ""
  if (text === "") return ""
  if (!text.startsWith("{")) return text
  try {
    const parsed = JSON.parse(text)
    for (const key of ["Emoji", "emoji", "Value", "value", "Char", "char", "Text", "text"]) {
      const value = parsed === null || typeof parsed !== "object" ? undefined : parsed[key]
      if (typeof value === "string" && value.trim() !== "") return value.trim()
    }
  } catch {
    // Not JSON after all; fall through to "nothing to show".
  }
  return ""
}

/**
 * Read every list's name, colour, and emblem icon in a single JXA pass.
 * @returns {Promise<{name: string, color: string, emblem: string}[]>} list metadata in Reminders order.
 */
export async function listDetails() {
  const result = await jxa(`
  const names = R.lists.name()
  const out = []
  for (const raw of names) {
    const name = String(raw)
    let color = ""
    let emblem = ""
    try {
      const l = R.lists.byName(name)
      try { color = String(l.color() || "") } catch (e) { color = "" }
      try { emblem = String(l.emblem() || "") } catch (e) { emblem = "" }
    } catch (e) {}
    out.push({ name, color, emblem })
  }
  return JSON.stringify(out)`)
  if (!Array.isArray(result)) return []
  return result.map((entry) => ({ ...entry, emblem: emojiFrom(entry.emblem) }))
}

/**
 * Read every list colour, so the panel can show the same dots Reminders does.
 * @returns {Promise<Record<string, string>>} colour by list name; empty when unset.
 */
export async function listColors() {
  const details = await listDetails()
  const out = {}
  for (const entry of details) out[entry.name] = entry.color
  return out
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
 * Create a single list in Apple Reminders (if missing) and apply optional colour/emblem.
 * @param {string} name - list name.
 * @param {string|{color?: string, emblem?: string}} [colorOrOptions] - colour hex/name or options object.
 * @returns {Promise<boolean>} whether the list now exists.
 */
export async function createList(name, colorOrOptions = {}) {
  const opts = typeof colorOrOptions === 'string'
    ? { color: colorOrOptions }
    : (colorOrOptions ?? {})
  const color = typeof opts.color === 'string' ? opts.color.trim() : ''
  // Store the bare emoji: Apple keeps that as-is, while a JSON emblem renders raw.
  const emblem = emojiFrom(opts.emblem)
  const result = await jxa(`
  const NAME = ${lit(name)}
  const COLOR = ${lit(color)}
  const EMBLEM = ${lit(emblem)}
  const existing = R.lists.name()
  if (existing.indexOf(NAME) < 0) R.lists.push(R.List({ name: NAME }))
  const list = R.lists.byName(NAME)
  if (COLOR !== "") { try { list.color = COLOR } catch (e) {} }
  if (EMBLEM !== "") { try { list.emblem = EMBLEM } catch (e) {} }
  return JSON.stringify({ ok: true })`)
  return result !== null && result.ok === true
}

/**
 * Rename an existing list in Apple Reminders.
 * @param {string} oldName - current list name.
 * @param {string} newName - replacement list name.
 * @returns {Promise<boolean>} whether the list was found and renamed.
 */
export async function renameList(oldName, newName) {
  if (oldName === newName) return true
  const result = await jxa(`
  const OLD = ${lit(oldName)}
  const NEW = ${lit(newName)}
  const existing = R.lists.name()
  if (existing.indexOf(OLD) < 0) return JSON.stringify({ found: false })
  if (existing.indexOf(NEW) >= 0) return JSON.stringify({ found: false, conflict: true })
  R.lists.byName(OLD).name = NEW
  return JSON.stringify({ found: true })`)
  return result !== null && result.found === true
}

/**
 * Update an existing list's name, colour, and/or emblem in Apple Reminders.
 * @param {string} name - current list name.
 * @param {{newName?: string, color?: string, emblem?: string}} [patch] - properties to update.
 * @returns {Promise<boolean>} whether the list was found.
 */
export async function updateListMirror(name, patch = {}) {
  const newName = typeof patch.newName === 'string' && patch.newName.trim() !== '' && patch.newName.trim() !== name
    ? patch.newName.trim()
    : ''
  const color = typeof patch.color === 'string' ? patch.color.trim() : null
  const emblem = patch.emblem === undefined ? null : emojiFrom(patch.emblem)
  const result = await jxa(`
  const NAME = ${lit(name)}
  const NEW_NAME = ${lit(newName)}
  const COLOR = ${color === null ? 'null' : lit(color)}
  const EMBLEM = ${emblem === null ? 'null' : lit(emblem)}
  const existing = R.lists.name()
  if (existing.indexOf(NAME) < 0) return JSON.stringify({ found: false })
  const list = R.lists.byName(NAME)
  if (NEW_NAME !== "" && existing.indexOf(NEW_NAME) < 0) {
    try { list.name = NEW_NAME } catch (e) {}
  }
  if (COLOR !== null && COLOR !== "") {
    try { list.color = COLOR } catch (e) {}
  }
  if (EMBLEM !== null && EMBLEM !== "") {
    try { list.emblem = EMBLEM } catch (e) {}
  }
  return JSON.stringify({ found: true })`)
  return result !== null && result.found === true
}

/**
 * Delete a list in Apple Reminders if it exists.
 * @param {string} name - list name.
 * @returns {Promise<boolean>} whether it was found and deleted.
 */
export async function deleteList(name) {
  const result = await jxa(`
  const NAME = ${lit(name)}
  const existing = R.lists.name()
  if (existing.indexOf(NAME) < 0) return JSON.stringify({ found: false })
  R.lists.byName(NAME).delete()
  return JSON.stringify({ found: true })`)
  return result !== null && result.found === true
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
 * Write Reminders properties from a task patch.
 * All-day tasks (`due` without `dueTime`) set `alldayDueDate` with `remindMeDate = null`;
 * timed tasks (`due` + `dueTime`) set both `dueDate` and `remindMeDate` to the local HH:MM.
 * @param {object} patch - `{text, done, notes, due, dueTime, flagged, priority}` (all optional).
 * @param {string} varName - JXA variable holding the reminder.
 * @returns {string} assignment statements.
 */
function assignments(patch, varName) {
  const lines = []
  if (typeof patch.text === 'string') lines.push(`${varName}.name = ${lit(patch.text)}`)
  if (typeof patch.done === 'boolean') lines.push(`${varName}.completed = ${patch.done === true}`)
  if (typeof patch.notes === 'string') lines.push(`${varName}.body = ${lit(patch.notes)}`)

  const hasDue = 'due' in patch && patch.due !== undefined
  const hasDueTime = 'dueTime' in patch && patch.dueTime !== undefined
  if (patch.due === null) {
    lines.push(`${varName}.dueDate = null`)
    lines.push(`try { ${varName}.alldayDueDate = null } catch (e) {}`)
    lines.push(`try { ${varName}.remindMeDate = null } catch (e) {}`)
  } else if (typeof patch.due === 'string' && patch.due !== '') {
    if (typeof patch.dueTime === 'string' && patch.dueTime !== '') {
      lines.push(`{ const _dt = dtval(${lit(patch.due)}, ${lit(patch.dueTime)}); ${varName}.dueDate = _dt; try { ${varName}.remindMeDate = _dt } catch (e) {} }`)
    } else {
      lines.push(`{ const _d = dval(${lit(patch.due)}); ${varName}.dueDate = null; try { ${varName}.remindMeDate = null } catch (e) {}; try { ${varName}.alldayDueDate = _d } catch (e) { ${varName}.dueDate = _d } }`)
    }
  } else if (!hasDue && hasDueTime) {
    if (typeof patch.dueTime === 'string' && patch.dueTime !== '') {
      lines.push(`{ let _c = null; try { _c = dstr(${varName}.dueDate() || ${varName}.alldayDueDate()) } catch (e) { _c = dstr(${varName}.dueDate()) }; if (_c !== null) { const _dt = dtval(_c, ${lit(patch.dueTime)}); ${varName}.dueDate = _dt; try { ${varName}.remindMeDate = _dt } catch (e) {} } }`)
    } else {
      lines.push(`{ let _c = null; try { _c = dstr(${varName}.dueDate() || ${varName}.alldayDueDate()) } catch (e) { _c = dstr(${varName}.dueDate()) }; if (_c !== null) { const _d = dval(_c); ${varName}.dueDate = null; try { ${varName}.remindMeDate = null } catch (e) {}; try { ${varName}.alldayDueDate = _d } catch (e) { ${varName}.dueDate = _d } } }`)
    }
  }

  if (typeof patch.flagged === 'boolean') lines.push(`${varName}.flagged = ${patch.flagged === true}`)
  if (typeof patch.priority === 'number') lines.push(`${varName}.priority = ${patch.priority}`)
  return lines.join('\n  ')
}

/**
 * Add one task to a list, creating the list when it is missing.
 * @param {string} listName - Reminders list name.
 * @param {{text: string, done?: boolean, notes?: string, due?: string|null, dueTime?: string|null, flagged?: boolean, priority?: number}} task - initial properties.
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
 * @param {object} patch - `{text, done, notes, due, dueTime, flagged, priority}`.
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
