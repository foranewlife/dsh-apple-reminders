/**
 * Render checks for the browser half: load the bundle, register it against a
 * stub context, then render the panel in every state it can be in.
 *
 *   node test/render-check.mjs
 *
 * This catches the class of bug that blanks the sidebar entry: a component that
 * throws while rendering. It runs in CI next to the Host checks.
 */
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const BUNDLE = new URL('../client.js', import.meta.url)

let failures = 0
/** @param {boolean} ok @param {string} label - what was checked. */
function check(ok, label) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) failures += 1
}

/** @param {string} actual @param {string} expected @param {string} label */
function includes(actual, expected, label) {
  const ok = typeof actual === 'string' && actual.includes(expected)
  if (!ok) console.log(`       expected to contain ${JSON.stringify(expected)}`)
  check(ok, label)
}

/** Collect every string inside the rendered tree. @param {unknown} node @returns {string} */
function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node === 'object' && Array.isArray(node.children)) return textOf(node.children)
  return ''
}

let captured = null
let component = null
let seeded = []
let hookIndex = 0

/** A React stand-in: hooks read from `seeded` so a state can be rendered directly. */
function makeReact() {
  return {
    createElement: (type, props, ...children) => (typeof type === 'function'
      ? type(props ?? {})
      : { type, props: props ?? {}, children: children.flat(Infinity) }),
    useState: (initial) => {
      const value = hookIndex < seeded.length ? seeded[hookIndex] : (typeof initial === 'function' ? initial() : initial)
      hookIndex += 1
      return [value, () => {}]
    },
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value ?? null }),
    memo: (fn) => fn,
  }
}

const sandbox = {
  console,
  URL,
  window: {
    __ModuleLoader__: { load: (mod) => { captured = mod } },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    requestAnimationFrame: () => 0,
  },
  document: {
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: 'visible',
    activeElement: null,
    body: null,
    baseURI: 'http://127.0.0.1/',
  },
  EventSource: class { close() {} },
  fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
  AbortSignal: { timeout: () => undefined },
}
sandbox.window.window = sandbox.window
sandbox.window.document = sandbox.document
sandbox.window.fetch = sandbox.fetch
sandbox.window.EventSource = sandbox.EventSource
sandbox.window.setTimeout = sandbox.window.setTimeout

console.log('bundle')
const code = await readFile(BUNDLE, 'utf8')
vm.runInNewContext(code, sandbox, { filename: 'client.js' })
check(captured !== null, 'the bundle registers itself with the module loader')
check(captured?.id === 'dsh-apple-reminders', 'it registers under the package id')
check(typeof captured?.factory === 'function', 'it exposes a lazy factory')

const registered = { types: [], slots: [] }
const ctx = {
  effect: (fn) => { fn(); return () => {} },
  inject: (_deps, fn) => { fn(ctx); return () => {} },
  locale: { register: () => () => {}, bind: () => (key) => key },
  sidebarRightTabs: {
    register: (definition) => { registered.types.push(definition); return () => {} },
  },
  slots: {
    inject: (_name, fn) => { fn(); return () => {} },
    register: (options, value) => { registered.slots.push(options); component = value; return () => {} },
  },
  sidebarRight: {
    commandTarget: () => undefined,
    openTabs: { getSnapshot: () => [] },
    close: () => {},
    mounted: { subscribe: () => () => {} },
  },
  shortcuts: { register: () => () => {} },
}

const factory = captured.factory(() => makeReact())
try {
  factory.apply(ctx)
  check(true, 'apply() registers without throwing')
} catch (error) {
  console.log(`       ${String(error?.stack ?? error).slice(0, 400)}`)
  check(false, 'apply() registers without throwing')
}
check(registered.types.length === 1 && registered.types[0].kind === 'todo', 'it registers one tab type of kind todo')
check(registered.types[0]?.guide?.length === 1, 'the tab type contributes a guide card')
check(registered.slots.length === 1 && registered.slots[0].name === 'sidebar.right.pane.tab', 'it registers the tab body')
check(typeof component === 'function', 'the body is a component')

