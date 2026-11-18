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
let stateUpdates = []

/** Find the first element in the rendered tree matching `predicate`. */
function findNode(node, predicate) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findNode(child, predicate)
      if (hit) return hit
    }
    return null
  }
  if (predicate(node)) return node
  if (Array.isArray(node.children)) return findNode(node.children, predicate)
  return null
}

/** A React stand-in: hooks read from `seeded` so a state can be rendered directly. */
function makeReact() {
  return {
    createElement: (type, props, ...children) => (typeof type === 'function'
      ? type(props ?? {})
      : { type, props: props ?? {}, children: children.flat(Infinity) }),
    useState: (initial) => {
      const idx = hookIndex
      const value = idx < seeded.length ? seeded[idx] : (typeof initial === 'function' ? initial() : initial)
      hookIndex += 1
      return [value, (next) => { stateUpdates.push({ idx, next }) }]
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
const todayStr = (() => {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
})()

const items = [
  { id: 'a', text: '写周报', done: false, list: 'DSH 待办', due: '2026-12-24', priority: 5, notes: '备注', tags: ['work'] },
  { id: 'b', text: '买电池', done: false, list: '愿望', flagged: true, urgent: true, due: todayStr, dueTime: '09:00' },
  { id: 'c', text: '旧任务', done: true, list: 'SMART' },
  { id: 'd', text: '子任务', done: false, list: 'DSH 待办', parentId: 'a', section: '分组A' },
]
const trash = [
  { id: 'tr1', text: '已删任务', done: false, list: 'DSH 待办', deletedAt: Date.now() },
]
const sync = {
  enabled: true,
  status: 'idle',
  listName: 'DSH 待办',
  lists: ['SMART', '愿望', 'DSH 待办'],
  listColors: ['#E5594F', '#6277BA', '#4C6C9E'],
  listMeta: [
    { name: 'SMART', color: '#E5594F', pinned: true },
    { name: '愿望', color: '#6277BA' },
    { name: 'DSH 待办', color: '#4C6C9E', sections: ['分组A'] },
  ],
  trashCount: trash.length,
  lastSyncAt: Date.now(),
  available: ['SMART', '愿望', 'DSH 待办', '提醒'],
}

/** Build the 16-hook state tuple for TodoPanel (indices 0..15). */
function makeState(overrides = {}) {
  return [
    overrides.items ?? items,                   // 0: items
    overrides.trash ?? trash,                   // 1: trash
    overrides.sync !== undefined ? overrides.sync : sync, // 2: sync
    overrides.phase ?? 'ready',                 // 3: phase
    overrides.slow ?? false,                    // 4: slow
    overrides.loadError ?? '',                  // 5: loadError
    overrides.opError ?? '',                    // 6: opError
    overrides.view ?? 'all',                    // 7: view
    overrides.sidebarOpen ?? true,              // 8: sidebarOpen
    overrides.search ?? '',                     // 9: search
    overrides.collapsed ?? {},                  // 10: collapsed
    overrides.showCompletedMap ?? {},           // 11: showCompletedMap
    overrides.editorState ?? null,              // 12: editorState
    overrides.popover ?? null,                  // 13: popover
    overrides.armed ?? '',                      // 14: armed
    overrides.groceriesDismissed ?? false,      // 15: groceriesDismissed
  ]
}

const sampleEditor = {
  mode: 'edit',
  id: 'a',
  text: '写周报',
  notes: '备注',
  tagInput: '',
  tags: ['work'],
  due: todayStr,
  dueTime: '09:00',
  urgent: true,
  repeat: 'daily',
  location: 'Arriving Home',
  flagged: true,
  url: 'https://example.com',
  priority: 1,
  list: 'DSH 待办',
  section: '',
  parentId: '',
  subtaskDraft: '',
}

/** @param {unknown[]} state - sixteen hook values, in the component's order. */
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
  loaded: makeState({ view: 'all' }),
  'today view': makeState({ view: 'today' }),
  'planned view': makeState({ view: 'planned' }),
  'flagged view': makeState({ view: 'flagged' }),
  'urgent view': makeState({ view: 'urgent' }),
  'completed view': makeState({ view: 'completed' }),
  'trash view': makeState({ view: 'trash' }),
  'single list view': makeState({ view: 'list:DSH 待办' }),
  'tag view': makeState({ view: 'tag:work' }),
  'search active': makeState({ view: 'all', search: '周报' }),
  'inline editor': makeState({ view: 'all', editorState: sampleEditor }),
  'inspector open': makeState({ view: 'all', editorState: sampleEditor, popover: { kind: 'inspector' } }),
  'one list': makeState({ view: 'all', sync: { ...sync, lists: ['DSH 待办'], listColors: ['#4C6C9E'] } }),
  'empty list': makeState({ view: 'all', items: [], trash: [] }),
  'mirror off': makeState({ view: 'all', sync: { enabled: false, status: 'off', listName: 'DSH 待办', lists: ['DSH 待办'], listColors: [], listMeta: [], trashCount: 0 } }),
  'syncing': makeState({ view: 'all', sync: { ...sync, status: 'syncing' } }),
  'sync failed': makeState({ view: 'all', sync: { ...sync, status: 'error', error: 'boom' } }),
  'sidebar closed': makeState({ view: 'all', sidebarOpen: false }),
  'operation failed': makeState({ view: 'all', opError: 'nope' }),
  loading: makeState({ items: [], trash: [], sync: null, phase: 'loading', slow: true }),
  failed: makeState({ items: [], trash: [], sync: null, phase: 'failed', loadError: 'HTTP 404' }),
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

const todayText = textOf(render(states['today view']).tree)
includes(todayText, 'section.morning', 'today view renders Morning section')
includes(todayText, 'section.afternoon', 'today view renders Afternoon section')
includes(todayText, 'section.tonight', 'today view renders Tonight section')

const plannedText = textOf(render(states['planned view']).tree)
includes(plannedText, 'view.planned', 'planned view renders Scheduled header')
includes(plannedText, 'section.later', 'planned view renders Later bucket')

const urgentText = textOf(render(states['urgent view']).tree)
includes(urgentText, '买电池', 'urgent view lists urgent tasks')
includes(urgentText, 'view.urgent', 'urgent view titles itself Urgent')

const shown = textOf(render(states['completed view']).tree)
includes(shown, '旧任务', 'the completed view lists finished tasks')
includes(shown, 'view.completed', 'and titles itself Completed')

const trashText = textOf(render(states['trash view']).tree)
includes(trashText, '已删任务', 'trash view lists soft-deleted tasks')
includes(trashText, 'trash.recoverAll', 'trash view shows recover all action')
includes(trashText, 'trash.empty', 'trash view shows empty trash action')

const tagText = textOf(render(states['tag view']).tree)
includes(tagText, '#work', 'tag view shows #tag header')
includes(tagText, '写周报', 'tag view lists matching tagged tasks')

const searchText = textOf(render(states['search active']).tree)
includes(searchText, 'search.results', 'search active shows search results header')
includes(searchText, '写周报', 'search active matches task text')

const editorText = textOf(render(states['inline editor']).tree)
includes(editorText, 'editor.date.today', 'inline editor shows today date pill')
includes(editorText, '09:00', 'inline editor shows time pill')

const inspectorText = textOf(render(states['inspector open']).tree)
includes(inspectorText, 'editor.url', 'inspector shows URL field')
includes(inspectorText, 'editor.priority', 'inspector shows Priority field')

const titles = textOf(render(states.loaded).tree)
includes(titles, 'view.all', 'the title names the current view')
includes(titles, 'view.today', 'the smart lists are shown')
includes(titles, 'view.flagged', 'including the flag smart list')
includes(titles, 'view.urgent', 'including the urgent smart list')
includes(titles, 'view.trash', 'including Recently Deleted in sidebar')
includes(titles, 'sync.now', 'the sync control is visible')

const failed = textOf(render(states.failed).tree)
includes(failed, 'load.failed', 'a read failure is reported')
includes(failed, 'load.retry', 'with a retry action')

// Interactive section-header draft creation & blur-to-cancel checks
const todayTree = render(states['today view']).tree
const morningHeadBtn = findNode(todayTree, (n) => n.type === 'button' && n.props?.className === 'ar-section-title-btn' && textOf(n).includes('section.morning'))
const afternoonHeadBtn = findNode(todayTree, (n) => n.type === 'button' && n.props?.className === 'ar-section-title-btn' && textOf(n).includes('section.afternoon'))
const tonightHeadBtn = findNode(todayTree, (n) => n.type === 'button' && n.props?.className === 'ar-section-title-btn' && textOf(n).includes('section.tonight'))
check(typeof morningHeadBtn?.props?.onClick === 'function', 'today Morning header button has onClick')
check(typeof afternoonHeadBtn?.props?.onClick === 'function', 'today Afternoon header button has onClick')
check(typeof tonightHeadBtn?.props?.onClick === 'function', 'today Tonight header button has onClick')

stateUpdates = []
morningHeadBtn.props.onClick()
const morningDraft = stateUpdates.find((u) => u.idx === 12)?.next
check(morningDraft?.mode === 'new' && morningDraft?.dueTime === '09:00', 'clicking Morning header opens new 09:00 draft')

stateUpdates = []
afternoonHeadBtn.props.onClick()
const afternoonDraft = stateUpdates.find((u) => u.idx === 12)?.next
check(afternoonDraft?.mode === 'new' && afternoonDraft?.dueTime === '15:00', 'clicking Afternoon header opens new 15:00 draft')

stateUpdates = []
tonightHeadBtn.props.onClick()
const tonightDraft = stateUpdates.find((u) => u.idx === 12)?.next
check(tonightDraft?.mode === 'new' && tonightDraft?.dueTime === '20:00', 'clicking Tonight header opens new 20:00 draft')

const plannedTree = render(states['planned view']).tree
const tomorrowHeadBtn = findNode(plannedTree, (n) => n.type === 'button' && n.props?.className === 'ar-section-title-btn' && textOf(n).includes('section.tomorrow'))
check(typeof tomorrowHeadBtn?.props?.onClick === 'function', 'planned Tomorrow header button has onClick')
stateUpdates = []
tomorrowHeadBtn.props.onClick()
const tomorrowDraft = stateUpdates.find((u) => u.idx === 12)?.next
check(tomorrowDraft?.mode === 'new' && typeof tomorrowDraft?.due === 'string' && tomorrowDraft.due !== '', 'clicking Scheduled Tomorrow header opens dated draft')

const blankTodayDraft = {
  ...sampleEditor,
  mode: 'new',
  id: undefined,
  text: '',
  notes: '',
  tags: [],
  due: todayStr,
  dueTime: '09:00',
}
const draftTree = render(makeState({ view: 'today', editorState: blankTodayDraft })).tree
const editorNode = findNode(draftTree, (n) => n.type === 'li' && n.props?.['data-ar-editor'] === 'new')
check(typeof editorNode?.props?.onBlur === 'function', 'inline editor li[data-ar-editor] has onBlur handler')
check(typeof editorNode?.props?.onMouseDown === 'function', 'inline editor li[data-ar-editor] has onMouseDown handler')

const origSetTimeout = sandbox.window.setTimeout
sandbox.window.setTimeout = (fn) => { fn(); return 1 }
stateUpdates = []
let blurThrew = false
try {
  editorNode.props.onBlur()
} catch {
  blurThrew = true
} finally {
  sandbox.window.setTimeout = origSetTimeout
}
check(!blurThrew, 'inline editor onBlur does not throw when document.activeElement is null')
check(stateUpdates.some((u) => u.idx === 12 && u.next === null), 'inline editor onBlur cancels empty new draft')

// Top toolbar anti-overlap, motion keyframes, and sidebar closed state
const loadedTree = render(states.loaded).tree
const styleNode = findNode(loadedTree, (n) => n.type === 'style')
const cssText = textOf(styleNode)
check(Boolean(styleNode), 'injected <style> element is present')
includes(cssText, '.ar-main-top-left {\n  flex: 0 0 auto;', 'CSS sets .ar-main-top-left flex: 0 0 auto')
includes(cssText, '.ar-main-top-right {', 'CSS defines .ar-main-top-right')
includes(cssText, 'min-width: 0;', 'CSS includes min-width: 0 for toolbar flex shrinking')
includes(cssText, '@keyframes arCheckPop', 'CSS includes @keyframes arCheckPop')
includes(cssText, '@keyframes arEditorIn', 'CSS includes @keyframes arEditorIn')
includes(cssText, '@keyframes arPopoverIn', 'CSS includes @keyframes arPopoverIn')
includes(cssText, '@keyframes arSpin', 'CSS includes @keyframes arSpin')
includes(cssText, 'prefers-reduced-motion', 'CSS includes prefers-reduced-motion safeguard')

const topLeftNode = findNode(loadedTree, (n) => n.props?.className === 'ar-main-top-left')
const topRightNode = findNode(loadedTree, (n) => n.props?.className === 'ar-main-top-right')
check(Boolean(topLeftNode), 'renders .ar-main-top-left container')
check(Boolean(topRightNode), 'renders .ar-main-top-right container')

const syncLabelNode = findNode(loadedTree, (n) => n.props?.className === 'ar-sync-label')
check(Boolean(syncLabelNode), 'sync button wraps label in .ar-sync-label')

const syncingTree = render(states.syncing).tree
const syncingBtn = findNode(syncingTree, (n) => n.type === 'button' && String(n.props?.className ?? '').includes('ar-sync-btn--syncing'))
check(Boolean(syncingBtn) && syncingBtn.props?.disabled === true, 'sync button gets ar-sync-btn--syncing and disabled when syncing')

const closedTree = render(states['sidebar closed']).tree
const closedAside = findNode(closedTree, (n) => n.type === 'aside')
check(String(closedAside?.props?.className ?? '').includes('ar-sidebar--closed'), 'sidebarOpen=false renders .ar-sidebar--closed')
check(closedAside?.props?.['aria-hidden'] === true, 'sidebarOpen=false sets aria-hidden=true on <aside>')

console.log(failures === 0 ? '\nall render checks passed' : `\n${failures} render check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
