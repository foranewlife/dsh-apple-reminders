/**
 * Offline and live checks for the Host half of dsh-todo.
 *
 *   node test/host-check.mjs                    # plans, store, tool, routes
 *   DSH_TODO_LIVE=1 node test/host-check.mjs    # plus a real Reminders round trip
 *
 * The live part creates throw-away Reminders lists, drives them from both
 * sides, and deletes them.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { apply } from '../index.js'
import { readLists, remindersAvailable } from '../lib/reminders.js'
import {
  extractInlineTags,
  localDateString,
  nextDueDate,
  normalizeState,
  TodoStore,
  TRASH_MS,
  loadState,
} from '../lib/store.js'
import { CHEAP_FIELDS, FIELDS, planMerge, planPush } from '../lib/sync.js'

const run = promisify(execFile)

let failures = 0
/** @param {boolean} ok @param {string} label - what was checked. */
function check(ok, label) {
  if (ok) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}`)
}

/** @param {unknown} actual @param {unknown} expected @param {string} label */
function equal(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) console.log(`       expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  check(ok, label)
}

/** Build the smallest Cordis context this plugin uses. */
function fakeContext() {
  const tools = new Map()
  const routes = new Map()
  const ctx = {
    logger: { warn() {}, error() {} },
    effect(fn) {
      fn()
      return () => {}
    },
    inject(_deps, callback) {
      callback(ctx)
      return () => {}
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route)
          return async () => routes.delete(route.path)
        },
      },
    },
  }
  return { ctx, tools, routes }
}

