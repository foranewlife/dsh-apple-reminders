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
import { mkdir, mkdtemp, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { apply } from '../index.js'
import { emblemFor, emojiFrom, readLists, remindersAvailable } from '../lib/reminders.js'
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

// ----------------------------------------------------------------- icons ---
function iconChecks() {
  console.log('list emblems')
  equal(emojiFrom('{"Emoji" : "👏"}'), '👏', 'Apple\'s JSON emblem becomes its emoji')
  equal(emojiFrom('{"Emoji":"🎯"}'), '🎯', 'compact JSON works too')
  equal(emojiFrom('👏'), '👏', 'a bare emoji passes through')
  equal(emojiFrom('{"Image":"x"}'), '', 'an image emblem shows nothing instead of JSON')
  equal(emojiFrom(''), '', 'an empty emblem stays empty')
  equal(emojiFrom(undefined), '', 'a missing emblem is empty')
  equal(emblemFor('📚'), '{"Emoji" : "📚"}', 'a bare emoji is written in Apple\'s shape')
  equal(emblemFor('{"Emoji" : "👏"}'), '{"Emoji" : "👏"}', 'an Apple emblem is not double-wrapped')
  equal(emblemFor(''), '', 'no emblem stays empty')
  equal(emojiFrom(emblemFor('📚')), '📚', 'what we write reads back as the emoji')
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

  const recentCompletedAt = now - 3 * 86400_000
  const ancientCompletedAt = now - 45 * 86400_000
  const historyMerge = planMerge(
    [],
    [mirrorOf('提醒', [
      { id: 'r-ancient', name: '2024早已完成', completed: true, completedAt: ancientCompletedAt },
      { id: 'r-recent', name: '三天前刚完成', completed: true, completedAt: recentCompletedAt },
      { id: 'r-open', name: '未完成任务', completed: false },
    ])],
    [], { now, listOf },
  )
  equal(
    historyMerge.importItems.map((entry) => [entry.reminderId, entry.task.done, entry.task.completedAt ?? null]),
    [
      ['r-recent', true, recentCompletedAt],
      ['r-open', false, null],
    ],
    'planMerge skips >30d completed reminders on import while importing recent <30d completed reminders with completedAt',
  )
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
      excludedLists: ['归档', ' 归档 ', '旧列表'],
      listMeta: { 工作: { color: '#0A84FF', icon: '💼', pinned: true, sections: ['上午', '上午', '下午'] } },
    },
  })
  const rItem = rich.items[0]
  equal([rItem.dueTime, rItem.urgent, rItem.tags, rItem.url, rItem.repeat, rItem.location, rItem.parentId, rItem.section, rItem.order],
    ['09:05', true, ['work', 'home'], 'https://example.com', 'weekdays', 'Arriving Home', undefined, 'Morning', 2],
    'new task fields normalize cleanly and self-parentId is dropped')
  equal(rich.trash.map((entry) => entry.id), ['tr1'], 'trash prunes entries older than 30 days')
  equal(rich.trash[0].reminderId, undefined, 'trash strips reminderId mirror binding')
  equal(rich.settings.excludedLists, ['归档', '旧列表'], 'excludedLists normalizes and deduplicates')
  equal(rich.settings.listMeta['工作'], { color: '#0A84FF', icon: '💼', pinned: true, sections: ['上午', '下午'] }, 'listMeta normalizes and deduplicates sections')
  equal(extractInlineTags('买牛奶 #Groceries #urgent #groceries'), ['groceries', 'urgent'], 'extractInlineTags deduplicates and lowercases')
  equal(nextDueDate('2026-11-20', 'weekdays'), '2026-11-23', 'nextDueDate skips weekends for weekdays repeat')
  equal(nextDueDate('2026-01-31', 'monthly'), '2026-02-28', 'nextDueDate clamps month-end dates')

  // Cross-process external writes reload cleanly without clobbering
  const sharedFile = join(dir, 'shared-todos.json')
  const storeA = new TodoStore(sharedFile)
  const storeB = new TodoStore(sharedFile)
  await storeA.load()
  await storeB.load()

  let storeBNotifications = 0
  storeB.subscribe(() => { storeBNotifications += 1 })

  await storeA.commit((draft) => {
    draft.settings.lists = ['DSH 待办', '博士答辩']
    draft.items.push({ id: 'ext-1', text: '外部进程新增1', done: false, list: '博士答辩' })
  })
  const didReload = await storeB.reloadIfChanged()
  equal(didReload, true, 'reloadIfChanged detects external write and reloads disk state')
  equal(storeBNotifications, 1, 'reloadIfChanged notifies store subscribers')
  equal(
    [storeB.get().settings.lists, storeB.get().items.map((i) => i.text)],
    [['DSH 待办', '博士答辩'], ['外部进程新增1']],
    'reloaded store sees external lists and items',
  )
  equal(await storeB.reloadIfChanged(), false, 'reloadIfChanged is a no-op when mtime has not changed')

  await new Promise((resolve) => setTimeout(resolve, 15))
  await storeA.commit((draft) => {
    draft.items.push({ id: 'ext-2', text: '外部进程新增2', done: false, list: '博士答辩' })
  })
  // Without calling reloadIfChanged first, storeB.commit must reload disk state before mutating
  await storeB.commit((draft) => {
    draft.items.push({ id: 'loc-1', text: '当前进程写入', done: false, list: 'DSH 待办' })
  })
  const mergedDisk = await loadState(sharedFile)
  equal(
    mergedDisk.items.map((i) => i.text),
    ['外部进程新增1', '外部进程新增2', '当前进程写入'],
    'TodoStore.commit reloads external disk edits before mutating instead of clobbering them',
  )
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

  // 7. op: 'add' (and 'update') targeting a new list name adds it to sync.lists immediately
  const addNewListRes = await post(world, { op: 'add', text: '准备答辩PPT', list: '博士答辩' })
  check(addNewListRes.payload.state.sync.lists.includes('博士答辩'), 'op: add with a new list name adds that list to sync.lists')
  const moveNewListRes = await post(world, {
    op: 'update',
    id: addNewListRes.payload.state.items.find((i) => i.text === '准备答辩PPT').id,
    patch: { list: '论文送审' },
  })
  check(moveNewListRes.payload.state.sync.lists.includes('论文送审'), 'op: update moving task to a new list adds that list to sync.lists')

  // 8. Auto-discovery of new Apple Reminders lists + excludedLists respected + completedAt import
  const autoFile = join(dir, 'auto-discover', 'todos.json')
  const recentDoneTs = Date.now() - 2 * 86400_000
  const ancientDoneTs = Date.now() - 60 * 86400_000
  const mockReminders = new Map([
    ['DSH 待办', { color: '#0A84FF', emblem: '📌', items: [] }],
    ['博士答辩', {
      color: '#FF9F0A',
      emblem: '🎓',
      items: [
        { id: 'rem-1', name: '打印论文定稿', completed: false, due: '2026-12-15', notes: '一式五份', priority: 1, flagged: true },
        { id: 'rem-recent', name: '提交答辩申请', completed: true, completedAt: recentDoneTs },
        { id: 'rem-ancient', name: '2024开题归档', completed: true, completedAt: ancientDoneTs },
      ],
    }],
  ])
  let nextMockRemId = 100
  const mockMirror = {
    listNames: async () => [...mockReminders.keys()],
    listDetails: async () => [...mockReminders.entries()].map(([name, v]) => ({
      name,
      color: v.color ?? '',
      emblem: v.emblem ?? '',
    })),
    readLists: async (names, opts = {}) => names.map((name) => {
      const entry = mockReminders.get(name)
      if (!entry) return { name, exists: false, items: [] }
      const items = entry.items.map((it) => {
        const base = { id: it.id, name: it.name, completed: it.completed === true }
        if (base.completed) base.completedAt = it.completedAt ?? null
        if (opts.detailed) {
          base.notes = it.notes ?? ''
          base.due = it.due ?? null
          base.dueTime = it.dueTime ?? null
          base.flagged = it.flagged === true
          base.priority = it.priority ?? 0
        }
        return base
      })
      return { name, exists: true, items }
    }),
    ensureLists: async (names) => {
      for (const name of names) {
        if (!mockReminders.has(name)) mockReminders.set(name, { color: '', emblem: '', items: [] })
      }
    },
    createList: async (name, opts = {}) => {
      if (!mockReminders.has(name)) {
        mockReminders.set(name, { color: opts.color ?? '', emblem: opts.emblem ?? '', items: [] })
      }
      return true
    },
    updateListMirror: async () => true,
    deleteList: async (name) => mockReminders.delete(name),
    createReminder: async (listName, task) => {
      if (!mockReminders.has(listName)) mockReminders.set(listName, { color: '', emblem: '', items: [] })
      const rid = `rem-gen-${++nextMockRemId}`
      mockReminders.get(listName).items.push({
        id: rid,
        name: task.text,
        completed: task.done === true,
        notes: task.notes ?? '',
        due: task.due ?? null,
        dueTime: task.dueTime ?? null,
        flagged: task.flagged === true,
        priority: task.priority ?? 0,
      })
      return rid
    },
    updateReminder: async (listName, rid, patch) => {
      const entry = mockReminders.get(listName)
      if (!entry) return false
      const idx = entry.items.findIndex((x) => x.id === rid)
      if (idx < 0) return false
      const cur = entry.items[idx]
      if (patch.due === null) {
        const replacedId = `rem-rep-${++nextMockRemId}`
        entry.items.splice(idx, 1, {
          id: replacedId,
          name: typeof patch.text === 'string' ? patch.text : cur.name,
          completed: typeof patch.done === 'boolean' ? patch.done : cur.completed,
          notes: typeof patch.notes === 'string' ? patch.notes : (cur.notes ?? ''),
          due: null,
          dueTime: null,
          flagged: typeof patch.flagged === 'boolean' ? patch.flagged : (cur.flagged === true),
          priority: typeof patch.priority === 'number' ? patch.priority : (cur.priority ?? 0),
        })
        return replacedId
      }
      if (typeof patch.text === 'string') cur.name = patch.text
      if (typeof patch.done === 'boolean') cur.completed = patch.done
      if (typeof patch.notes === 'string') cur.notes = patch.notes
      if (typeof patch.due === 'string') cur.due = patch.due
      if ('dueTime' in patch) cur.dueTime = patch.dueTime
      if (typeof patch.flagged === 'boolean') cur.flagged = patch.flagged
      if (typeof patch.priority === 'number') cur.priority = patch.priority
      return true
    },
    deleteReminder: async (listName, rid) => {
      const entry = mockReminders.get(listName)
      if (!entry) return false
      entry.items = entry.items.filter((x) => x.id !== rid)
      return true
    },
    moveReminder: async () => true,
  }

  const autoWorld = fakeContext()
  apply(autoWorld.ctx, { file: autoFile, mirror: mockMirror, syncIntervalMs: 3600000 })
  await new Promise((resolve) => setTimeout(resolve, 20))

  const synced1 = await post(autoWorld, { op: 'sync' })
  equal(synced1.payload.state.sync.lists, ['DSH 待办', '博士答辩'], 'auto-discovery adds new Reminders list to sync.lists')
  const discoveredMeta = synced1.payload.state.sync.listMeta.find((m) => m.name === '博士答辩')
  equal([discoveredMeta?.color, discoveredMeta?.icon], ['#FF9F0A', '🎓'], 'auto-discovery fetches list color and icon')
  const importedOpen = synced1.payload.state.items.find((i) => i.text === '打印论文定稿')
  equal([importedOpen?.list, importedOpen?.due, importedOpen?.priority, importedOpen?.flagged], ['博士答辩', '2026-12-15', 1, true], 'auto-discovered list imports open tasks with full details')
  const importedRecent = synced1.payload.state.items.find((i) => i.text === '提交答辩申请')
  equal([importedRecent?.done, importedRecent?.doneAt], [true, recentDoneTs], 'recent <30d completed reminder imports with its original completedAt')
  equal(synced1.payload.state.items.some((i) => i.text === '2024开题归档'), false, 'ancient >30d completed reminder is NOT imported into todos.json')

  // Uncheck '博士答辩' via op: 'select' -> persisted in excludedLists and not re-discovered
  await post(autoWorld, { op: 'select', lists: ['DSH 待办'] })
  const diskAfterSelect = await loadState(autoFile)
  equal(diskAfterSelect.settings.excludedLists, ['博士答辩'], 'unchecking a list in op: select saves it in settings.excludedLists')

  // Add a third list '组会安排' in Reminders and sync again
  mockReminders.set('组会安排', {
    color: '#30D158',
    emblem: '📅',
    items: [{ id: 'rem-meet', name: '周三汇报', completed: false }],
  })
  const synced2 = await post(autoWorld, { op: 'sync' })
  equal(
    synced2.payload.state.sync.lists,
    ['DSH 待办', '组会安排'],
    'mergePass skips excludedLists ("博士答辩") while still auto-discovering brand-new lists ("组会安排")',
  )

  // Deleting a list locally without deleteReminders adds it to excludedLists so mergePass does not re-add it
  await post(autoWorld, { op: 'delete_list', name: '组会安排' })
  const synced3 = await post(autoWorld, { op: 'sync' })
  equal(
    synced3.payload.state.sync.lists,
    ['DSH 待办'],
    'delete_list without deleteReminders excludes the list from future auto-discovery',
  )

  // 9. Clearing due date (patch.due === null) replaces reminder in place, updates reminderId, and tombstones old id
  const dueClearAdd = await post(autoWorld, {
    op: 'add',
    text: '待清除日期任务',
    list: 'DSH 待办',
    due: '2026-12-20',
    dueTime: '14:00',
    notes: '保留备注',
  })
  const dueClearTaskId = dueClearAdd.payload.state.items.find((i) => i.text === '待清除日期任务').id
  await post(autoWorld, { op: 'sync' })
  const diskBeforeClear = await loadState(autoFile)
  const oldRemId = diskBeforeClear.items.find((i) => i.id === dueClearTaskId).reminderId
  check(typeof oldRemId === 'string' && oldRemId.startsWith('rem-gen-'), 'dated task receives initial reminderId')

  await post(autoWorld, { op: 'update', id: dueClearTaskId, patch: { due: '' } })
  // Wait for debounced pushPass or run sync directly: test pushUpdate replacement + tombstone recording
  await new Promise((resolve) => setTimeout(resolve, 750))
  const diskAfterPushClear = await loadState(autoFile)
  const itemAfterPushClear = diskAfterPushClear.items.find((i) => i.id === dueClearTaskId)
  check(
    typeof itemAfterPushClear.reminderId === 'string' && itemAfterPushClear.reminderId.startsWith('rem-rep-') && itemAfterPushClear.reminderId !== oldRemId,
    'pushUpdate updates item.reminderId to replacement id when clearing due',
  )
  check(
    diskAfterPushClear.tombstones.some((t) => t.reminderId === oldRemId),
    'pushUpdate records replaced old reminderId in tombstones',
  )
  const syncedAfterClear = await post(autoWorld, { op: 'sync' })
  const clearedView = syncedAfterClear.payload.state.items.find((i) => i.id === dueClearTaskId)
  equal(
    [clearedView.due, clearedView.dueTime, clearedView.notes],
    [undefined, undefined, '保留备注'],
    'cleared due stays undefined after sync while preserving notes',
  )

  // 10. Cross-process op: 'list' reload & .synclock serialization + stale lock breaking
  const lockFile = join(dir, 'cross-proc-lock', 'todos.json')
  let activeSyncPasses = 0
  let maxConcurrentSyncPasses = 0
  const lockMirror = {
    ...mockMirror,
    listNames: async () => ['DSH 待办'],
    listDetails: async () => [{ name: 'DSH 待办', color: '#0A84FF', emblem: '📌' }],
    readLists: async (names) => {
      activeSyncPasses += 1
      if (activeSyncPasses > maxConcurrentSyncPasses) maxConcurrentSyncPasses = activeSyncPasses
      await new Promise((resolve) => setTimeout(resolve, 180))
      activeSyncPasses -= 1
      return names.map((name) => ({ name, exists: true, items: [] }))
    },
    createReminder: async (_listName, _task) => `rem-lock-${++nextMockRemId}`,
    updateReminder: async () => true,
    deleteReminder: async () => true,
  }
  const procA = fakeContext()
  const procB = fakeContext()
  apply(procA.ctx, { file: lockFile, lists: ['DSH 待办'], mirror: lockMirror, syncIntervalMs: 3600000 })
  apply(procB.ctx, { file: lockFile, lists: ['DSH 待办'], mirror: lockMirror, syncIntervalMs: 3600000 })
  await new Promise((resolve) => setTimeout(resolve, 30))

  await post(procA, { op: 'add', text: '进程A任务' })
  // Immediately query procB via op: 'list' before fs.watch debounce (120ms) fires
  const procBList = await post(procB, { op: 'list' })
  equal(
    procBList.payload.state.items.map((i) => i.text),
    ['进程A任务'],
    'op: list reloads freshest disk state immediately across processes',
  )

  // Plant a stale (>90s) .synclock directory and run concurrent sync passes from procA and procB
  const staleLockDir = `${lockFile}.synclock`
  await mkdir(staleLockDir, { recursive: true })
  const staleTime = new Date(Date.now() - 120_000)
  await utimes(staleLockDir, staleTime, staleTime)

  await post(procB, { op: 'add', text: '进程B任务' })
  const [resSyncA, resSyncB] = await Promise.all([
    post(procA, { op: 'sync' }),
    post(procB, { op: 'sync' }),
  ])
  check(resSyncA.payload.ok === true && resSyncB.payload.ok === true, 'concurrent cross-process syncs both succeed after breaking stale lock')
  equal(maxConcurrentSyncPasses, 1, '.synclock serializes concurrent sync passes across instances')
  const finalLockDisk = await loadState(lockFile)
  equal(
    finalLockDisk.items.map((i) => i.text),
    ['进程A任务', '进程B任务'],
    'serialized cross-process syncs preserve items from both processes without clobbering',
  )
  let lockStillExists = true
  try {
    await stat(staleLockDir)
  } catch {
    lockStillExists = false
  }
  equal(lockStillExists, false, '.synclock directory is cleaned up after sync passes complete')

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

  // Details travel DSH → Reminders (including all-day due date without fabricating 00:00 dueTime).
  const added = await post(world, {
    op: 'add', text: '带细节的任务', due: '2026-12-24', notes: 'DSH 备注', priority: 9, flagged: true,
  })
  const id = added.payload.state.items[0].id
  const firstSynced = await post(world, { op: 'sync' })
  const [first] = await mirrorOf(listA)
  equal(
    [first.name, first.due, first.dueTime, first.notes, first.priority, first.flagged],
    ['带细节的任务', '2026-12-24', null, 'DSH 备注', 9, true],
    'all-day details reach the mirror without fabricating dueTime',
  )
  equal(firstSynced.payload.state.items[0].dueTime, undefined, 'all-day reminder keeps dueTime undefined in DSH')

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

  // Regression: adding an open timed task into a list that ALREADY contains a completed reminder
  // must NOT overwrite the completed reminder or orphan a duplicate, and clearing due: '' must stick.
  await post(world, { op: 'remove', id: moverId })
  await post(world, { op: 'sync' })
  equal((await mirrorOf(listA)).length, 0, 'list A is empty before completed+open regression check')

  const doneFirst = await post(world, {
    op: 'add',
    text: '和李东东说235续费问题',
    list: listA,
    done: true,
    notes: '已完成旧备注',
  })
  const doneFirstId = doneFirst.payload.state.items.find((item) => item.text === '和李东东说235续费问题').id
  await post(world, { op: 'sync' })

  const openSecond = await post(world, {
    op: 'add',
    text: '新增待办测试',
    list: listA,
    due: '2026-11-21',
    dueTime: '15:00',
    notes: '新任务备注',
  })
  const openSecondId = openSecond.payload.state.items.find((item) => item.text === '新增待办测试').id
  await post(world, { op: 'sync' })
  const regSynced = await post(world, { op: 'sync' })

  const doneRowAfter = regSynced.payload.state.items.find((item) => item.id === doneFirstId)
  const openRowAfter = regSynced.payload.state.items.find((item) => item.id === openSecondId)
  equal(
    [doneRowAfter?.text, doneRowAfter?.done, doneRowAfter?.due, doneRowAfter?.dueTime, doneRowAfter?.notes],
    ['和李东东说235续费问题', true, undefined, undefined, '已完成旧备注'],
    'existing completed task in listA is NOT overwritten when adding a new open task',
  )
  equal(
    [openRowAfter?.text, openRowAfter?.done, openRowAfter?.due, openRowAfter?.dueTime, openRowAfter?.notes],
    ['新增待办测试', false, '2026-11-21', '15:00', '新任务备注'],
    'new open task in listA keeps its exact due, dueTime, and notes',
  )
  const mirrorItemsA = await mirrorOf(listA)
  equal(mirrorItemsA.length, 2, 'listA has exact 2 reminders without orphaned duplicates')
  const mirrorDone = mirrorItemsA.find((entry) => entry.name === '和李东东说235续费问题')
  const mirrorOpen = mirrorItemsA.find((entry) => entry.name === '新增待办测试')
  equal(
    [mirrorDone?.completed, mirrorDone?.due, mirrorDone?.notes],
    [true, null, '已完成旧备注'],
    'completed reminder in Apple Reminders kept its own completed state, null due, and notes',
  )
  equal(
    [mirrorOpen?.completed, mirrorOpen?.due, mirrorOpen?.dueTime, mirrorOpen?.notes],
    [false, '2026-11-21', '15:00', '新任务备注'],
    'open reminder in Apple Reminders received its exact due, dueTime, and notes',
  )

  // Clearing due: '' on that task replaces in place and keeps due undefined across syncs.
  await post(world, { op: 'update', id: openSecondId, patch: { due: '' } })
  await post(world, { op: 'sync' })
  const afterDueCleared = await post(world, { op: 'sync' })
  const openClearedRow = afterDueCleared.payload.state.items.find((item) => item.id === openSecondId)
  equal(
    [openClearedRow?.due, openClearedRow?.dueTime, openClearedRow?.notes],
    [undefined, undefined, '新任务备注'],
    'clearing due: "" keeps due and dueTime undefined after live Apple Reminders sync',
  )
  const mirrorAfterClear = await mirrorOf(listA)
  const mirrorOpenCleared = mirrorAfterClear.find((entry) => entry.name === '新增待办测试')
  equal(
    [mirrorAfterClear.length, mirrorOpenCleared?.due, mirrorOpenCleared?.dueTime, mirrorOpenCleared?.notes],
    [2, null, null, '新任务备注'],
    'Apple Reminders mirror cleared due/dueTime cleanly via replace-in-place without leaving duplicates',
  )

  await dropList(listA)
  await dropList(listB)
  check(id.length > 0, 'task ids are non-empty')
}

// ------------------------------------------------------------------ main ---
const dir = await mkdtemp(join(tmpdir(), 'dsh-todo-check-'))
try {
  iconChecks()
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
