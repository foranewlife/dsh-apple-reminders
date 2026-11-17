/**
 * Browser half of the to-do bundle: one right-sidebar tab type (`todo`) that
 * shows the Host-owned list, plus a guide entry and a global shortcut.
 *
 * The list lives on the Host (`$DSH_HOME/dsh-todo/todos.json`) so the model can
 * read and edit it and so Apple Reminders can mirror it. This module keeps no
 * copy of its own: it posts operations to `/api/dsh-todo/op` and follows
 * `/api/dsh-todo/events` for changes made anywhere else (another window, the
 * model, or the phone through Reminders).
 */
window.__ModuleLoader__.load({
  id: 'dsh-todo',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'todo'
    /** The tab kind this plugin owns. */
    const KIND = 'todo'
    /** This implementation's identity in the tab system, and its slot key. */
    const ID = 'dsh-todo'
    /** The shortcut command that opens this tab. */
    const COMMAND = 'todo.open'
    /** Relative paths resolve against the document, as the host's own routes do. */
    const OP_URL = 'api/dsh-todo/op'
    const EVENTS_URL = 'api/dsh-todo/events'
    /** The abandoned browser-local list from the first version of this plugin. */
    const LEGACY_KEY = 'dsh.todo.v1'
    /** Which list groups the user folded away; a view preference, so it stays local. */
    const COLLAPSED_KEY = 'dsh.todo.collapsed.v1'
    const CONFIRM_MS = 3000
    /** A hung request must not leave the panel loading forever. */
    const REQUEST_TIMEOUT_MS = 10000
    /** Reminders priorities this panel offers. */
    const PRIORITIES = [0, 1, 5, 9]

    const zh = {
      'type.label': '待办',
      'guide.title': '待办',
      'guide.description': '随手记下要做的事',
      'input.placeholder': '添加任务，回车确认',
      'input.label': '新任务',
      'empty': '还没有任务',
      'loading': '读取中…',
      'load.failed': '读不到清单',
      'load.retry': '重试',
      'op.failed': '没保存成功，请重试',
      'remaining': '还剩 {count} 件',
      'allDone': '都完成了',
      'completed': '已完成 {count}',
      'clear': '清除已完成',
      'clear.confirm': '确认清除',
      'clear.aria': '清除已完成的任务',
      'clear.ariaArmed': '再点一次清除已完成的任务',
      'delete': '删除',
      'delete.aria': '删除：{text}',
      'sync.now': '立即同步',
      'sync.syncing': '同步中…',
      'sync.retry': '重试',
      'sync.aria': '立即与提醒事项同步',
      'sync.error': '提醒事项同步失败：{reason}',
      'shortcut.noSession': '先打开一个对话',
      'done.aria': '标记为完成：{text}',
      'undo.aria': '标记为未完成：{text}',
      'flag.aria': '标为旗标：{text}',
      'unflag.aria': '取消旗标：{text}',
      'row.more': '更多设置：{text}',
      'row.notes': '备注',
      'row.overdue': '逾期',
      'editor.open': '设置',
      'editor.due': '截止日期',
      'editor.clearDue': '清除日期',
      'editor.priority': '优先级',
      'editor.notes': '备注…',
      'editor.notes.aria': '备注：{text}',
      'priority.0': '无',
      'priority.1': '低',
      'priority.5': '中',
      'priority.9': '高',
      'list.label': '新任务加到',
      'manage.title': '同步哪些列表',
      'group.collapse': '折叠 {name}',
      'group.expand': '展开 {name}',
      'manage.open': '管理列表',
      'manage.done': '完成',
    }

    const en = {
      'type.label': 'To-do',
      'guide.title': 'To-do',
      'guide.description': 'A quick list for yourself',
      'input.placeholder': 'Add a task, press Enter',
      'input.label': 'New task',
      'empty': 'No tasks yet',
      'loading': 'Loading…',
      'load.failed': 'Cannot read the list',
      'load.retry': 'Retry',
      'op.failed': 'Could not save, try again',
      'remaining': '{count} left',
      'allDone': 'All done',
      'completed': '{count} completed',
      'clear': 'Clear completed',
      'clear.confirm': 'Confirm',
      'clear.aria': 'Clear completed tasks',
      'clear.ariaArmed': 'Press again to clear completed tasks',
      'delete': 'Delete',
      'delete.aria': 'Delete: {text}',
      'sync.now': 'Sync now',
      'sync.syncing': 'Syncing…',
      'sync.retry': 'Retry',
      'sync.aria': 'Sync with Reminders now',
      'sync.error': 'Reminders sync failed: {reason}',
      'shortcut.noSession': 'Open a conversation first',
      'done.aria': 'Mark done: {text}',
      'undo.aria': 'Mark not done: {text}',
      'flag.aria': 'Flag: {text}',
      'unflag.aria': 'Unflag: {text}',
      'row.more': 'More settings: {text}',
      'row.notes': 'Notes',
      'row.overdue': 'Overdue',
      'editor.open': 'Settings',
      'editor.due': 'Due date',
      'editor.clearDue': 'Clear date',
      'editor.priority': 'Priority',
      'editor.notes': 'Notes…',
      'editor.notes.aria': 'Notes: {text}',
      'priority.0': 'None',
      'priority.1': 'Low',
      'priority.5': 'Medium',
      'priority.9': 'High',
      'list.label': 'Add to',
      'manage.title': 'Lists to sync',
      'group.collapse': 'Collapse {name}',
      'group.expand': 'Expand {name}',
      'manage.open': 'Manage lists',
      'manage.done': 'Done',
    }

    /** A compact checklist glyph for the sidebar guide card; the guide owns its size. */
    function GuideIcon(props) {
      const size = typeof props.size === 'number' ? props.size : 22
      const tick = (y) => h('path', {
        d: `M2.7 ${y}l1.6 1.6 3-3.2`,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.4,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      })
      const rule = (y) => h('path', {
        d: `M10.2 ${y}h3.3`,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
      })
      return h('svg', {
        viewBox: '0 0 16 16', width: size, height: size, className: props.className,
        'aria-hidden': true, focusable: 'false',
      }, tick(2.6), rule(2.9), tick(9.4), rule(9.7))
    }

    /**
     * One panel operation against the Host.
     * @param {object} op - `{op, ...}`.
     * @returns {Promise<object>} the state after the operation.
     */
    async function callHost(op) {
      const response = await fetch(OP_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(op),
        ...(typeof AbortSignal.timeout === 'function' ? { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) } : {}),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload === null || payload.ok !== true) {
        throw new Error(payload !== null && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`)
      }
      return payload.state
    }

    /**
     * @returns {object[]} tasks left in the abandoned browser-local list.
     */
    function readLegacyItems() {
      let raw
      try {
        raw = window.localStorage.getItem(LEGACY_KEY)
      } catch {
        return []
      }
      if (raw === null || raw === '') return []
      try {
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        return parsed
          .filter((item) => item !== null && typeof item === 'object' && typeof item.text === 'string' && item.text.trim() !== '')
          .map((item) => ({ text: item.text, done: item.done === true }))
      } catch {
        return []
      }
    }

    /** @param {unknown} error - any thrown value. @returns {string} a short message. */
    const messageOf = (error) => (error instanceof Error ? error.message : String(error))

    /**
     * @returns {Record<string, boolean>} groups the user folded away last time.
     */
    function readCollapsedGroups() {
      try {
        const raw = window.localStorage.getItem(COLLAPSED_KEY)
        if (raw === null) return {}
        const parsed = JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object' ? parsed : {}
      } catch {
        return {}
      }
    }

    /** @returns {boolean} whether focus currently belongs to the document body. */
    function focusIsLoose() {
      const active = document.activeElement
      return active === null || active === document.body
    }

    /** @param {Date} date - today. @returns {string} `YYYY-MM-DD` in local time. */
    function todayPrefix(date = new Date()) {
      const pad = (n) => (n < 10 ? `0${n}` : `${n}`)
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    }

    /** @param {string} due - `YYYY-MM-DD`. @returns {string} `MM-DD` for this year, else the full date. */
    function shortDate(due) {
      const year = new Date().getFullYear()
      return due.startsWith(`${year}-`) ? due.slice(5) : due
    }

    const CSS = `
.dt-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; box-sizing: border-box; color: var(--dsw-alias-label-primary); font: inherit; font-size: var(--dsh-content-font-size-secondary, 13px); }
.dt-form { flex: none; padding: 12px 12px 6px; }
.dt-input { box-sizing: border-box; width: 100%; height: 32px; padding: 0 10px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); color: inherit; font: inherit; }
.dt-input::placeholder { color: var(--dsw-alias-label-tertiary); }
.dt-input:focus { border-color: var(--dsw-alias-state-business-primary); }
.dt-input:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
.dt-lists { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 0 12px 6px; }
.dt-manage { flex: none; display: flex; flex-direction: column; gap: 6px; margin: 0 12px 6px; padding: 8px; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-sm); }
.dt-chip { box-sizing: border-box; height: 20px; padding: 0 8px; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: 999px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11px; line-height: 18px; cursor: pointer; }
.dt-chip--on { border-color: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-label-primary); }
.dt-controls { flex: none; display: flex; align-items: center; gap: 8px; padding: 0 12px 6px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 16px; }
.dt-controls-actions { display: inline-flex; flex: none; align-items: center; gap: 10px; margin-left: auto; }
.dt-count { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dt-link { padding: 0 4px; border: 0; border-radius: var(--dsw-radius-xs); background: transparent; color: var(--dsw-alias-label-tertiary); font: inherit; font-size: 12px; line-height: 16px; cursor: pointer; }
.dt-link--armed { color: var(--dsw-alias-state-warn-primary); }
.dt-link:disabled { opacity: 0.5; cursor: default; }
.dt-button { box-sizing: border-box; height: 28px; padding: 0 12px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; cursor: pointer; }
.dt-button--sm { height: 22px; padding: 0 8px; border-radius: var(--dsw-radius-xs); font-size: 12px; }
.dt-button--error { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.dt-error { flex: none; padding: 0 12px 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 16px; }
.dt-list { flex: 1 1 auto; min-height: 0; margin: 0; padding: 0 6px 12px; list-style: none; overflow-y: auto; }
.dt-row { padding: 4px 6px; border-radius: var(--dsw-radius-sm); }
.dt-row-main { display: flex; align-items: flex-start; gap: 2px; }
.dt-label { display: flex; flex: 1 1 auto; align-items: flex-start; gap: 8px; min-width: 0; cursor: pointer; }
.dt-check { flex: none; width: 13px; height: 13px; margin: 4px 0 0; accent-color: var(--dsw-alias-state-business-primary); cursor: pointer; }
.dt-text-block { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.dt-text { min-width: 0; line-height: 20px; overflow-wrap: anywhere; }
.dt-sub { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 15px; overflow-wrap: anywhere; }
.dt-sub-overdue { color: var(--dsw-alias-state-error-primary); }
.dt-flag { flex: none; width: 20px; height: 20px; margin-top: 1px; padding: 0; border: 0; border-radius: var(--dsw-radius-xs); background: transparent; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 20px; cursor: pointer; opacity: 0.35; }
.dt-flag--on { color: var(--dsw-alias-state-warn-primary); opacity: 1; }
.dt-more { flex: none; width: 20px; height: 20px; margin-top: 1px; padding: 0; border: 0; border-radius: var(--dsw-radius-xs); background: transparent; color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 20px; cursor: pointer; opacity: 0.45; }
.dt-more--on { opacity: 1; background: var(--dsw-alias-interactive-bg-hover); }
.dt-del { flex: none; box-sizing: border-box; width: 20px; height: 20px; margin-top: 1px; padding: 0; border: 0; border-radius: var(--dsw-radius-xs); background: transparent; color: var(--dsw-alias-label-tertiary); font: inherit; font-size: 14px; line-height: 20px; cursor: pointer; opacity: 0; }
.dt-editor { display: flex; flex-direction: column; gap: 6px; margin: 4px 0 2px 27px; padding: 8px; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-sm); }
.dt-editor-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dt-date { box-sizing: border-box; height: 24px; padding: 0 6px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-xs); background: var(--dsw-alias-bg-layer-1); color: inherit; font: inherit; font-size: 12px; }
.dt-notes { box-sizing: border-box; width: 100%; min-height: 48px; padding: 5px 6px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-xs); background: var(--dsw-alias-bg-layer-1); color: inherit; font: inherit; font-size: 12px; line-height: 18px; resize: vertical; }
.dt-section { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 6px 2px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 16px; }
.dt-group { display: block; padding: 2px 0 0; }
.dt-group-list { margin: 0; padding: 0; list-style: none; }
.dt-group-head { display: flex; align-items: center; gap: 6px; width: 100%; box-sizing: border-box; padding: 4px 6px; border: 0; border-radius: var(--dsw-radius-xs); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; line-height: 16px; text-align: left; cursor: pointer; }
.dt-group-chevron { flex: none; width: 10px; color: var(--dsw-alias-label-tertiary); }
.dt-group-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dt-group-count { flex: none; color: var(--dsw-alias-label-tertiary); }
.dt-row--done .dt-text { color: var(--dsw-alias-label-tertiary); text-decoration: line-through; }
.dt-row--done .dt-check { opacity: 0.6; }
.dt-empty { flex: 1 1 auto; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 0 16px; color: var(--dsw-alias-label-tertiary); text-align: center; }
.dt-detail { max-width: 100%; font-size: 12px; line-height: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (hover: hover) {
  .dt-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
  .dt-row:hover .dt-del { opacity: 1; }
  .dt-del:hover, .dt-flag:hover, .dt-more:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
  .dt-link:hover { color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-interactive-bg-hover); }
  .dt-button:hover, .dt-chip:hover { background: var(--dsw-alias-interactive-bg-hover); }
  .dt-group-head:hover { background: var(--dsw-alias-interactive-bg-hover); }
}
@media (hover: none) { .dt-del { opacity: 1; } }
.dt-del:active, .dt-link:active, .dt-button:active, .dt-chip:active { background: var(--dsw-alias-interactive-bg-active); }
.dt-del:focus-visible, .dt-link:focus-visible, .dt-button:focus-visible, .dt-flag:focus-visible, .dt-more:focus-visible, .dt-chip:focus-visible, .dt-date:focus-visible, .dt-notes:focus-visible, .dt-group-head:focus-visible { opacity: 1; outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
`

    /**
     * The tab body: an input line, the controls, the tasks with their settings,
     * and the state of the Reminders mirror.
     * @param props - framework seat props, including the `todo` translate.
     */
    function TodoPanel(props) {
      const t = props.t
      const [items, setItems] = React.useState([])
      const [sync, setSync] = React.useState(null)
      const [phase, setPhase] = React.useState('loading')
      const [slow, setSlow] = React.useState(false)
      const [loadError, setLoadError] = React.useState('')
      const [opError, setOpError] = React.useState('')
      const [draft, setDraft] = React.useState('')
      const [targetList, setTargetList] = React.useState(null)
      const [manageOpen, setManageOpen] = React.useState(false)
      const [collapsed, setCollapsed] = React.useState(readCollapsedGroups)
      // Finished tasks stay out of the way until asked for.
      const [showDone, setShowDone] = React.useState(false)
      const [expanded, setExpanded] = React.useState(null)
      const [noteDraft, setNoteDraft] = React.useState('')
      const [scrollTick, setScrollTick] = React.useState(0)
      const [armed, setArmed] = React.useState(false)
      const inputRef = React.useRef(null)
      const listRef = React.useRef(null)
      const lastRev = React.useRef(-1)

      // Every frame carries `rev`; an older one must never undo a newer list.
      const accept = React.useCallback((state) => {
        if (typeof state?.rev === 'number') {
          if (state.rev < lastRev.current) return
          lastRev.current = state.rev
        }
        setItems(Array.isArray(state.items) ? state.items : [])
        setSync(state.sync ?? null)
        setPhase('ready')
      }, [])

      const refresh = React.useCallback(async () => {
        try {
          accept(await callHost({ op: 'list' }))
        } catch {
          // The event stream or the next action retries; nothing to add here.
        }
      }, [accept])

      const load = React.useCallback(async () => {
        try {
          let state = await callHost({ op: 'list' })
          const legacy = readLegacyItems()
          if (legacy.length > 0) {
            state = await callHost({ op: 'migrate', items: legacy })
            const texts = new Set(state.items.map((item) => item.text))
            if (legacy.every((item) => texts.has(item.text))) {
              try {
                window.localStorage.removeItem(LEGACY_KEY)
              } catch {
                // Leaving the key behind only repeats an already-merged import.
              }
            }
          }
          accept(state)
          setLoadError('')
        } catch (error) {
          setPhase('failed')
          setLoadError(messageOf(error))
        }
      }, [accept])

      React.useEffect(() => { void load() }, [load])

      // A tab switch remounts this body; a 250 ms delay keeps the loading line
      // from flashing on a local round trip that finishes in one frame.
      React.useEffect(() => {
        if (phase !== 'loading') return undefined
        const timer = window.setTimeout(() => setSlow(true), 250)
        return () => window.clearTimeout(timer)
      }, [phase])

      // Live updates: another window, the model, or a phone edit pulled in by
      // the Host. EventSource reconnects by itself; coming back to the window
      // asks the Host for a reconcile, which covers a missed reconnect.
      React.useEffect(() => {
        let source
        try {
          source = new EventSource(EVENTS_URL)
        } catch {
          return undefined
        }
        source.onopen = () => { lastRev.current = -1 }
        source.onmessage = (event) => {
          try {
            accept(JSON.parse(event.data))
          } catch {
            // A malformed frame is not worth breaking the panel over.
          }
        }
        const onVisible = () => {
          if (document.visibilityState !== 'visible') return
          void callHost({ op: 'sync' }).then(accept, () => { void refresh() })
        }
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          document.removeEventListener('visibilitychange', onVisible)
          source.close()
        }
      }, [accept, refresh])

      // The clear button disarms itself so a stray click cannot delete anything.
      React.useEffect(() => {
        if (!armed) return undefined
        const timer = window.setTimeout(() => setArmed(false), CONFIRM_MS)
        return () => window.clearTimeout(timer)
      }, [armed])

      // Folding a group is a view preference; it survives a reload.
      React.useEffect(() => {
        try {
          window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed))
        } catch {
          // Losing the preference is not worth failing a render over.
        }
      }, [collapsed])

      /** @param {string} name - list name. */
      const toggleGroup = (name) => {
        setCollapsed((current) => ({ ...current, [name]: current[name] !== true }))
      }

      // A task added while the list was scrolled elsewhere has to be visible.
      React.useEffect(() => {
        if (scrollTick === 0) return
        const nodes = listRef.current?.querySelectorAll('li.dt-row:not(.dt-row--done)')
        nodes?.[nodes.length - 1]?.scrollIntoView({ block: 'nearest' })
      }, [scrollTick])

      const pending = items.filter((item) => !item.done)
      const completed = items.filter((item) => item.done)
      const lists = Array.isArray(sync?.lists) ? sync.lists : []
      const multiList = lists.length > 1
      const activeList = targetList ?? lists[0] ?? sync?.listName ?? ''

      /** @param {object} item - task. @returns {string} the list it belongs to. */
      const itemList = (item) => (typeof item.list === 'string' && item.list !== ''
        ? item.list
        : (lists[0] ?? sync?.listName ?? ''))

      // Due date first (undated last), then the text, so the list reads like a plan.
      const byDue = (a, b) => {
        const left = typeof a.due === 'string' ? a.due : '~~~~'
        const right = typeof b.due === 'string' ? b.due : '~~~~'
        if (left !== right) return left < right ? -1 : 1
        return a.text.localeCompare(b.text)
      }
      const pendingSorted = [...pending].sort(byDue)
      const completedSorted = [...completed].sort(byDue)
      const groupNames = []
      for (const item of pendingSorted) {
        const name = itemList(item)
        if (!groupNames.includes(name)) groupNames.push(name)
      }
      const orderedNames = [
        ...lists.filter((name) => groupNames.includes(name)),
        ...groupNames.filter((name) => !lists.includes(name)),
      ]
      const groups = orderedNames.map((name) => ({
        name,
        items: pendingSorted.filter((item) => itemList(item) === name),
      }))

      const run = async (op, { refocus = false } = {}) => {
        try {
          accept(await callHost(op))
          setOpError('')
        } catch (error) {
          setOpError(messageOf(error))
          // The checkbox may have flipped itself already; take the Host's word.
          void refresh()
        }
        if (refocus) {
          window.requestAnimationFrame(() => {
            if (focusIsLoose()) inputRef.current?.focus()
          })
        }
      }

      const patchTask = (id, fields) => { void run({ op: 'update', id, patch: fields }) }

      const add = () => {
        const text = draft.trim()
        if (text === '') return
        setDraft('')
        void (async () => {
          try {
            const op = { op: 'add', text }
            if (activeList !== '') op.list = activeList
            accept(await callHost(op))
            setOpError('')
            setScrollTick((tick) => tick + 1)
          } catch (error) {
            setOpError(messageOf(error))
            setDraft(text)
          }
        })()
      }

      const clearCompleted = () => {
        if (!armed) {
          setArmed(true)
          return
        }
        setArmed(false)
        void run({ op: 'clear_done' }, { refocus: true })
      }

      const toggleExpanded = (item) => {
        if (expanded === item.id) {
          setExpanded(null)
          return
        }
        setExpanded(item.id)
        setNoteDraft(item.notes ?? '')
      }

      const commitNotes = (item) => {
        if ((item.notes ?? '') === noteDraft) return
        patchTask(item.id, { notes: noteDraft })
      }

      /** @param {object} item - one task. @returns {object|null} the compact detail line. */
      const detailLine = (item) => {
        const bits = []
        let overdue = false
        if (typeof item.due === 'string') {
          overdue = !item.done && item.due < todayPrefix()
          bits.push(`${overdue ? t('row.overdue') + ' ' : ''}${shortDate(item.due)}`)
        }
        if (typeof item.priority === 'number') bits.push(t(`priority.${item.priority}`) ?? String(item.priority))
        if (typeof item.notes === 'string') bits.push(t('row.notes'))
        if (bits.length === 0) return null
        return h('span', { className: overdue ? 'dt-sub dt-sub-overdue' : 'dt-sub' }, bits.join(' · '))
      }

      /** @param {object} item - the task whose settings are open. */
      const editor = (item) => h('div', { className: 'dt-editor' },
        h('div', { className: 'dt-editor-row' },
          h('input', {
            type: 'date',
            className: 'dt-date',
            value: typeof item.due === 'string' ? item.due : '',
            'aria-label': t('editor.due'),
            onChange: (event) => patchTask(item.id, { due: event.target.value }),
          }),
          typeof item.due === 'string'
            ? h('button', {
              type: 'button',
              className: 'dt-link',
              onClick: () => patchTask(item.id, { due: '' }),
            }, t('editor.clearDue'))
            : null),
        h('div', { className: 'dt-editor-row' },
          h('span', { className: 'dt-sub' }, t('editor.priority')),
          PRIORITIES.map((value) => h('button', {
            key: String(value),
            type: 'button',
            className: (item.priority ?? 0) === value ? 'dt-chip dt-chip--on' : 'dt-chip',
            'aria-pressed': (item.priority ?? 0) === value,
            onClick: () => patchTask(item.id, { priority: value }),
          }, t(`priority.${value}`)))),
        multiList
          ? h('div', { className: 'dt-editor-row' },
            h('span', { className: 'dt-sub' }, t('list.label')),
            lists.map((name) => h('button', {
              key: name,
              type: 'button',
              className: (item.list ?? '') === name ? 'dt-chip dt-chip--on' : 'dt-chip',
              'aria-pressed': (item.list ?? '') === name,
              onClick: () => patchTask(item.id, { list: name }),
            }, name)))
          : null,
        h('textarea', {
          className: 'dt-notes',
          rows: 3,
          value: noteDraft,
          placeholder: t('editor.notes'),
          'aria-label': t('editor.notes.aria', { text: item.text }),
          onChange: (event) => setNoteDraft(event.target.value),
          onBlur: () => commitNotes(item),
        }))

      const row = (item) => h('li', {
        key: item.id,
        className: item.done ? 'dt-row dt-row--done' : 'dt-row',
        'data-dt-id': item.id,
      },
      h('div', { className: 'dt-row-main' },
        h('label', { className: 'dt-label' },
          h('input', {
            type: 'checkbox',
            className: 'dt-check',
            checked: item.done,
            onChange: () => { void run({ op: 'toggle', id: item.id }) },
            'aria-label': item.done ? t('undo.aria', { text: item.text }) : t('done.aria', { text: item.text }),
          }),
          h('span', { className: 'dt-text-block' },
            h('span', { className: 'dt-text' }, item.text),
            detailLine(item))),
        h('button', {
          type: 'button',
          className: item.flagged === true ? 'dt-flag dt-flag--on' : 'dt-flag',
          onClick: () => { void run({ op: 'update', id: item.id, patch: { flagged: item.flagged !== true } }) },
          'aria-label': item.flagged === true ? t('unflag.aria', { text: item.text }) : t('flag.aria', { text: item.text }),
          title: item.flagged === true ? t('unflag.aria', { text: item.text }) : t('flag.aria', { text: item.text }),
        }, '⚑'),
        h('button', {
          type: 'button',
          className: expanded === item.id ? 'dt-more dt-more--on' : 'dt-more',
          onClick: () => toggleExpanded(item),
          'aria-expanded': expanded === item.id,
          'aria-label': t('row.more', { text: item.text }),
          title: t('editor.open'),
        }, '⋯'),
        h('button', {
          type: 'button',
          className: 'dt-del',
          onClick: () => { void run({ op: 'remove', id: item.id }, { refocus: true }) },
          'aria-label': t('delete.aria', { text: item.text }),
          title: t('delete'),
        }, '×')),
      expanded === item.id ? editor(item) : null)

      /**
       * One list's open tasks behind a foldable header.
       * @param {{name: string, items: object[]}} group - the group.
       */
      const groupBlock = (group) => h('li', { key: `group:${group.name}`, className: 'dt-group' },
        h('button', {
          type: 'button',
          className: 'dt-group-head',
          onClick: () => toggleGroup(group.name),
          'aria-expanded': collapsed[group.name] !== true,
          title: collapsed[group.name] === true
            ? t('group.expand', { name: group.name })
            : t('group.collapse', { name: group.name }),
        },
        h('span', { className: 'dt-group-chevron' }, collapsed[group.name] === true ? '▸' : '▾'),
        h('span', { className: 'dt-group-name' }, group.name),
        h('span', { className: 'dt-group-count' }, String(group.items.length))),
        collapsed[group.name] === true
          ? null
          : h('ul', { className: 'dt-group-list' }, group.items.map(row)))

      const syncFailed = sync !== null && sync.enabled === true && sync.status === 'error'
      const syncHint = sync === null || sync.enabled !== true
        ? undefined
        : sync.lastSyncAt === undefined
          ? lists.join('、')
          : `${lists.join('、')} · ${new Date(sync.lastSyncAt).toLocaleTimeString()}`
      const status = opError !== ''
        ? { text: t('op.failed'), title: opError }
        : syncFailed
          ? { text: t('sync.error', { reason: sync.error ?? '' }), title: sync.error ?? '' }
          : null

      return h('div', { className: 'dt-panel' },
        h('style', null, CSS),
        h('div', { className: 'dt-form' },
          h('form', {
            onSubmit: (event) => {
              event.preventDefault()
              // An Enter that confirms a CJK candidate must not submit the draft.
              if (event.nativeEvent.isComposing) return
              add()
            },
          },
          h('input', {
            ref: inputRef,
            className: 'dt-input',
            type: 'text',
            value: draft,
            onChange: (event) => setDraft(event.target.value),
            placeholder: t('input.placeholder'),
            'aria-label': t('input.label'),
            autoComplete: 'off',
            spellCheck: false,
          }))),
        // Where a new task goes, when there is more than one list to choose from.
        h('div', { className: 'dt-lists' },
          multiList ? h('span', { className: 'dt-sub' }, t('list.label')) : null,
          lists.map((name) => h('button', {
            key: name,
            type: 'button',
            className: activeList === name ? 'dt-chip dt-chip--on' : 'dt-chip',
            'aria-pressed': activeList === name,
            onClick: () => setTargetList(name),
          }, name)),
          h('button', {
            type: 'button',
            className: 'dt-chip',
            onClick: () => {
              if (!manageOpen) void callHost({ op: 'lists' }).then(accept, () => {})
              setManageOpen(!manageOpen)
            },
            'aria-expanded': manageOpen,
            title: t('manage.open'),
          }, manageOpen ? '−' : '+')),
        manageOpen
          ? h('div', { className: 'dt-manage' },
            h('div', { className: 'dt-sub' }, t('manage.title')),
            h('div', { className: 'dt-lists' }, (Array.isArray(sync?.available) ? sync.available : lists).map((name) => h('button', {
              key: name,
              type: 'button',
              className: lists.includes(name) ? 'dt-chip dt-chip--on' : 'dt-chip',
              'aria-pressed': lists.includes(name),
              onClick: () => {
                const next = lists.includes(name) ? lists.filter((entry) => entry !== name) : [...lists, name]
                if (next.length === 0) return
                void run({ op: 'select', lists: next })
              },
            }, name))),
            h('button', { type: 'button', className: 'dt-link', onClick: () => setManageOpen(false) }, t('manage.done')))
          : null,
        // Everything the user can act on sits above the list.
        phase !== 'ready' ? null : h('div', { className: 'dt-controls' },
          items.length === 0
            ? null
            : h('span', { className: 'dt-count', 'aria-live': 'polite' }, pending.length === 0 ? t('allDone') : t('remaining', { count: pending.length })),
          h('span', { className: 'dt-controls-actions' },
            sync === null || sync.enabled !== true ? null : h('button', {
              type: 'button',
              className: sync.status === 'error' ? 'dt-button dt-button--sm dt-button--error' : 'dt-button dt-button--sm',
              onClick: () => { void run({ op: 'sync' }) },
              disabled: sync.status === 'syncing',
              'aria-label': t('sync.aria'),
              title: syncHint,
            }, sync.status === 'syncing' ? t('sync.syncing') : sync.status === 'error' ? t('sync.retry') : t('sync.now')),
            completed.length === 0
              ? null
              : h('button', {
                type: 'button',
                className: 'dt-link',
                onClick: () => setShowDone(!showDone),
                'aria-expanded': showDone,
              }, `${t('completed', { count: completed.length })} ${showDone ? '▾' : '▸'}`))),
        phase !== 'ready' || status === null ? null : h('div', {
          className: 'dt-error',
          role: 'status',
          title: status.title,
        }, status.text),
        phase === 'loading'
          ? (slow ? h('div', { className: 'dt-empty' }, t('loading')) : null)
          : phase === 'failed'
            ? h('div', { className: 'dt-empty' },
              h('div', null, t('load.failed')),
              loadError === '' ? null : h('div', { className: 'dt-detail', title: loadError }, loadError),
              h('button', {
                type: 'button',
                className: 'dt-button',
                onClick: () => { setPhase('loading'); setSlow(false); setLoadError(''); void load() },
              }, t('load.retry')))
            : items.length === 0
              ? h('div', { className: 'dt-empty' }, t('empty'))
              : h('ul', { ref: listRef, className: 'dt-list' },
                multiList ? groups.map(groupBlock) : pendingSorted.map(row),
                showDone && completed.length > 0
                  ? h('li', { key: 'completed', className: 'dt-section' },
                    h('span', null, t('completed', { count: completed.length })),
                    h('button', {
                      type: 'button',
                      className: armed ? 'dt-link dt-link--armed' : 'dt-link',
                      onClick: clearCompleted,
                      'aria-label': armed ? t('clear.ariaArmed') : t('clear.aria'),
                    }, armed ? t('clear.confirm') : t('clear')))
                  : null,
                showDone ? completedSorted.map(row) : null))
    }

    return {
      inject: ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-todo: dictionaries')
        const t = ctx.locale.bind(NS)

        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: ID,
          kind: KIND,
          title: () => t('type.label'),
          guide: [{
            id: 'todo',
            order: 5,
            commandId: COMMAND,
            title: () => t('guide.title'),
            description: () => t('guide.description'),
            icon: GuideIcon,
          }],
        }), 'dsh-todo: tab type')

        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: ID,
          locale: NS,
        }, TodoPanel))

        // One keystroke from anywhere, because the column starts collapsed.
        ctx.inject(['shortcuts'], (shortcutsCtx) => {
          shortcutsCtx.effect(() => shortcutsCtx.shortcuts.register({
            id: COMMAND,
            label: () => t('guide.title'),
            aliases: ['todo', 'todos', 'to-do', '待办'],
            defaults: {
              'desktop:macos': { code: 'KeyT', modifiers: ['primary', 'alt'] },
              'desktop:windows': { code: 'KeyT', modifiers: ['primary', 'alt'] },
              'desktop:linux': { code: 'KeyT', modifiers: ['primary', 'alt'] },
              'web:macos': { code: 'KeyT', modifiers: ['primary', 'alt'] },
              'web:windows': { code: 'KeyT', modifiers: ['primary', 'alt'] },
              'web:linux': { code: 'KeyT', modifiers: ['primary', 'alt'] },
            },
            regions: ['page', 'editable', 'terminal'],
            modals: [],
            resolve: ({ target: element }) => {
              const target = ctx.sidebarRight.commandTarget(element)
              if (target === undefined) return { status: 'blocked', reason: t('shortcut.noSession') }
              return { status: 'handled', run: () => { ctx.sidebarRight.openTabFromTarget(KIND, target) } }
            },
          }), 'dsh-todo: shortcut')
        })

        // Unloading the plugin must not leave tabs that no type can draw.
        ctx.effect(() => () => {
          try {
            const face = ctx.sidebarRight
            const tabs = face.openTabs.getSnapshot() ?? []
            for (const tab of tabs) {
              if (tab.kind !== KIND) continue
              const tabId = tab.tabId ?? tab.id
              if (tabId === undefined) continue
              if (typeof face.closeIn === 'function' && tab.sessionId !== undefined) {
                face.closeIn(tab.sessionId, tabId)
              } else {
                face.close(tabId)
              }
            }
          } catch {
            // Best effort: the sidebar may already be disposed with the page.
          }
        }, 'dsh-todo: open tabs')
      },
    }
  },
})