/** @param {{routes: Map<string, object>}} world @param {object} body */
async function post(world, body) {
  const route = world.routes.get('/api/dsh-apple-reminders/op')
  if (route === undefined) throw new Error('op route not registered')
  const response = await route.fetch(new Request('http://127.0.0.1/api/dsh-apple-reminders/op', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
  return { status: response.status, payload: await response.json() }
}

/** Read the first SSE frame the event route emits. */
async function firstFrame(world) {
  const route = world.routes.get('/api/dsh-apple-reminders/events')
  if (route === undefined) throw new Error('event route not registered')
  const response = await route.fetch(new Request('http://127.0.0.1/api/dsh-apple-reminders/events', { method: 'GET' }))
  const reader = response.body.getReader()
  const { value } = await reader.read()
  await reader.cancel()
  const line = new TextDecoder().decode(value).split('\n').find((entry) => entry.startsWith('data: '))
  return JSON.parse(line.slice(6))
}

// ---------------------------------------------------------------- plans ---
function plannerChecks() {
  const now = 1_700_000_000_000
  const listOf = (item) => item.list ?? 'A'
  const mirrorOf = (name, items) => ({ name, exists: true, items })

  console.log('planPush')
  const push = planPush([
    { id: 'a', text: '新任务', done: false, createdAt: now },
    { id: 'b', text: '有属性', done: false, reminderId: 'r-b', synced: { text: '有属性', done: false }, pushedAt: now },
    { id: 'c', text: '改了日期', due: '2026-12-01', priority: 5, flagged: true, notes: '备注', done: false, reminderId: 'r-c', synced: { text: '改了日期', done: false }, pushedAt: now },
    { id: 'd', text: '完成的', done: true, doneAt: now, reminderId: 'r-d', synced: { text: '完成的', done: false }, pushedAt: now },
    { id: 'e', text: '完成但没镜像', done: true, doneAt: now, createdAt: now },
    { id: 'f', text: '旧完成', done: true, doneAt: now - 40 * 86400_000, reminderId: 'r-f', synced: { text: '旧完成', done: true }, pushedAt: now },
  ], { now, listOf })
  equal(push.create.map((entry) => entry.itemId), ['a', 'e'], 'open and recently completed tasks are created')
  equal(push.create[0].task, { text: '新任务', done: false }, 'a new task carries its normalized fields')
  equal(push.update.map((entry) => [entry.itemId, entry.patch]), [
    ['c', { notes: '备注', due: '2026-12-01', flagged: true, priority: 5 }],
    ['d', { done: true }],
  ], 'changed fields are pushed, and only those')
  equal(push.prune.map((entry) => entry.itemId), ['f'], 'a task completed long ago stops being mirrored')
  equal(planPush([{ id: 'z', text: '很久前', done: true, doneAt: now - 40 * 86400_000, createdAt: now }], { now, listOf }).create, [], 'a task completed long ago is not pushed')

  const moved = planPush([{ id: 'p', text: '搬家', done: false, list: 'B', reminderId: 'r-p', synced: { text: '搬家', done: false, list: 'A' }, pushedAt: now }], { now, listOf })
  equal(moved.move, [{ itemId: 'p', reminderId: 'r-p', from: 'A', to: 'B' }], 'a task moved here moves its reminder')

  const timedPush = planPush([
    { id: 't1', text: '带时间', done: false, due: '2026-12-01', dueTime: '09:30', reminderId: 'r-t1', synced: { text: '带时间', done: false, due: '2026-12-01' }, pushedAt: now },
    { id: 't2', text: '清时间', done: false, due: '2026-12-01', reminderId: 'r-t2', synced: { text: '清时间', done: false, due: '2026-12-01', dueTime: '14:00' }, pushedAt: now },
  ], { now, listOf })
  equal(timedPush.update.map((entry) => [entry.itemId, entry.patch]), [
    ['t1', { dueTime: '09:30' }],
    ['t2', { dueTime: undefined }],
  ], 'dueTime additions and removals are pushed')

  console.log('planMerge')
  const items = [
    { id: 'a', text: '这里改的', done: false, reminderId: 'r-a', synced: { text: '旧文字', done: false } },
    { id: 'b', text: '没动', done: false, reminderId: 'r-b', synced: { text: '没动', done: false } },
    { id: 'c', text: '原始', done: false, reminderId: 'r-c', synced: { text: '原始', done: false } },
    { id: 'd', text: '完成于手机', done: false, reminderId: 'r-d', synced: { text: '完成于手机', done: false } },
    { id: 'e', text: '在手机删了', done: false, reminderId: 'r-e', synced: { text: '在手机删了', done: false }, pushedAt: 0 },
    { id: 'f', text: '还没同步', done: false },
    { id: 'g', text: '手机补了日期', done: false, reminderId: 'r-g', synced: { text: '手机补了日期', done: false } },
    { id: 'h', text: '我标了旗', flagged: true, done: false, reminderId: 'r-h', synced: { text: '我标了旗', done: false } },
  ]
  const merge = planMerge(items, [
    mirrorOf('A', [
      { id: 'r-a', name: '旧文字', completed: false },
      { id: 'r-b', name: '没动', completed: false },
      { id: 'r-c', name: '手机版', completed: false },
      { id: 'r-d', name: '完成于手机', completed: true },
      { id: 'r-g', name: '手机补了日期', completed: false, due: '2026-12-24', notes: '手机备注', flagged: true, priority: 9 },
      { id: 'r-h', name: '我标了旗', completed: false, flagged: false },
      { id: 'r-i', name: '手机新增的', completed: false },
    ]),
  ], [], { now, listOf })
  equal(merge.update.map((entry) => [entry.itemId, entry.patch]), [
    ['a', { text: '这里改的' }],
    ['h', { flagged: true }],
  ], 'local edits are pushed')
  equal(merge.pull.map((entry) => [entry.itemId, entry.fields]), [
    ['c', { text: '手机版' }],
    ['d', { done: true }],
    ['g', { notes: '手机备注', due: '2026-12-24', flagged: true, priority: 9 }],
  ], 'phone edits are pulled field by field')
  equal(merge.dropItems.map((entry) => entry.itemId), ['e'], 'a reminder deleted on the phone drops its task')
  equal(merge.importItems.map((entry) => [entry.list, entry.reminderId, entry.task.text]), [['A', 'r-i', '手机新增的']], 'a phone addition is imported with its list')
  equal(merge.create.map((entry) => entry.itemId), ['f'], 'a task with no reminder is created')

  const phoneMove = planMerge(
    [{ id: 'q', text: '被搬了', done: false, list: 'A', reminderId: 'r-q', synced: { text: '被搬了', done: false, list: 'A' } }],
    [mirrorOf('A', []), mirrorOf('B', [{ id: 'r-q', name: '被搬了', completed: false }])],
    [], { now, listOf },
  )
  equal(phoneMove.pull.map((entry) => [entry.itemId, entry.fields.list]), [['q', 'B']], 'a reminder moved on the phone pulls its list')
  equal(phoneMove.dropItems.length, 0, 'and it is not treated as deleted')

  const conflict = planMerge(
    [{ id: 'c', text: '这里改的', done: false, reminderId: 'r-c', synced: { text: '原始', done: false } }],
    [mirrorOf('A', [{ id: 'r-c', name: '手机版', completed: false }])],
    [], { now, listOf },
  )
  equal(conflict.update, [{ itemId: 'c', list: 'A', reminderId: 'r-c', patch: { text: '这里改的' } }], 'a real conflict resolves in DSH favour')
  equal(conflict.pull.length, 0, 'and nothing is pulled over it')

  const cheap = planMerge(
    [{ id: 'g', text: '手机补了日期', done: false, reminderId: 'r-g', synced: { text: '手机补了日期', done: false } }],
    [mirrorOf('A', [{ id: 'r-g', name: '手机补了日期', completed: false, due: '2026-12-24', notes: '手机备注' }])],
    [], { now, listOf, fields: CHEAP_FIELDS },
  )
  equal(cheap.pull.length, 0, 'the cheap poll ignores the expensive fields')

  const multi = planMerge(
    [{ id: 'm', text: '在B列表', done: false, reminderId: 'r-m', synced: { text: '在B列表', done: false }, list: 'B' }],
    [mirrorOf('A', []), mirrorOf('B', [{ id: 'r-m', name: '在B列表', completed: false }])],
    [], { now, listOf },
  )
  equal([multi.update.length, multi.dropItems.length], [0, 0], 'a task is matched inside its own list')

  const tombstoned = planMerge(
    [{ id: 'x', text: '自己删的', done: false }],
    [mirrorOf('A', [{ id: 'r-x', name: '自己删的', completed: false }])],
    [{ reminderId: 'r-x', at: now }], { now, listOf },
  )
  equal(tombstoned.importItems.length, 0, 'a reminder waiting to be deleted is not imported back')
  equal(tombstoned.dropReminders, [{ list: 'A', reminderId: 'r-x' }], 'and it is deleted from the mirror')

  const vanished = planMerge(
    [{ id: 'h', text: '列表没了', done: false, reminderId: 'r-h', synced: { text: '列表没了', done: false } }],
    [{ name: 'A', exists: false, items: [] }],
    [], { now, listOf },
  )
  equal(vanished.dropItems.length, 0, 'a deleted list never deletes tasks')
  equal(vanished.create.map((entry) => entry.itemId), ['h'], 'it rebuilds them instead')

  const racing = planMerge(
    [{ id: 'k', text: '刚建好', done: false, reminderId: 'r-k', synced: { text: '刚建好', done: false }, pushedAt: now }],
    [mirrorOf('A', [])], [], { now, listOf },
  )
  equal(racing.dropItems.length, 0, 'a reminder that may not be indexed yet is not treated as deleted')

  const upgrade = planMerge(
    [{ id: 'u', text: '旧文档', done: false, reminderId: 'r-u' }],
    [mirrorOf('A', [{ id: 'r-u', name: '旧文档', completed: true, notes: '旧备注' }])],
    [], { now, listOf },
  )
  equal(upgrade.pull.map((entry) => entry.fields), [{ done: true, notes: '旧备注' }], 'first contact pulls what the mirror already had')
  equal(upgrade.adopt.length, 1, 'and records a baseline for every field')

  check(FIELDS.includes('dueTime'), 'FIELDS includes dueTime')
  const timedMerge = planMerge(
    [
      { id: 'm1', text: '手机改时间', done: false, due: '2026-12-01', reminderId: 'r-m1', synced: { text: '手机改时间', done: false, due: '2026-12-01' } },
      { id: 'm2', text: '双端改时间', done: false, due: '2026-12-01', dueTime: '09:00', reminderId: 'r-m2', synced: { text: '双端改时间', done: false, due: '2026-12-01', dueTime: '08:00' } },
    ],
    [mirrorOf('A', [
      { id: 'r-m1', name: '手机改时间', completed: false, due: '2026-12-01', dueTime: '15:30' },
      { id: 'r-m2', name: '双端改时间', completed: false, due: '2026-12-01', dueTime: '10:00' },
    ])],
    [], { now, listOf },
  )
  equal(timedMerge.pull.map((entry) => [entry.itemId, entry.fields]), [['m1', { dueTime: '15:30' }]], 'phone dueTime edit is pulled')
  equal(timedMerge.update.map((entry) => [entry.itemId, entry.patch]), [['m2', { dueTime: '09:00' }]], 'dueTime conflict resolves in DSH favour')
  const cheapTimed = planMerge(
    [{ id: 'm1', text: '手机改时间', done: false, due: '2026-12-01', reminderId: 'r-m1', synced: { text: '手机改时间', done: false, due: '2026-12-01' } }],
    [mirrorOf('A', [{ id: 'r-m1', name: '手机改时间', completed: false, due: '2026-12-01', dueTime: '15:30' }])],
    [], { now, listOf, fields: CHEAP_FIELDS },
  )
  equal(cheapTimed.pull.length, 0, 'cheap poll ignores dueTime')
}

// ------------------------------------------------------------------ store ---
async function storeChecks(dir) {
  console.log('store')
  const file = join(dir, 'todos.json')
  const store = new TodoStore(file)
  await store.load()
  equal(store.get().items.length, 0, 'missing file loads as empty')
  await store.commit((draft) => { draft.items.push({ id: 'a', text: '一', done: false }) })
  await store.commit((draft) => { draft.items.push({ id: 'b', text: '二', done: false }) })
  equal(store.get().rev, 2, 'every commit bumps rev')
  const reloaded = await loadState(file)
  equal(reloaded.items.map((item) => item.text), ['一', '二'], 'state round-trips through disk')
  equal(reloaded.version, 4, 'the document is stamped with the current version')

  const full = normalizeState({
    items: [{
      id: 'k', text: '全字段', done: true, createdAt: 1000, due: '2026-12-01', notes: '备注',
      flagged: true, priority: 9, list: 'B', reminderId: 'r-k', synced: { text: '全字段', done: false, due: '2026-12-02' },
    }],
  }).items[0]
  equal([full.due, full.notes, full.flagged, full.priority, full.list], ['2026-12-01', '备注', true, 9, 'B'], 'every field survives normalization')
  equal(full.doneAt, 1000, 'a completed task without a completion time is dated by its creation')
  equal(full.synced, { text: '全字段', done: false, due: '2026-12-02' }, 'the baseline keeps the fields it had')
  equal(normalizeState({ items: [{ id: 'x', text: '坏日期', due: 'tomorrow' }] }).items[0].due, undefined, 'a malformed date is dropped')

  const rich = normalizeState({
    items: [{
      id: 'r1', text: '丰富字段', done: false, due: '2026-12-01', dueTime: '9:05',
      urgent: true, tags: ['#Work', 'work', ' Home '], url: 'https://example.com',
      repeat: 'weekdays', location: 'Arriving Home', parentId: 'r1', section: 'Morning', order: 2,
    }],
    trash: [
      { id: 'tr1', text: '近期删除', deletedAt: Date.now() - 1000, reminderId: 'r-old', synced: { text: '近期删除', done: false } },
      { id: 'tr2', text: '过期删除', deletedAt: Date.now() - TRASH_MS - 1000 },
    ],
    settings: {
      lists: ['工作'],
      listMeta: { 工作: { color: '#0A84FF', icon: '💼', pinned: true, sections: ['上午', '上午', '下午'] } },
    },
  })
  const rItem = rich.items[0]
  equal([rItem.dueTime, rItem.urgent, rItem.tags, rItem.url, rItem.repeat, rItem.location, rItem.parentId, rItem.section, rItem.order],
    ['09:05', true, ['work', 'home'], 'https://example.com', 'weekdays', 'Arriving Home', undefined, 'Morning', 2],
    'new task fields normalize cleanly and self-parentId is dropped')
  equal(rich.trash.map((entry) => entry.id), ['tr1'], 'trash prunes entries older than 30 days')
  equal(rich.trash[0].reminderId, undefined, 'trash strips reminderId mirror binding')
  equal(rich.settings.listMeta['工作'], { color: '#0A84FF', icon: '💼', pinned: true, sections: ['上午', '下午'] }, 'listMeta normalizes and deduplicates sections')
  equal(extractInlineTags('买牛奶 #Groceries #urgent #groceries'), ['groceries', 'urgent'], 'extractInlineTags deduplicates and lowercases')
  equal(nextDueDate('2026-11-20', 'weekdays'), '2026-11-23', 'nextDueDate skips weekends for weekdays repeat')
  equal(nextDueDate('2026-01-31', 'monthly'), '2026-02-28', 'nextDueDate clamps month-end dates')
}

// ------------------------------------------------------------- plugin I/O ---
async function pluginChecks(dir) {
  console.log('plugin')
  const file = join(dir, 'plugin', 'todos.json')
  const world = fakeContext()
  apply(world.ctx, { file, reminders: false })
  await new Promise((resolve) => setTimeout(resolve, 20))

  check(world.tools.has('personal_todos'), 'model tool is registered')
  check(world.routes.has('/api/dsh-apple-reminders/op'), 'panel command route is registered')
  check(world.routes.has('/api/dsh-apple-reminders/events'), 'event stream route is registered')

  const added = await post(world, { op: 'add', text: '写周报' })
  check(added.status === 200 && added.payload.ok === true, 'add succeeds')
  equal(added.payload.state.items.map((item) => item.text), ['写周报'], 'added task is in the state')
  equal(added.payload.state.items[0].list, 'DSH 待办', 'a task records its list')
  equal(added.payload.state.sync.enabled, false, 'mirror reports disabled when reminders: false')
  const id = added.payload.state.items[0].id

  const updated = await post(world, {
    op: 'update',
    id,
    patch: { due: '2026-12-01', notes: '带备注', flagged: true, priority: 5 },
  })
  const row = updated.payload.state.items[0]
  equal([row.due, row.notes, row.flagged, row.priority], ['2026-12-01', '带备注', true, 5], 'update sets every detail field')

  const cleared = await post(world, { op: 'update', id, patch: { due: '', notes: '', flagged: false, priority: 0 } })
  const bare = cleared.payload.state.items[0]
  equal([bare.due, bare.notes, bare.flagged, bare.priority], [undefined, undefined, undefined, undefined], 'an empty update clears the fields')

  const toggled = await post(world, { op: 'toggle', id })
  equal(toggled.payload.state.items[0].done, true, 'toggle marks it done')
  const reopened = await post(world, { op: 'toggle', id })
  equal(reopened.payload.state.items[0].done, false, 'toggle is reversible')

  const empty = await post(world, { op: 'add', text: '   ' })
  check(empty.status === 400 && empty.payload.ok === false, 'empty task is rejected')

  const unknown = await post(world, { op: 'nope' })
  check(unknown.status === 400, 'unknown operation is rejected')

  const removed = await post(world, { op: 'remove', id })
  equal(removed.payload.state.items.length, 0, 'remove drops the task')

  await post(world, { op: 'add', text: '一' })
  await post(world, { op: 'add', text: '二' })
  const before = await post(world, { op: 'list' })
  await post(world, { op: 'toggle', id: before.payload.state.items[0].id })
  const clearedDone = await post(world, { op: 'clear_done' })
  equal(clearedDone.payload.state.items.map((item) => item.text), ['二'], 'clear_done keeps open tasks')

  const frame = await firstFrame(world)
  check(Array.isArray(frame.items) && typeof frame.rev === 'number', 'event stream opens with a snapshot')

  const tool = world.tools.get('personal_todos')
  const result = await tool.execute({ op: 'list' })
  equal(Object.keys(result).sort(), ['items', 'rev', 'sync'], 'tool result matches its schema shape')
  const text = tool.output.render({ op: 'list' }, result)[0].text
  check(text.includes('待办 · 1 项（1 未完成）') && text.includes('[ ] 二'), 'tool renders the list as text')
  check(text.includes('镜像：未启用'), 'tool renders the mirror state')

  const viaTool = await tool.execute({ op: 'add', text: '模型加的', due: '2026-12-31', priority: 9 })
  const addedRow = viaTool.items.find((item) => item.text === '模型加的')
  equal([addedRow.due, addedRow.priority], ['2026-12-31', 9], 'the tool can set details too')

  const reloaded = await loadState(file)
  check(reloaded.items.length === 2, 'commits reached disk')

  const selected = await post(world, { op: 'select', lists: ['X', 'Y'] })
  equal(selected.payload.state.sync.lists, ['X', 'Y'], 'choosing lists persists in the document')
  const reselected = await post(world, { op: 'select', lists: [] })
  equal(reselected.payload.state.sync.lists.length > 0, true, 'an empty selection falls back to the configured list')

  const migrated = await post(world, { op: 'migrate', items: [{ text: '三', done: false }] })
  equal(migrated.payload.state.items.some((item) => item.text === '三'), true, 'migrate merges by text')

  // --- New Apple Reminders parity features ---
  // 1. Rich fields + auto-today for dueTime + subtasks
  const richAdded = await post(world, {
    op: 'add',
    text: '带全量字段',
    dueTime: '09:00',
    urgent: true,
    tags: ['#Work', 'urgent'],
    url: 'https://example.com/spec',
    repeat: 'daily',
    location: 'Arriving Home',
    section: 'Morning',
  })
  const richTask = richAdded.payload.state.items.find((item) => item.text === '带全量字段')
  equal(
    [richTask.due, richTask.dueTime, richTask.urgent, richTask.tags, richTask.url, richTask.repeat, richTask.location, richTask.section],
    [localDateString(), '09:00', true, ['work', 'urgent'], 'https://example.com/spec', 'daily', 'Arriving Home', 'Morning'],
    'add sets all new fields and auto-fills due to today when dueTime is provided',
  )

  const subAdded = await post(world, { op: 'add', text: '子任务', parentId: richTask.id })
  const subTask = subAdded.payload.state.items.find((item) => item.text === '子任务')
  equal([subTask.parentId, subTask.list, subTask.section], [richTask.id, richTask.list, 'Morning'], 'subtask inherits parent list and section')

  // 2. Completing a repeating task spawns next occurrence
  const repAdded = await post(world, {
    op: 'add', text: '每日站会', due: '2026-12-01', dueTime: '09:30', repeat: 'daily', tags: ['standup'], urgent: true,
  })
  const repId = repAdded.payload.state.items.find((item) => item.text === '每日站会').id
  const repToggled = await post(world, { op: 'toggle', id: repId })
  const repCompleted = repToggled.payload.state.items.find((item) => item.id === repId)
  const repSpawned = repToggled.payload.state.items.find((item) => item.id !== repId && item.text === '每日站会')
  equal([repCompleted.done, repCompleted.repeat], [true, undefined], 'toggling a repeating task completes the current instance and clears its repeat')
  equal(
    [repSpawned?.done, repSpawned?.due, repSpawned?.dueTime, repSpawned?.repeat, repSpawned?.urgent, repSpawned?.tags],
    [false, '2026-12-02', '09:30', 'daily', true, ['standup']],
    'and spawns the next open occurrence with advanced due date',
  )

  // 3. Reorder
  const reordered = await post(world, { op: 'reorder', ids: [subTask.id, richTask.id] })
  equal(
    [
      reordered.payload.state.items.find((i) => i.id === subTask.id).order,
      reordered.payload.state.items.find((i) => i.id === richTask.id).order,
    ],
    [0, 1],
    'reorder assigns sequential order indices',
  )

  // 4. Soft-delete to trash, restore, destroy, empty_trash
  const softDel = await post(world, { op: 'remove', id: richTask.id })
  equal(softDel.payload.state.items.some((i) => i.id === richTask.id || i.id === subTask.id), false, 'soft remove deletes parent and subtasks from items')
  equal(softDel.payload.state.trash.some((i) => i.id === richTask.id), true, 'soft remove moves parent into trash')
  equal(softDel.payload.state.trash.some((i) => i.id === subTask.id), true, 'soft remove moves subtasks into trash')
  equal(softDel.payload.state.sync.trashCount, softDel.payload.state.trash.length, 'sync.trashCount matches trash.length')

  const restored = await post(world, { op: 'restore', id: richTask.id })
  equal(restored.payload.state.items.some((i) => i.id === richTask.id), true, 'restore brings parent back to items')
  equal(restored.payload.state.items.some((i) => i.id === subTask.id), true, 'restore brings subtasks back to items')

  await post(world, { op: 'remove', id: richTask.id })
  const destroyed = await post(world, { op: 'destroy', id: richTask.id })
  equal(destroyed.payload.state.trash.some((i) => i.id === richTask.id || i.id === subTask.id), false, 'destroy permanently removes item and subtasks from trash')

  await post(world, { op: 'remove', id: repId })
  const emptied = await post(world, { op: 'empty_trash' })
  equal([emptied.payload.state.trash.length, emptied.payload.state.sync.trashCount], [0, 0], 'empty_trash clears all trash')

  // 5. List management: create_list, update_list (pin/rename/sections), delete_list
  const createdList = await post(world, {
    op: 'create_list', name: '购物单', color: '#30D158', icon: '🛒', pinned: true, sections: ['水果'],
  })
  check(createdList.payload.state.sync.lists.includes('购物单'), 'create_list adds list to sync.lists')
  const metaCreated = createdList.payload.state.sync.listMeta.find((m) => m.name === '购物单')
  equal(metaCreated, { name: '购物单', color: '#30D158', icon: '🛒', pinned: true, sections: ['水果'] }, 'create_list stores listMeta')

  await post(world, { op: 'add', text: '买苹果', list: '购物单', section: '水果' })
  const updatedList = await post(world, {
    op: 'update_list', name: '购物单', newName: '超市清单', pinned: false, addSection: '日用品',
  })
  check(updatedList.payload.state.sync.lists.includes('超市清单') && !updatedList.payload.state.sync.lists.includes('购物单'), 'update_list renames list')
  equal(updatedList.payload.state.items.find((i) => i.text === '买苹果')?.list, '超市清单', 'update_list migrates tasks to renamed list')
  const metaUpdated = updatedList.payload.state.sync.listMeta.find((m) => m.name === '超市清单')
  equal([metaUpdated.pinned, metaUpdated.sections], [undefined, ['水果', '日用品']], 'update_list updates pinned and sections')

  const deletedList = await post(world, { op: 'delete_list', name: '超市清单' })
  check(!deletedList.payload.state.sync.lists.includes('超市清单'), 'delete_list removes list from sync.lists')
  check(deletedList.payload.state.trash.some((i) => i.text === '买苹果'), 'delete_list soft-deletes tasks in that list to trash')

  // 6. Tool schema & new ops via personal_todos
  const toolWithTrash = await tool.execute({ op: 'list', includeTrash: true })
  check(Array.isArray(toolWithTrash.trash) && toolWithTrash.trash.length > 0, 'personal_todos includeTrash returns trash array')
  const toolRich = await tool.execute({
    op: 'add', text: '工具加复杂任务', due: '2026-12-30', dueTime: '18:00', urgent: true, tags: ['tool'], repeat: 'weekly', location: 'Home',
  })
  const toolRichRow = toolRich.items.find((i) => i.text === '工具加复杂任务')
  equal([toolRichRow.dueTime, toolRichRow.urgent, toolRichRow.tags, toolRichRow.repeat, toolRichRow.location],
    ['18:00', true, ['tool'], 'weekly', 'Home'], 'personal_todos supports all new task fields')
  check(tool.output.render({ op: 'list' }, toolRich)[0].text.includes('⏰紧急'), 'tool renderer formats urgent badge')

  return world
}

// ------------------------------------------------------- installed schema ---
/** Run the installed DSH validator over the tool definition, when it is locatable. */
async function schemaChecks(world) {
  console.log('schema (installed validator)')
  const installDir = process.env.DSH_INSTALL_DIR
  if (typeof installDir !== 'string' || installDir === '') {
    console.log('  skip: DSH_INSTALL_DIR is not set')
    return
  }
  let tools
  try {
    tools = await import(pathToFileURL(join(dirname(installDir), 'dsh-tools', 'lib', 'index.js')).href)
  } catch (error) {
    console.log(`  skip: ${String(error).slice(0, 90)}`)
    return
  }
  const definition = world.tools.get('personal_todos')
  try {
    tools.assertObjectJsonSchema(definition.parameters)
    check(true, 'tool parameters pass the installed validator')
  } catch (error) {
    console.log(`       ${String(error).slice(0, 300)}`)
    check(false, 'tool parameters pass the installed validator')
  }
  try {
    tools.assertSupportedJsonSchema(definition.output.schema)
    check(true, 'tool output schema passes the installed validator')
  } catch (error) {
    console.log(`       ${String(error).slice(0, 300)}`)
    check(false, 'tool output schema passes the installed validator')
  }
  const value = await definition.execute({ op: 'list' })
  equal(tools.validateJsonSchemaValue(definition.output.schema, value, ''), [], 'a tool result satisfies its output schema')
  check(definition.output.render({ op: 'list' }, value)[0].text.length > 0, 'the renderer produces text')
}

// ------------------------------------------------------- live Reminders ---
/** @param {string[]} args - osascript arguments. */
async function osa(args) {
  const { stdout } = await run('/usr/bin/osascript', args)
  return stdout.trim()
}

/** @param {string} listName - mirror list. @returns {Promise<object[]>} its reminders, with every field. */
async function mirrorOf(listName) {
  const [list] = await readLists([listName], { detailed: true })
  return list === undefined ? [] : list.items
}

/** Mutate the mirror the way the phone would. @param {string} listName @param {string} script */
async function touchMirror(listName, script) {
  await osa(['-l', 'JavaScript', '-e', `
    const R = Application("Reminders")
    const list = R.lists.byName(${JSON.stringify(listName)})
    ${script}
  `])
}

/** @param {string} listName - delete it if it exists. */
async function dropList(listName) {
  await osa(['-l', 'JavaScript', '-e', `
    const R = Application("Reminders")
    if (R.lists.name().indexOf(${JSON.stringify(listName)}) >= 0) R.lists.byName(${JSON.stringify(listName)}).delete()
  `]).catch(() => {})
}

async function liveChecks(dir) {
  console.log('apple reminders (live)')
  const listA = 'dsh-todo 测试A'
  const listB = 'dsh-todo 测试B'
  const file = join(dir, 'live', 'todos.json')
  await dropList(listA)
  await dropList(listB)

  const world = fakeContext()
  apply(world.ctx, { file, reminders: true, lists: [listA, listB], syncIntervalMs: 3600000, raceWindowMs: 0 })
  await new Promise((resolve) => setTimeout(resolve, 50))

  // Details travel DSH → Reminders.
  const added = await post(world, {
    op: 'add', text: '带细节的任务', due: '2026-12-24', notes: 'DSH 备注', priority: 9, flagged: true,
  })
  const id = added.payload.state.items[0].id
  await post(world, { op: 'sync' })
  const [first] = await mirrorOf(listA)
  equal([first.name, first.due, first.notes, first.priority, first.flagged], ['带细节的任务', '2026-12-24', 'DSH 备注', 9, true], 'details reach the mirror')

  // Details travel Reminders → DSH.
  await touchMirror(listA, `
    const r = list.reminders[0]
    r.dueDate = new Date(2026, 11, 26)
    r.body = "手机备注"
    r.priority = 1
    r.flagged = false
  `)
  const pulled = await post(world, { op: 'sync' })
  const row = pulled.payload.state.items[0]
  equal([row.due, row.notes, row.priority, row.flagged], ['2026-12-26', '手机备注', 1, undefined], 'details come back from the mirror')

  // Completion both ways.
  await post(world, { op: 'toggle', id })
  await post(world, { op: 'sync' })
  equal((await mirrorOf(listA)).map((entry) => entry.completed), [true], 'completing here marks the reminder done')
  await post(world, { op: 'toggle', id })
  await new Promise((resolve) => setTimeout(resolve, 1500))   // let the local change reach the mirror
  await touchMirror(listA, 'list.reminders[0].completed = true')
  const phoneDone = await post(world, { op: 'sync' })
  equal(phoneDone.payload.state.items[0].done, true, 'a phone completion lands here')

  // A second list is mirrored separately.
  const toB = await post(world, { op: 'add', text: '在B里', list: listB })
  const bId = toB.payload.state.items.find((item) => item.text === '在B里').id
  await post(world, { op: 'sync' })
  equal((await mirrorOf(listB)).map((entry) => entry.name), ['在B里'], 'a task goes to the list it was added to')
  equal(toB.payload.state.items.find((item) => item.id === bId).list, listB, 'and it is reported with its list')

  // A task added on the phone in list B comes back with that list.
  await touchMirror(listB, 'list.reminders.push(R.Reminder({ name: "手机上加到B", body: "来自手机" }))')
  const importedB = await post(world, { op: 'sync' })
  const importedRow = importedB.payload.state.items.find((item) => item.text === '手机上加到B')
  equal([importedRow.list, importedRow.notes], [listB, '来自手机'], 'a phone addition keeps its list and notes')

  // Deletions travel both ways.
  await touchMirror(listB, `
    const names = list.reminders.name()
    list.reminders[names.indexOf("手机上加到B")].delete()
  `)
  const droppedB = await post(world, { op: 'sync' })
  equal(droppedB.payload.state.items.some((item) => item.text === '手机上加到B'), false, 'deleting a reminder deletes the task')
  await post(world, { op: 'remove', id: droppedB.payload.state.items[0].id })
  await new Promise((resolve) => setTimeout(resolve, 1500))
  equal((await mirrorOf(listA)).map((entry) => entry.name), [], 'deleting a task removes the reminder')

  // A task changing list takes its reminder with it, both ways.
  const mover = await post(world, { op: 'add', text: '要换列表', list: listA })
  const moverId = mover.payload.state.items.find((item) => item.text === '要换列表').id
  await post(world, { op: 'sync' })
  equal((await mirrorOf(listA)).map((entry) => entry.name), ['要换列表'], 'the task starts in list A')
  await post(world, { op: 'update', id: moverId, patch: { list: listB } })
  await post(world, { op: 'sync' })
  equal((await mirrorOf(listA)).map((entry) => entry.name), [], 'moving it here empties list A')
  equal((await mirrorOf(listB)).map((entry) => entry.name), ['在B里', '要换列表'], 'and fills list B')

  await touchMirror(listB, `
    const names = list.reminders.name()
    const other = R.lists.byName(${JSON.stringify(listA)})
    R.move(list.reminders[names.indexOf("要换列表")], { to: other })
  `)
  const pulledMove = await post(world, { op: 'sync' })
  equal(pulledMove.payload.state.items.find((item) => item.id === moverId).list, listA, 'a phone move changes the task list here')

  await dropList(listA)
  await dropList(listB)
  check(id.length > 0, 'task ids are non-empty')
}

// ------------------------------------------------------------------ main ---
const dir = await mkdtemp(join(tmpdir(), 'dsh-todo-check-'))
try {
  plannerChecks()
  await storeChecks(dir)
  const world = await pluginChecks(dir)
  await schemaChecks(world)
  if (process.env.DSH_TODO_LIVE === '1') {
    if (remindersAvailable()) await liveChecks(dir)
    else console.log('apple reminders (live) — skipped: not available on this Host')
  } else {
    console.log('apple reminders (live) — skipped (set DSH_TODO_LIVE=1)')
  }
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