console.log('render')
const items = [
  { id: 'a', text: '写周报', done: false, list: 'DSH 待办', due: '2026-12-24', priority: 5, notes: '备注' },
  { id: 'b', text: '买电池', done: false, list: '愿望', flagged: true },
  { id: 'c', text: '旧任务', done: true, list: 'SMART' },
]
const sync = {
  enabled: true,
  status: 'idle',
  listName: 'DSH 待办',
  lists: ['SMART', '愿望', 'DSH 待办'],
  listColors: ['#E5594F', '#6277BA', '#4C6C9E'],
  lastSyncAt: Date.now(),
  available: ['SMART', '愿望', 'DSH 待办', '提醒'],
}

/** @param {unknown[]} state - fifteen hook values, in the component's order. */
function render(state) {
  seeded = state
  hookIndex = 0
  try {
    return { tree: component({ t: (key) => key }) }
  } catch (error) {
    return { error }
  }
}

const states = {
  loaded: [items, sync, 'ready', false, '', '', '草稿', null, false, {}, 'all', null, '', 0, false],
  'completed view': [items, sync, 'ready', false, '', '', '', null, false, {}, 'completed', null, '', 0, false],
  'today view': [items, sync, 'ready', false, '', '', '', null, false, {}, 'today', null, '', 0, false],
  'one list': [items, { ...sync, lists: ['DSH 待办'], listColors: ['#4C6C9E'] }, 'ready', false, '', '', '', null, false, {}, 'all', null, '', 0, false],
  'empty list': [[], sync, 'ready', false, '', '', '', null, false, {}, 'all', null, '', 0, false],
  'mirror off': [items, { enabled: false, status: 'off', listName: 'DSH 待办', lists: ['DSH 待办'] }, 'ready', false, '', '', '', null, false, {}, 'all', null, '', 0, false],
  'sync failed': [items, { ...sync, status: 'error', error: 'boom' }, 'ready', false, '', '', '', null, false, {}, 'all', null, '', 0, false],
  'operation failed': [items, sync, 'ready', false, '', 'nope', '', null, false, {}, 'all', null, '', 0, false],
  loading: [[], null, 'loading', true, '', '', '', null, false, {}, 'all', null, '', 0, false],
  failed: [[], null, 'failed', false, 'HTTP 404', '', '', null, false, {}, 'all', null, '', 0, false],
}

for (const [label, state] of Object.entries(states)) {
  const { tree, error } = render(state)
  if (error !== undefined) {
    console.log(`       ${String(error?.message ?? error).slice(0, 300)}`)
    check(false, `renders "${label}"`)
    continue
  }
  check(typeof tree?.type === 'string', `renders "${label}"`)
}

const loaded = textOf(render(states.loaded).tree)
includes(loaded, '写周报', 'the loaded panel lists the tasks')
includes(loaded, 'DSH 待办', 'it groups by list')
includes(loaded, '愿望', 'every configured list gets a row')
includes(loaded, '12-24', 'a due date is shown')
includes(loaded, 'priority.5', 'a priority is shown')
check(!loaded.includes('旧任务'), 'completed tasks stay hidden by default')

const shown = textOf(render(states['completed view']).tree)
includes(shown, '旧任务', 'the completed view lists finished tasks')
includes(shown, 'view.completed', 'and titles itself Completed')

const titles = textOf(render(states.loaded).tree)
includes(titles, 'view.all', 'the title names the current view')
includes(titles, 'view.today', 'the smart lists are shown')
includes(titles, 'view.flagged', 'including the flag smart list')
includes(titles, 'sync.now', 'the sync control is visible')

const failed = textOf(render(states.failed).tree)
includes(failed, 'load.failed', 'a read failure is reported')
includes(failed, 'load.retry', 'with a retry action')

console.log(failures === 0 ? '\nall render checks passed' : `\n${failures} render check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
