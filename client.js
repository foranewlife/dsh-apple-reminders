/**
 * Browser half of the to-do bundle: one right-sidebar tab type (`todo`) that
 * shows the Host-owned list, laid out like macOS Apple Reminders.
 *
 * The list lives on the Host (`$DSH_HOME/dsh-apple-reminders/todos.json`) so the
 * model can read and edit it and so Apple Reminders can mirror it. This module
 * keeps no copy of its own: it posts operations to `/api/dsh-apple-reminders/op`
 * and follows the events route for changes made anywhere else (another window,
 * the model, or the phone through Reminders).
 */
window.__ModuleLoader__.load({
  id: 'dsh-apple-reminders',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'todo'
    /** The tab kind this plugin owns. */
    const KIND = 'todo'
    /** This implementation's identity in the tab system, and its slot key. */
    const ID = 'dsh-apple-reminders'
    /** The shortcut command that opens this tab. */
    const COMMAND = 'todo.open'
    /** Relative paths resolve against the document, as the host's own routes do. */
    const OP_URL = 'api/dsh-apple-reminders/op'
    const EVENTS_URL = 'api/dsh-apple-reminders/events'
    /** The abandoned browser-local list from the first version of this plugin. */
    const LEGACY_KEY = 'dsh.todo.v1'
    /** Local UI view preferences. */
    const COLLAPSED_KEY = 'dsh.todo.collapsed.v1'
    const VIEW_KEY = 'dsh.todo.view.v2'
    const SIDEBAR_KEY = 'dsh.todo.sidebar.v1'
    const GROCERIES_DISMISSED_KEY = 'dsh.todo.groceries.dismissed.v1'

    const CONFIRM_MS = 3000
    const REQUEST_TIMEOUT_MS = 10000

    /** Apple Reminders priorities: 0 = None, 9 = Low (!), 5 = Medium (!!), 1 = High (!!!). */
    const PRIORITIES = [0, 9, 5, 1]
    const REPEAT_OPTIONS = ['none', 'daily', 'weekdays', 'weekly', 'biweekly', 'monthly', 'yearly']
    const LIST_EMOJIS = ['', '📋', '🛒', '💡', '🎯', '🥳', '👏', '💼', '🏠', '✈️', '📚', '❤️', '⭐️']

    // =========================================================================
    // Inlined UI Kit: Colors, Locales & Crisp Apple-style SVG Icons
    // =========================================================================

    const LIST_COLORS = [
      { id: 'red', nameEn: 'Red', nameZh: '红色', hex: '#FF453A', cardDark: '#9B5658', cardLight: '#FFEBE9' },
      { id: 'orange', nameEn: 'Orange', nameZh: '橙色', hex: '#FF9F0A', cardDark: '#A37B4E', cardLight: '#FFF4E5' },
      { id: 'yellow', nameEn: 'Yellow', nameZh: '黄色', hex: '#FFD60A', cardDark: '#9E8B44', cardLight: '#FFFBE0' },
      { id: 'green', nameEn: 'Green', nameZh: '绿色', hex: '#30D158', cardDark: '#498A5A', cardLight: '#E8F9ED' },
      { id: 'cyan', nameEn: 'Cyan', nameZh: '青色', hex: '#64D2FF', cardDark: '#48829E', cardLight: '#E6F7FF' },
      { id: 'blue', nameEn: 'Blue', nameZh: '蓝色', hex: '#0A84FF', cardDark: '#4D74A1', cardLight: '#E5F1FF' },
      { id: 'indigo', nameEn: 'Indigo', nameZh: '靛蓝', hex: '#5E5CE6', cardDark: '#5B5AA6', cardLight: '#ECEBFF' },
      { id: 'purple', nameEn: 'Purple', nameZh: '紫色', hex: '#BF5AF2', cardDark: '#85539E', cardLight: '#F7EAFF' },
      { id: 'pink', nameEn: 'Pink', nameZh: '粉色', hex: '#FF375F', cardDark: '#965463', cardLight: '#FFEBF0' },
      { id: 'brown', nameEn: 'Brown', nameZh: '棕色', hex: '#AC8E68', cardDark: '#9D7E57', cardLight: '#F4EFE8' },
      { id: 'grey', nameEn: 'Grey', nameZh: '灰色', hex: '#8E8E93', cardDark: '#5A5C61', cardLight: '#ECECEF' },
      { id: 'rose', nameEn: 'Rose', nameZh: '玫红', hex: '#FF6482', cardDark: '#9A586A', cardLight: '#FFEDF1' },
    ]

    const LIST_COLOR_MAP = Object.fromEntries(LIST_COLORS.map((c) => [c.id, c]))

    const TILE_COLORS = {
      today: { active: '#1D9BF0', tintDark: '#4F739B', tintLight: '#DCEBFA', iconLight: '#007AFF' },
      planned: { active: '#FF453A', tintDark: '#9D585A', tintLight: '#FDE6E4', iconLight: '#FF3B30' },
      all: { active: '#8E8E93', tintDark: '#434346', tintLight: '#E4E4E9', iconLight: '#1C1C1E' },
      flagged: { active: '#FF9F0A', tintDark: '#9E7952', tintLight: '#FCEFDC', iconLight: '#FF9500' },
      urgent: { active: '#FF375F', tintDark: '#9A5769', tintLight: '#FCE4EA', iconLight: '#FF2D55' },
      completed: { active: '#8E8E93', tintDark: '#686A6E', tintLight: '#E8E8ED', iconLight: '#636366' },
      pinned: { active: '#AC8E68', tintDark: '#9C7C54', tintLight: '#F3ECE2', iconLight: '#8E6E46' },
    }

    const zh = {
      'type.label': '待办',
      'guide.title': '待办',
      'guide.description': '随手记下要做的事',
      'view.today': '今天',
      'view.planned': '计划',
      'view.flagged': '旗标',
      'view.all': '全部',
      'view.completed': '已完成',
      'view.urgent': '紧急',
      'view.trash': '最近删除',
      'view.groceries': '购物单',
      'input.placeholder': '添加任务，回车确认',
      'input.label': '新任务',
      'empty': '没有提醒事项',
      'empty.completed': '还没有已完成的提醒事项',
      'loading': '读取中…',
      'load.failed': '读不到清单',
      'load.retry': '重试',
      'op.failed': '没保存成功，请重试',
      'remaining': '还剩 {count} 件',
      'allDone': '都完成了',
      'completed': '已完成 {count} 项',
      'clear': '清除',
      'clear.confirm': '确认清除',
      'clear.aria': '清除已完成的任务',
      'clear.ariaArmed': '再点一次清除已完成的任务',
      'delete': '删除',
      'delete.aria': '删除：{text}',
      'sync.now': '同步',
      'sync.syncing': '同步中',
      'sync.retry': '重试',
      'sync.aria': '立即与提醒事项同步',
      'sync.error': '提醒事项同步失败：{reason}',
      'shortcut.noSession': '先打开一个对话',
      'done.aria': '标记为完成：{text}',
      'undo.aria': '标记为未完成：{text}',
      'flag.aria': '标为旗标：{text}',
      'unflag.aria': '取消旗标：{text}',
      'row.more': '详细信息：{text}',
      'row.notes': '备注',
      'row.overdue': '已逾期',
      'editor.open': '详细信息',
      'editor.due': '截止日期',
      'editor.clearDue': '清除日期',
      'editor.priority': '优先级',
      'editor.notes': '备注…',
      'editor.notes.aria': '备注：{text}',
      'priority.0': '无',
      'priority.1': '高',
      'priority.5': '中',
      'priority.9': '低',
      'list.label': '列表',
      'manage.title': '同步的提醒事项列表',
      'manage.open': '同步列表',
      'manage.done': '完成',
      'group.collapse': '折叠 {name}',
      'group.expand': '展开 {name}',
      'section.overdue': '已逾期',
      'section.morning': '上午',
      'section.afternoon': '下午',
      'section.tonight': '今晚',
      'section.tomorrow': '明天',
      'section.thisWeek': '本周',
      'section.later': '稍后',
      'sidebar.myLists': '我的列表',
      'sidebar.tags': '标签',
      'sidebar.allTags': '所有标签',
      'sidebar.addList': '添加列表',
      'sidebar.editList': '编辑列表',
      'sidebar.listName': '列表名称',
      'sidebar.listColor': '颜色',
      'sidebar.listIcon': '图标',
      'sidebar.addSection': '添加分组',
      'sidebar.sectionName': '分组名称',
      'sidebar.pin': '置顶到网格',
      'sidebar.unpin': '取消置顶',
      'sidebar.renameList': '编辑列表…',
      'sidebar.deleteList': '删除列表',
      'sidebar.suggestedTitle': '建议列表：购物单',
      'sidebar.suggestedSub': '自动对项目进行分类',
      'sidebar.toggle': '切换边栏',
      'sidebar.cancel': '取消',
      'sidebar.save': '好',
      'search.placeholder': '搜索',
      'search.clear': '清除搜索',
      'search.empty': '没有匹配的提醒事项',
      'search.results': '“{query}”的搜索结果',
      'editor.titlePlaceholder': '新提醒事项',
      'editor.notesPlaceholder': '备注',
      'editor.addTags': '添加标签',
      'editor.tagPlaceholder': '标签…',
      'editor.url': '网址',
      'editor.urlPlaceholder': 'https://example.com',
      'editor.section': '分组',
      'editor.sectionNone': '无分组',
      'editor.subtasks': '子任务',
      'editor.addSubtask': '添加子任务…',
      'editor.indent': '缩进为子任务',
      'editor.outdent': '取消缩进',
      'editor.urgent': '紧急',
      'editor.flag': '旗标',
      'editor.details': '详细信息',
      'editor.date': '日期',
      'editor.time': '时间',
      'editor.clearTime': '清除时间',
      'editor.date.today': '今天',
      'editor.date.tomorrow': '明天',
      'editor.date.weekend': '本周末',
      'editor.date.custom': '自定日期',
      'editor.time.morning': '上午 (09:00)',
      'editor.time.afternoon': '下午 (15:00)',
      'editor.time.tonight': '今晚 (20:00)',
      'editor.time.custom': '自定时间',
      'editor.repeat': '重复',
      'editor.repeat.none': '永不',
      'editor.repeat.daily': '每天',
      'editor.repeat.weekdays': '工作日',
      'editor.repeat.weekly': '每周',
      'editor.repeat.biweekly': '每两周',
      'editor.repeat.monthly': '每月',
      'editor.repeat.yearly': '每年',
      'editor.location': '位置',
      'editor.location.none': '清除位置',
      'editor.location.home': '到达：家',
      'editor.location.work': '到达：公司',
      'editor.location.car': '上车时',
      'editor.location.custom': '输入位置…',
      'completed.show': '显示已完成',
      'completed.hide': '隐藏已完成',
      'trash.count': '{count} 项',
      'trash.recover': '恢复',
      'trash.recoverAll': '全部恢复',
      'trash.deletePermanently': '删除',
      'trash.empty': '清空',
      'trash.emptyConfirm': '确认清空',
      'trash.emptyDesc': '已删除的提醒事项会在此保留 30 天，之后将被永久移除。',
    }

    const en = {
      'type.label': 'To-do',
      'guide.title': 'To-do',
      'guide.description': 'A quick list for yourself',
      'view.today': 'Today',
      'view.planned': 'Scheduled',
      'view.flagged': 'Flagged',
      'view.all': 'All',
      'view.completed': 'Completed',
      'view.urgent': 'Urgent',
      'view.trash': 'Recently Deleted',
      'view.groceries': 'Groceries',
      'input.placeholder': 'Add a task, press Enter',
      'input.label': 'New task',
      'empty': 'No Reminders',
      'empty.completed': 'No Completed Reminders',
      'loading': 'Loading…',
      'load.failed': 'Cannot read the list',
      'load.retry': 'Retry',
      'op.failed': 'Could not save, try again',
      'remaining': '{count} left',
      'allDone': 'All done',
      'completed': '{count} Completed',
      'clear': 'Clear',
      'clear.confirm': 'Confirm',
      'clear.aria': 'Clear completed tasks',
      'clear.ariaArmed': 'Press again to clear completed tasks',
      'delete': 'Delete',
      'delete.aria': 'Delete: {text}',
      'sync.now': 'Sync',
      'sync.syncing': 'Syncing',
      'sync.retry': 'Retry',
      'sync.aria': 'Sync with Reminders now',
      'sync.error': 'Reminders sync failed: {reason}',
      'shortcut.noSession': 'Open a conversation first',
      'done.aria': 'Mark done: {text}',
      'undo.aria': 'Mark not done: {text}',
      'flag.aria': 'Flag: {text}',
      'unflag.aria': 'Unflag: {text}',
      'row.more': 'Details: {text}',
      'row.notes': 'Notes',
      'row.overdue': 'Overdue',
      'editor.open': 'Details',
      'editor.due': 'Due date',
      'editor.clearDue': 'Clear date',
      'editor.priority': 'Priority',
      'editor.notes': 'Notes…',
      'editor.notes.aria': 'Notes: {text}',
      'priority.0': 'None',
      'priority.1': 'High',
      'priority.5': 'Medium',
      'priority.9': 'Low',
      'list.label': 'List',
      'manage.title': 'Synced Reminders Lists',
      'manage.open': 'Sync Lists',
      'manage.done': 'Done',
      'group.collapse': 'Collapse {name}',
      'group.expand': 'Expand {name}',
      'section.overdue': 'Overdue',
      'section.morning': 'Morning',
      'section.afternoon': 'Afternoon',
      'section.tonight': 'Tonight',
      'section.tomorrow': 'Tomorrow',
      'section.thisWeek': 'This Week',
      'section.later': 'Later',
      'sidebar.myLists': 'My Lists',
      'sidebar.tags': 'Tags',
      'sidebar.allTags': 'All Tags',
      'sidebar.addList': 'Add List',
      'sidebar.editList': 'Edit List',
      'sidebar.listName': 'List Name',
      'sidebar.listColor': 'Color',
      'sidebar.listIcon': 'Icon',
      'sidebar.addSection': 'Add Section',
      'sidebar.sectionName': 'Section Name',
      'sidebar.pin': 'Pin to Grid',
      'sidebar.unpin': 'Unpin',
      'sidebar.renameList': 'Edit List…',
      'sidebar.deleteList': 'Delete List',
      'sidebar.suggestedTitle': 'Suggested List: Groceries',
      'sidebar.suggestedSub': 'Automatically categorizes items',
      'sidebar.toggle': 'Toggle Sidebar',
      'sidebar.cancel': 'Cancel',
      'sidebar.save': 'OK',
      'search.placeholder': 'Search',
      'search.clear': 'Clear search',
      'search.empty': 'No Matching Reminders',
      'search.results': 'Results for “{query}”',
      'editor.titlePlaceholder': 'New Reminder',
      'editor.notesPlaceholder': 'Notes',
      'editor.addTags': 'Add Tags',
      'editor.tagPlaceholder': 'Tag…',
      'editor.url': 'URL',
      'editor.urlPlaceholder': 'https://example.com',
      'editor.section': 'Section',
      'editor.sectionNone': 'None',
      'editor.subtasks': 'Subtasks',
      'editor.addSubtask': 'Add Subtask…',
      'editor.indent': 'Indent as Subtask',
      'editor.outdent': 'Outdent',
      'editor.urgent': 'Urgent',
      'editor.flag': 'Flag',
      'editor.details': 'Details',
      'editor.date': 'Date',
      'editor.time': 'Time',
      'editor.clearTime': 'Clear time',
      'editor.date.today': 'Today',
      'editor.date.tomorrow': 'Tomorrow',
      'editor.date.weekend': 'This Weekend',
      'editor.date.custom': 'Custom Date',
      'editor.time.morning': 'Morning (09:00)',
      'editor.time.afternoon': 'Afternoon (15:00)',
      'editor.time.tonight': 'Tonight (20:00)',
      'editor.time.custom': 'Custom Time',
      'editor.repeat': 'Repeat',
      'editor.repeat.none': 'Never',
      'editor.repeat.daily': 'Daily',
      'editor.repeat.weekdays': 'Weekdays',
      'editor.repeat.weekly': 'Weekly',
      'editor.repeat.biweekly': 'Biweekly',
      'editor.repeat.monthly': 'Monthly',
      'editor.repeat.yearly': 'Yearly',
      'editor.location': 'Location',
      'editor.location.none': 'Clear Location',
      'editor.location.home': 'Arriving Home',
      'editor.location.work': 'Arriving Work',
      'editor.location.car': 'Getting in Car',
      'editor.location.custom': 'Custom location…',
      'completed.show': 'Show Completed',
      'completed.hide': 'Hide Completed',
      'trash.count': '{count} Items',
      'trash.recover': 'Recover',
      'trash.recoverAll': 'Recover All',
      'trash.deletePermanently': 'Delete',
      'trash.empty': 'Empty',
      'trash.emptyConfirm': 'Confirm Empty',
      'trash.emptyDesc': 'Deleted reminders remain here for 30 days before permanent removal.',
    }

    function svgProps(props = {}, defaultSize = 16, viewBox = '0 0 20 20') {
      const size = typeof props.size === 'number' ? props.size : defaultSize
      return {
        viewBox,
        width: size,
        height: size,
        className: props.className,
        style: props.style,
        'aria-hidden': true,
        focusable: 'false',
      }
    }

    function TodayCalendarIcon(props = {}) {
      const day = props.day != null ? String(props.day) : String(new Date().getDate())
      return h('svg', svgProps(props, 20, '0 0 20 20'),
        h('rect', { x: 2.5, y: 3.5, width: 15, height: 14, rx: 3.2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', { d: 'M2.5 7.6h15M6.5 2v2.6M13.5 2v2.6', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
        h('text', {
          x: 10, y: 14.5, textAnchor: 'middle', fill: 'currentColor',
          fontSize: day.length > 1 ? 7.2 : 8, fontWeight: 700,
          fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
        }, day))
    }

    function ScheduledIcon(props = {}) {
      return h('svg', svgProps(props, 20, '0 0 20 20'),
        h('rect', { x: 2.5, y: 3.5, width: 15, height: 14, rx: 3.2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', { d: 'M2.5 7.6h15M6.5 2v2.6M13.5 2v2.6', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
        h('circle', { cx: 6.5, cy: 10.7, r: 0.95, fill: 'currentColor' }),
        h('circle', { cx: 10, cy: 10.7, r: 0.95, fill: 'currentColor' }),
        h('circle', { cx: 13.5, cy: 10.7, r: 0.95, fill: 'currentColor' }),
        h('circle', { cx: 6.5, cy: 13.9, r: 0.95, fill: 'currentColor' }),
        h('circle', { cx: 10, cy: 13.9, r: 0.95, fill: 'currentColor' }),
        h('circle', { cx: 13.5, cy: 13.9, r: 0.95, fill: 'currentColor' }))
    }

    function AllInboxIcon(props = {}) {
      return h('svg', svgProps(props, 20, '0 0 20 20'),
        h('path', { d: 'M4.3 4.2h11.4l1.8 6.8v4.2a1.6 1.6 0 0 1-1.6 1.6H4.1a1.6 1.6 0 0 1-1.6-1.6V11l1.8-6.8Z', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round' }),
        h('path', { d: 'M2.6 11h4.3a3.1 3.1 0 0 0 6.2 0h4.3', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round' }))
    }

    function FlagIcon(props = {}) {
      const filled = props.filled !== false
      return h('svg', svgProps(props, 16, '0 0 20 20'),
        h('path', { d: 'M4.5 3v14', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
        h('path', {
          d: 'M4.5 3.6c2.6-1.1 4.4.9 6.8.4 1.6-.3 2.9-.8 4.2-.3v7.2c-1.4-.5-2.7 0-4.2.3-2.4.5-4.2-1.5-6.8-.4Z',
          fill: filled ? 'currentColor' : 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinejoin: 'round',
        }))
    }

    function UrgentAlarmIcon(props = {}) {
      return h('svg', svgProps(props, 20, '0 0 20 20'),
        h('circle', { cx: 10, cy: 11, r: 5.8, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', { d: 'M10 8v3.2l2.1 1.3M3.2 5.4l2.4-2.1M16.8 5.4l-2.4-2.1M5.6 16.2l-1.2 1.5M14.4 16.2l1.2 1.5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    function CompletedCheckIcon(props = {}) {
      return h('svg', svgProps(props, 20, '0 0 20 20'),
        h('path', { d: 'M4.2 10.6l3.9 3.9 7.7-8.6', fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    function ListBulletIcon(props = {}) {
      return h('svg', svgProps(props, 15, '0 0 20 20'),
        h('circle', { cx: 4.2, cy: 5.5, r: 1.15, fill: 'currentColor' }),
        h('circle', { cx: 4.2, cy: 10, r: 1.15, fill: 'currentColor' }),
        h('circle', { cx: 4.2, cy: 14.5, r: 1.15, fill: 'currentColor' }),
        h('path', { d: 'M7.5 5.5h8.3M7.5 10h8.3M7.5 14.5h8.3', fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round' }))
    }

    function TrashIcon(props = {}) {
      return h('svg', svgProps(props, 14, '0 0 20 20'),
        h('path', { d: 'M3.8 5.5h12.4M7.8 5.5V4a1 1 0 0 1 1-1h2.4a1 1 0 0 1 1 1v1.5M5.5 5.5l.8 10.4a1.4 1.4 0 0 0 1.4 1.3h4.6a1.4 1.4 0 0 0 1.4-1.3l.8-10.4M8.4 8.5v5.8M11.6 8.5v5.8', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    function CarrotIcon(props = {}) {
      return h('svg', svgProps(props, 16, '0 0 20 20'),
        h('path', { d: 'M12.6 7.4L5.1 15.6c-.5.5-1.3.1-1-.6l3.3-7.6a3.2 3.2 0 0 1 5.2 0Z', fill: 'currentColor' }),
        h('path', { d: 'M12.2 6.8c.4-1.7 1.4-2.8 2.9-3.1M12.8 7.5c1.5-.3 2.7.2 3.5 1.3M11.6 6.2c-.3-1.4.2-2.6 1.2-3.4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }))
    }

    function SidebarToggleIcon(props = {}) {
      return h('svg', svgProps(props, 16, '0 0 20 20'),
        h('rect', { x: 2.5, y: 3.5, width: 15, height: 13, rx: 2.4, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 }),
        h('path', { d: 'M7.5 3.5v13M4.6 7h1.3M4.6 9.6h1.3M4.6 12.2h1.3', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }))
    }

    function AddListIcon(props = {}) {
      return h('svg', svgProps(props, 16, '0 0 20 20'),
        h('rect', { x: 2.5, y: 3.5, width: 12.2, height: 12.2, rx: 2.6, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 }),
        h('path', { d: 'M5.5 7.2h6.2M5.5 10h6.2M5.5 12.8h4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
        h('circle', { cx: 15.2, cy: 14.8, r: 3.3, fill: 'currentColor' }),
        h('path', { d: 'M15.2 13.4v2.8M13.8 14.8h2.8', fill: 'none', stroke: 'var(--ar-sidebar-bg, #252527)', strokeWidth: 1.4, strokeLinecap: 'round' }))
    }

    function PlusIcon(props = {}) {
      return h('svg', svgProps(props, 16, '0 0 20 20'),
        h('path', { d: 'M10 4v12M4 10h12', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }))
    }

    function SearchIcon(props = {}) {
      return h('svg', svgProps(props, 14, '0 0 20 20'),
        h('circle', { cx: 8.8, cy: 8.8, r: 5.2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7 }),
        h('path', { d: 'M12.7 12.7l3.8 3.8', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }))
    }

    function SyncIcon(props = {}) {
      return h('svg', svgProps(props, 14, '0 0 20 20'),
        h('path', { d: 'M15.8 8.3A6 6 0 0 0 5.3 6.2M4.2 11.7a6 6 0 0 0 10.5 2.1', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
        h('path', { d: 'M16.2 4.8v3.6h-3.6M3.8 15.2v-3.6h3.6', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    function CalendarPillIcon(props = {}) {
      return h('svg', svgProps(props, 14, '0 0 16 16'),
        h('rect', { x: 2, y: 2.8, width: 12, height: 11.2, rx: 2.2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }),
        h('path', { d: 'M2 6h12M5.2 1.6v2M10.8 1.6v2', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }))
    }

    function ClockPillIcon(props = {}) {
      return h('svg', svgProps(props, 14, '0 0 16 16'),
        h('circle', { cx: 8, cy: 8, r: 5.8, fill: 'currentColor', opacity: props.filled ? 1 : 0 }),
        h('circle', { cx: 8, cy: 8, r: 5.8, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }),
        h('path', {
          d: 'M8 4.8v3.4l2.3 1.4',
          fill: 'none',
          stroke: props.filled ? 'var(--ar-pill-bg, #2A2A2D)' : 'currentColor',
          strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
        }))
    }

    function RingingAlarmIcon(props = {}) {
      return h('svg', svgProps(props, 17, '0 0 20 16'),
        h('circle', { cx: 10, cy: 8.6, r: 4.2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.35 }),
        h('path', { d: 'M10 6.3v2.5l1.6 1M5.5 4.2l1.6-1.4M14.5 4.2l-1.6-1.4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.35, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { d: 'M3.5 6.2a4.8 4.8 0 0 0 0 4.8M1.9 4.9a7 7 0 0 0 0 7.4M16.5 6.2a4.8 4.8 0 0 1 0 4.8M18.1 4.9a7 7 0 0 1 0 7.4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }))
    }

    function RepeatIcon(props = {}) {
      return h('svg', svgProps(props, 14, '0 0 16 16'),
        h('path', { d: 'M12.5 5.2A4.8 4.8 0 0 0 3.7 6M3.5 10.8a4.8 4.8 0 0 0 8.8-.8', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
        h('path', { d: 'M12.8 2.8v2.7h-2.7M3.2 13.2v-2.7h2.7', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    function LocationArrowIcon(props = {}) {
      return h('svg', svgProps(props, 13, '0 0 16 16'),
        h('path', { d: 'M13.4 2.6L2.4 7.3l4.9 1.4 1.4 4.9 4.7-11Z', fill: 'currentColor' }))
    }

    function HashTagIcon(props = {}) {
      return h('svg', svgProps(props, 13, '0 0 16 16'),
        h('path', { d: 'M6.2 2.5L4.8 13.5M11.2 2.5L9.8 13.5M3 5.8h10.5M2.5 10.2H13', fill: 'none', stroke: 'currentColor', strokeWidth: 1.45, strokeLinecap: 'round' }))
    }

    function SubtaskIndentIcon(props = {}) {
      return h('svg', svgProps(props, 14, '0 0 16 16'),
        h('rect', { x: 2.2, y: 2.5, width: 11.6, height: 11, rx: 2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.35 }),
        h('path', { d: 'M4.8 6h6.4M6.8 8.8h4.4M6.8 11.4h4.4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }))
    }

    function InfoCircleIcon(props = {}) {
      return h('svg', svgProps(props, 17, '0 0 20 20'),
        h('circle', { cx: 10, cy: 10, r: 7.5, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 }),
        h('circle', { cx: 10, cy: 6.6, r: 0.95, fill: 'currentColor' }),
        h('path', { d: 'M10 9.4v4.4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }))
    }

    function GuideIcon(props = {}) {
      const size = typeof props.size === 'number' ? props.size : 22
      const tick = (y) => h('path', {
        d: `M2.7 ${y}l1.6 1.6 3-3.2`,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
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

    function CheckGlyph(props = {}) {
      return h('svg', svgProps(props, 11, '0 0 12 12'),
        h('path', {
          className: 'ar-check-path',
          d: 'M2.4 6.4l2.3 2.3 4.9-5.4',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round',
        }))
    }

    // =========================================================================
    // Safe Browser / Sandbox Helpers
    // =========================================================================

    function safeStorageGet(key) {
      try {
        return typeof window !== 'undefined' && window.localStorage
          ? window.localStorage.getItem(key)
          : null
      } catch {
        return null
      }
    }

    function safeStorageSet(key, value) {
      try {
        if (typeof window !== 'undefined' && window.localStorage) {
          window.localStorage.setItem(key, value)
        }
      } catch {
        // Ignore storage quota or sandbox restrictions.
      }
    }

    function safeStorageRemove(key) {
      try {
        if (typeof window !== 'undefined' && window.localStorage) {
          window.localStorage.removeItem(key)
        }
      } catch {
        // Ignore storage errors.
      }
    }

    async function callHost(op) {
      const init = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(op),
      }
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        const sig = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        if (sig !== undefined) init.signal = sig
      }
      const response = await fetch(OP_URL, init)
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload === null || payload.ok !== true) {
        throw new Error(payload !== null && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`)
      }
      return payload.state
    }

    function readLegacyItems() {
      const raw = safeStorageGet(LEGACY_KEY)
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

    function readCollapsedGroups() {
      const raw = safeStorageGet(COLLAPSED_KEY)
      if (raw === null || raw === '') return {}
      try {
        const parsed = JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
      } catch {
        return {}
      }
    }

    function readInitialView() {
      const raw = safeStorageGet(VIEW_KEY)
      return typeof raw === 'string' && raw !== '' ? raw : 'today'
    }

    function readSidebarOpen() {
      const raw = safeStorageGet(SIDEBAR_KEY)
      return raw === '0' ? false : true
    }

    function readGroceriesDismissed() {
      return safeStorageGet(GROCERIES_DISMISSED_KEY) === '1'
    }

    const messageOf = (error) => (error instanceof Error ? error.message : String(error))

    function todayPrefix(date = new Date()) {
      const pad = (n) => (n < 10 ? `0${n}` : `${n}`)
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    }

    function addDays(baseDateStr, days) {
      const parts = baseDateStr.split('-').map(Number)
      const dt = new Date(parts[0], (parts[1] || 1) - 1, (parts[2] || 1) + days)
      return todayPrefix(dt)
    }

    function upcomingWeekend(todayStr) {
      const parts = todayStr.split('-').map(Number)
      const dt = new Date(parts[0], (parts[1] || 1) - 1, parts[2] || 1)
      const dow = dt.getDay() // 0 Sun .. 6 Sat
      const delta = dow === 6 ? 7 : (6 - dow)
      return addDays(todayStr, delta)
    }

    function endOfThisWeek(todayStr) {
      const parts = todayStr.split('-').map(Number)
      const dt = new Date(parts[0], (parts[1] || 1) - 1, parts[2] || 1)
      const dow = dt.getDay()
      const daysUntilSun = dow === 0 ? 0 : 7 - dow
      return addDays(todayStr, daysUntilSun)
    }

    function shortDate(due) {
      const year = new Date().getFullYear()
      return due.startsWith(`${year}-`) ? due.slice(5) : due
    }

    function formatDuePill(due, today, tomorrow, t) {
      if (due === today) return t('editor.date.today')
      if (due === tomorrow) return t('editor.date.tomorrow')
      return shortDate(due)
    }

    function normalizePriorityBucket(priority) {
      if (typeof priority !== 'number' || priority <= 0) return 0
      if (priority <= 4) return 1
      if (priority === 5) return 5
      return 9
    }

    function priorityBangs(priority) {
      const b = normalizePriorityBucket(priority)
      if (b === 1) return '!!!'
      if (b === 5) return '!!'
      if (b === 9) return '!'
      return ''
    }

    function resolveHexColor(colorValue) {
      if (typeof colorValue !== 'string' || colorValue.trim() === '') return undefined
      const trimmed = colorValue.trim()
      if (LIST_COLOR_MAP[trimmed.toLowerCase()]) return LIST_COLOR_MAP[trimmed.toLowerCase()].hex
      return trimmed
    }

    function sanitizeExternalUrl(raw) {
      if (typeof raw !== 'string') return null
      const trimmed = raw.trim()
      if (trimmed === '') return null
      if (/^https?:\/\//i.test(trimmed)) return trimmed
      if (/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(trimmed)) return `https://${trimmed}`
      return null
    }

    function urlHostLabel(raw) {
      const safe = sanitizeExternalUrl(raw)
      if (!safe) return raw
      try {
        const u = new URL(safe)
        return u.hostname.replace(/^www\./, '')
      } catch {
        return safe
      }
    }

    // =========================================================================
    // Apple Reminders Stylesheet (Dark Screenshot Match + Light Mode + Responsive)
    // =========================================================================

    const CSS = `
.ar-root {
  --ar-sidebar-bg: #252527;
  --ar-main-bg: #1E1E20;
  --ar-surface: #2C2C2E;
  --ar-surface-hover: rgba(255, 255, 255, 0.065);
  --ar-surface-active: rgba(255, 255, 255, 0.11);
  --ar-pill-bg: #2A2A2D;
  --ar-pill-border: rgba(255, 255, 255, 0.09);
  --ar-border: rgba(255, 255, 255, 0.085);
  --ar-divider: rgba(255, 255, 255, 0.085);
  --ar-text-primary: #F5F5F7;
  --ar-text-secondary: #98989D;
  --ar-text-muted: #636366;
  --ar-blue: #1D9BF0;
  --ar-green: #30D158;
  --ar-red: #FF453A;
  --ar-orange: #FF9F0A;
  --ar-pink: #FF375F;
  --ar-trash-badge: #161618;
  --ar-popover-bg: #2C2C2F;
  --ar-shadow: 0 10px 28px rgba(0, 0, 0, 0.45);
  --ar-ease-spring: cubic-bezier(0.22, 1, 0.36, 1);
  --ar-ease-bounce: cubic-bezier(0.34, 1.56, 0.64, 1);
  --ar-ease-snappy: cubic-bezier(0.2, 0, 0, 1);
  container-type: inline-size;
  position: relative;
  display: flex;
  width: 100%;
  height: 100%;
  min-height: 0;
  box-sizing: border-box;
  overflow: hidden;
  background: var(--ar-main-bg);
  color: var(--ar-text-primary);
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif;
  font-size: 13px;
  line-height: 1.4;
  -webkit-font-smoothing: antialiased;
}
.ar-root button {
  min-width: 0;
  min-height: 0;
  margin: 0;
  appearance: none;
  -webkit-appearance: none;
  font-family: inherit;
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]):not(.dark) .ar-root {
    --ar-sidebar-bg: #F2F2F7;
    --ar-main-bg: #FFFFFF;
    --ar-surface: #E5E5EA;
    --ar-surface-hover: rgba(0, 0, 0, 0.045);
    --ar-surface-active: rgba(0, 0, 0, 0.085);
    --ar-pill-bg: #EFEFF4;
    --ar-pill-border: rgba(0, 0, 0, 0.08);
    --ar-border: rgba(0, 0, 0, 0.09);
    --ar-divider: rgba(0, 0, 0, 0.085);
    --ar-text-primary: #1C1C1E;
    --ar-text-secondary: #636366;
    --ar-text-muted: #8E8E93;
    --ar-blue: #007AFF;
    --ar-green: #34C759;
    --ar-red: #FF3B30;
    --ar-orange: #FF9500;
    --ar-pink: #FF2D55;
    --ar-trash-badge: #D1D1D6;
    --ar-popover-bg: #FFFFFF;
    --ar-shadow: 0 10px 28px rgba(0, 0, 0, 0.14);
  }
}
:root[data-theme="light"] .ar-root, .light .ar-root {
  --ar-sidebar-bg: #F2F2F7;
  --ar-main-bg: #FFFFFF;
  --ar-surface: #E5E5EA;
  --ar-surface-hover: rgba(0, 0, 0, 0.045);
  --ar-surface-active: rgba(0, 0, 0, 0.085);
  --ar-pill-bg: #EFEFF4;
  --ar-pill-border: rgba(0, 0, 0, 0.08);
  --ar-border: rgba(0, 0, 0, 0.09);
  --ar-divider: rgba(0, 0, 0, 0.085);
  --ar-text-primary: #1C1C1E;
  --ar-text-secondary: #636366;
  --ar-text-muted: #8E8E93;
  --ar-blue: #007AFF;
  --ar-green: #34C759;
  --ar-red: #FF3B30;
  --ar-orange: #FF9500;
  --ar-pink: #FF2D55;
  --ar-trash-badge: #D1D1D6;
  --ar-popover-bg: #FFFFFF;
  --ar-shadow: 0 10px 28px rgba(0, 0, 0, 0.14);
}
@keyframes arCheckPop {
  0% { transform: scale(0.78); }
  55% { transform: scale(1.16); }
  100% { transform: scale(1); }
}
@keyframes arCheckDraw {
  from { stroke-dashoffset: 16; }
  to { stroke-dashoffset: 0; }
}
@keyframes arRowCompleteOut {
  0% { opacity: 1; transform: translateX(0); }
  45% { opacity: 0.92; transform: translateX(0); }
  100% { opacity: 0.14; transform: translateX(6px); }
}
@keyframes arEditorIn {
  from { opacity: 0; transform: translateY(-5px) scale(0.992); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes arPopoverIn {
  from { opacity: 0; transform: translateY(-5px) scale(0.965); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes arBellWiggle {
  0% { transform: rotate(0deg) scale(1); }
  22% { transform: rotate(-14deg) scale(1.1); }
  48% { transform: rotate(12deg) scale(1.1); }
  72% { transform: rotate(-7deg) scale(1.04); }
  100% { transform: rotate(0deg) scale(1); }
}
@keyframes arFlagBounce {
  0% { transform: scale(0.8) rotate(-8deg); }
  55% { transform: scale(1.18) rotate(5deg); }
  100% { transform: scale(1) rotate(0deg); }
}
@keyframes arSpin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
@keyframes arShake {
  0%, 100% { transform: translateX(0); }
  22% { transform: translateX(-3px); }
  48% { transform: translateX(3px); }
  74% { transform: translateX(-1.5px); }
}
@keyframes arViewFade {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes arBtnPopIn {
  from { opacity: 0; transform: scale(0.86); }
  to { opacity: 1; transform: scale(1); }
}
.ar-scrim {
  display: none;
}
.ar-sidebar {
  flex: 0 0 252px;
  width: 252px;
  min-width: 208px;
  max-width: 276px;
  height: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  background: var(--ar-sidebar-bg);
  border-right: 1px solid var(--ar-border);
  overflow: hidden;
  user-select: none;
  z-index: 20;
  opacity: 1;
  transition:
    width 260ms var(--ar-ease-spring),
    flex-basis 260ms var(--ar-ease-spring),
    min-width 260ms var(--ar-ease-spring),
    opacity 200ms ease,
    border-color 200ms ease;
}
.ar-sidebar--closed {
  flex-basis: 0;
  width: 0;
  min-width: 0;
  opacity: 0;
  border-right-color: transparent;
  pointer-events: none;
}
@container (max-width: 499px) {
  .ar-sidebar {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    flex: none;
    width: min(264px, 84%);
    min-width: 0;
    max-width: 84%;
    opacity: 1;
    border-right: 1px solid var(--ar-border);
    box-shadow: var(--ar-shadow);
    transform: translateX(0);
    transition: transform 280ms var(--ar-ease-spring), box-shadow 240ms ease;
  }
  .ar-sidebar--closed {
    width: min(264px, 84%);
    min-width: 0;
    opacity: 1;
    transform: translateX(-105%);
    pointer-events: none;
    box-shadow: none;
  }
  .ar-scrim {
    display: block;
    position: absolute;
    inset: 0;
    z-index: 15;
    background: rgba(0, 0, 0, 0.36);
    opacity: 0;
    pointer-events: none;
    backdrop-filter: blur(0px);
    -webkit-backdrop-filter: blur(0px);
    transition: opacity 220ms ease, backdrop-filter 220ms ease, -webkit-backdrop-filter 220ms ease;
  }
  .ar-scrim--open {
    opacity: 1;
    pointer-events: auto;
    backdrop-filter: blur(2px);
    -webkit-backdrop-filter: blur(2px);
  }
}
.ar-sb-top {
  flex: none;
  box-sizing: border-box;
  min-width: 252px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 12px 8px;
}
.ar-circle-btn,
.ar-root .ar-circle-btn {
  flex: 0 0 30px;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  min-width: 30px;
  max-width: 30px;
  min-height: 30px;
  max-height: 30px;
  padding: 0;
  border: 1px solid var(--ar-pill-border);
  border-radius: 50%;
  background: var(--ar-surface);
  color: var(--ar-text-secondary);
  line-height: 1;
  cursor: pointer;
  transition:
    background 140ms ease,
    color 140ms ease,
    border-color 140ms ease,
    transform 160ms var(--ar-ease-spring);
}
.ar-circle-btn:hover {
  color: var(--ar-text-primary);
  background: var(--ar-surface-active);
}
.ar-circle-btn:active {
  transform: scale(0.91);
}
.ar-sb-scroll {
  flex: 1 1 auto;
  box-sizing: border-box;
  min-width: 252px;
  min-height: 0;
  overflow-y: auto;
  padding: 2px 11px 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
@container (max-width: 499px) {
  .ar-sb-top,
  .ar-sb-scroll {
    min-width: 0;
    width: 100%;
  }
}
.ar-smart-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.ar-smart-card {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  height: 62px;
  padding: 8px 10px;
  border: 0;
  border-radius: 11px;
  color: #FFFFFF;
  font: inherit;
  text-align: left;
  cursor: pointer;
  position: relative;
  transition:
    transform 180ms var(--ar-ease-spring),
    filter 160ms ease,
    box-shadow 180ms ease;
}
.ar-smart-card:hover {
  filter: brightness(1.06);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
}
.ar-smart-card:active {
  transform: scale(0.96);
}
.ar-smart-card--on {
  box-shadow: inset 0 0 0 1.5px rgba(255, 255, 255, 0.55), 0 4px 12px rgba(0, 0, 0, 0.24);
  filter: brightness(1.09);
}
.ar-smart-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}
.ar-smart-count {
  font-size: 19px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: -0.3px;
  font-variant-numeric: tabular-nums;
}
.ar-smart-label {
  font-size: 12.5px;
  font-weight: 600;
  line-height: 1.15;
  opacity: 0.92;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.ar-groceries {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 8px;
  border-radius: 10px;
  background: transparent;
  transition: background 140ms ease;
}
.ar-groceries:hover {
  background: var(--ar-surface-hover);
}
.ar-groceries-icon {
  flex: none;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: #44A851;
  color: #FFFFFF;
  display: grid;
  place-items: center;
}
.ar-groceries-body {
  flex: 1 1 auto;
  min-width: 0;
}
.ar-groceries-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--ar-text-primary);
  line-height: 1.25;
}
.ar-groceries-sub {
  font-size: 10.5px;
  color: var(--ar-text-muted);
  line-height: 1.25;
  margin-top: 1px;
}
.ar-groceries-add {
  flex: none;
  width: 23px;
  height: 23px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: var(--ar-green);
  color: #112615;
  display: grid;
  place-items: center;
  cursor: pointer;
  transition: transform 150ms var(--ar-ease-spring), filter 120ms ease;
}
.ar-groceries-add:hover {
  filter: brightness(1.08);
}
.ar-groceries-add:active {
  transform: scale(0.9);
}
.ar-groceries-dismiss {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--ar-text-muted);
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition: opacity 140ms ease, color 120ms ease;
}
.ar-groceries:hover .ar-groceries-dismiss {
  opacity: 1;
}
.ar-sb-section {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.ar-sb-heading-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 6px 3px;
}
.ar-sb-heading {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--ar-text-secondary);
}
.ar-sb-mini-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}
.ar-mini-btn {
  padding: 1px 6px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--ar-text-secondary);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease, transform 140ms var(--ar-ease-spring);
}
.ar-mini-btn:hover {
  color: var(--ar-text-primary);
  background: var(--ar-surface-hover);
}
.ar-mini-btn:active {
  transform: scale(0.94);
}
.ar-list-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 5px 7px;
  border-radius: 8px;
  cursor: pointer;
  color: var(--ar-text-primary);
  transition: background 140ms ease, transform 150ms var(--ar-ease-spring);
}
.ar-list-row:hover {
  background: var(--ar-surface-hover);
}
.ar-list-row:active {
  transform: scale(0.985);
}
.ar-list-row--on {
  background: var(--ar-surface-active);
}
.ar-list-badge {
  flex: none;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  color: #FFFFFF;
  display: grid;
  place-items: center;
  font-size: 14px;
  line-height: 1;
  transition: transform 160ms var(--ar-ease-spring);
}
.ar-list-row:hover .ar-list-badge {
  transform: scale(1.04);
}
.ar-list-badge--trash {
  background: var(--ar-trash-badge);
  color: var(--ar-text-secondary);
}
.ar-list-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
.ar-list-count {
  flex: none;
  font-size: 13px;
  color: var(--ar-text-muted);
  font-variant-numeric: tabular-nums;
}
.ar-list-more {
  flex: none;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--ar-text-secondary);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transform: scale(0.9);
  transition: opacity 150ms ease, transform 150ms var(--ar-ease-spring), background 120ms ease, color 120ms ease;
}
.ar-list-row:hover .ar-list-more, .ar-list-more--on {
  opacity: 1;
  transform: scale(1);
}
.ar-list-more:hover {
  background: var(--ar-surface-hover);
  color: var(--ar-text-primary);
}
.ar-list-more:active {
  transform: scale(0.88);
}
.ar-tags-wrap {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  padding: 2px 4px;
}
.ar-tag-pill {
  padding: 3px 8px;
  border: 0;
  border-radius: 6px;
  background: var(--ar-surface);
  color: var(--ar-text-secondary);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
  transition: background 140ms ease, color 140ms ease, transform 150ms var(--ar-ease-spring);
}
.ar-tag-pill:hover {
  color: var(--ar-text-primary);
  background: var(--ar-surface-active);
}
.ar-tag-pill:active {
  transform: scale(0.94);
}
.ar-tag-pill--on {
  background: var(--ar-blue);
  color: #FFFFFF;
}
.ar-tag-pill--on:hover {
  background: var(--ar-blue);
  color: #FFFFFF;
}
.ar-main {
  container-type: inline-size;
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--ar-main-bg);
  overflow: hidden;
}
.ar-main-top {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px 6px;
  min-width: 0;
}
.ar-main-top-left {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
}
.ar-main-top-left .ar-circle-btn {
  animation: arBtnPopIn 180ms var(--ar-ease-spring);
}
.ar-main-top-right {
  flex: 1 1 0%;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}
.ar-search-box {
  flex: 1 1 90px;
  min-width: 64px;
  max-width: 210px;
  height: 30px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  border: 1px solid var(--ar-pill-border);
  border-radius: 999px;
  background: var(--ar-surface);
  color: var(--ar-text-secondary);
  transition:
    max-width 200ms var(--ar-ease-spring),
    border-color 150ms ease,
    box-shadow 150ms ease,
    color 150ms ease;
}
.ar-search-box:focus-within {
  max-width: 240px;
  border-color: var(--ar-blue);
  box-shadow: 0 0 0 2px rgba(29, 155, 240, 0.18);
  color: var(--ar-text-primary);
}
.ar-search-input {
  flex: 1 1 auto;
  min-width: 0;
  width: 100%;
  border: 0;
  outline: 0;
  padding: 0;
  background: transparent;
  color: var(--ar-text-primary);
  font: inherit;
  font-size: 12.5px;
}
.ar-search-input::placeholder {
  color: var(--ar-text-secondary);
}
.ar-search-clear {
  flex: 0 0 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: var(--ar-text-muted);
  color: var(--ar-main-bg);
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
  animation: arBtnPopIn 140ms var(--ar-ease-spring);
  transition: transform 130ms var(--ar-ease-spring), opacity 120ms ease;
}
.ar-search-clear:active {
  transform: scale(0.86);
}
.ar-sync-btn {
  flex: 0 0 auto;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 30px;
  padding: 0 10px;
  white-space: nowrap;
  border: 1px solid var(--ar-pill-border);
  border-radius: 999px;
  background: transparent;
  color: var(--ar-text-secondary);
  font: inherit;
  font-size: 11.5px;
  line-height: 1;
  cursor: pointer;
  transition:
    background 140ms ease,
    color 140ms ease,
    border-color 140ms ease,
    transform 160ms var(--ar-ease-spring);
}
.ar-sync-btn:hover:not(:disabled) {
  color: var(--ar-text-primary);
  background: var(--ar-surface-hover);
}
.ar-sync-btn:active:not(:disabled) {
  transform: scale(0.94);
}
.ar-sync-btn--syncing svg {
  animation: arSpin 850ms linear infinite;
}
.ar-sync-btn--error {
  color: var(--ar-red);
  border-color: var(--ar-red);
  animation: arShake 320ms var(--ar-ease-spring);
}
.ar-sync-btn:disabled {
  opacity: 0.65;
  cursor: default;
}
@container (max-width: 430px) {
  .ar-sync-btn:not(.ar-sync-btn--error),
  .ar-root .ar-sync-btn:not(.ar-sync-btn--error) {
    width: 30px;
    min-width: 30px;
    max-width: 30px;
    padding: 0;
    border-radius: 50%;
    justify-content: center;
  }
  .ar-sync-btn:not(.ar-sync-btn--error) .ar-sync-label {
    display: none;
  }
}
@container (max-width: 260px) {
  .ar-search-box {
    min-width: 44px;
    padding: 0 7px;
  }
}
.ar-header-bar {
  flex: none;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  padding: 4px 18px 10px;
  flex-wrap: wrap;
}
.ar-view-title {
  margin: 0;
  font-size: 29px;
  font-weight: 800;
  letter-spacing: -0.5px;
  line-height: 1.15;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color 180ms ease;
}
.ar-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ar-action-link {
  padding: 3px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--ar-blue);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease, transform 140ms var(--ar-ease-spring);
}
.ar-action-link:hover {
  background: var(--ar-surface-hover);
}
.ar-action-link:active {
  transform: scale(0.95);
}
.ar-action-link--danger {
  color: var(--ar-red);
}
.ar-subbar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 18px 8px;
  color: var(--ar-text-secondary);
  font-size: 12px;
  border-bottom: 1px solid var(--ar-divider);
}
.ar-status-banner {
  flex: none;
  margin: 0 18px 8px;
  padding: 5px 10px;
  border-radius: 7px;
  background: rgba(255, 69, 58, 0.14);
  color: var(--ar-red);
  font-size: 12px;
  animation: arEditorIn 180ms var(--ar-ease-spring);
}
.ar-content {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 2px 18px 28px;
}
.ar-view-stage {
  animation: arViewFade 190ms var(--ar-ease-spring);
}
.ar-section {
  margin-bottom: 6px;
}
.ar-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 0 6px;
  border-bottom: 1px solid var(--ar-divider);
  color: var(--ar-text-secondary);
  font-size: 12.5px;
  font-weight: 600;
}
.ar-section-head--overdue {
  color: var(--ar-red);
}
.ar-section-title-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.ar-section-head--clickable {
  cursor: pointer;
}
.ar-section-chevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--ar-text-muted);
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
  transform: rotate(0deg);
  transition: transform 180ms var(--ar-ease-spring), color 140ms ease, background 140ms ease;
}
.ar-section-chevron--folded {
  transform: rotate(-90deg);
}
.ar-section-chevron:hover {
  color: var(--ar-text-primary);
  background: var(--ar-surface-hover);
}
.ar-section-slot {
  min-height: 22px;
  cursor: text;
}
.ar-section-add {
  padding: 0 5px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--ar-text-muted);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transform: scale(0.9);
  transition: opacity 150ms ease, transform 150ms var(--ar-ease-spring), background 120ms ease, color 120ms ease;
}
.ar-section-head:hover .ar-section-add {
  opacity: 1;
  transform: scale(1);
}
.ar-section-add:hover {
  color: var(--ar-text-primary);
  background: var(--ar-surface-hover);
}
.ar-section-add:active {
  transform: scale(0.88);
}
.ar-task-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.ar-row {
  position: relative;
  padding: 8px 2px;
  border-bottom: 1px solid var(--ar-divider);
  transition: opacity 180ms ease, transform 180ms var(--ar-ease-spring), background 140ms ease;
}
.ar-row--subtask {
  margin-left: 26px;
}
.ar-row--completing {
  pointer-events: none;
  animation: arRowCompleteOut 250ms var(--ar-ease-spring) forwards;
}
.ar-row-main {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.ar-check {
  flex: none;
  box-sizing: border-box;
  width: 18px;
  height: 18px;
  margin-top: 2px;
  padding: 0;
  border: 1.6px solid var(--ar-text-muted);
  border-radius: 50%;
  background: transparent;
  color: #FFFFFF;
  display: grid;
  place-items: center;
  cursor: pointer;
  transition:
    transform 150ms var(--ar-ease-spring),
    background 180ms ease,
    border-color 180ms ease,
    box-shadow 180ms ease;
}
.ar-check:hover:not(.ar-check--draft) {
  box-shadow: 0 0 0 3px var(--ar-surface-hover);
}
.ar-check:active {
  transform: scale(0.84);
}
.ar-check--draft {
  border-style: dashed;
  cursor: default;
}
.ar-check--draft:active {
  transform: none;
}
.ar-check svg {
  opacity: 0;
  transform: scale(0.6);
  transition: opacity 120ms ease, transform 160ms var(--ar-ease-spring);
}
.ar-check .ar-check-path {
  stroke-dasharray: 16;
  stroke-dashoffset: 16;
}
.ar-check--done,
.ar-row--completing .ar-check {
  background: var(--ar-list-color, var(--ar-blue));
  border-color: var(--ar-list-color, var(--ar-blue));
  animation: arCheckPop 260ms var(--ar-ease-bounce);
}
.ar-check--done svg,
.ar-row--completing .ar-check svg {
  opacity: 1;
  transform: scale(1);
}
.ar-check--done .ar-check-path,
.ar-row--completing .ar-check .ar-check-path {
  stroke-dasharray: 16;
  stroke-dashoffset: 0;
  animation: arCheckDraw 200ms var(--ar-ease-snappy) forwards;
}
.ar-row-body {
  flex: 1 1 auto;
  min-width: 0;
  cursor: text;
}
.ar-row-title-line {
  display: flex;
  align-items: baseline;
  gap: 5px;
  font-size: 13.5px;
  line-height: 1.4;
  color: var(--ar-text-primary);
  overflow-wrap: anywhere;
  transition: color 180ms ease;
}
.ar-row--done .ar-row-title-line,
.ar-row--completing .ar-row-title-line {
  color: var(--ar-text-muted);
  text-decoration: line-through;
}
.ar-bangs {
  color: var(--ar-blue);
  font-weight: 700;
  flex: none;
}
.ar-row-notes-preview {
  margin-top: 2px;
  font-size: 12px;
  color: var(--ar-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ar-meta-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 3px;
  font-size: 11.5px;
  color: var(--ar-text-secondary);
}
.ar-meta-overdue {
  color: var(--ar-red);
}
.ar-meta-urgent {
  color: var(--ar-pink);
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.ar-meta-tag {
  color: var(--ar-blue);
  cursor: pointer;
}
.ar-meta-url {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  border-radius: 5px;
  background: var(--ar-surface);
  color: var(--ar-blue);
  text-decoration: none;
  font-size: 11px;
  transition: background 120ms ease;
}
.ar-meta-url:hover {
  background: var(--ar-surface-active);
}
.ar-row-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
}
.ar-icon-btn {
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--ar-text-muted);
  display: grid;
  place-items: center;
  cursor: pointer;
  opacity: 0;
  transform: scale(0.92);
  transition: opacity 150ms ease, transform 150ms var(--ar-ease-spring), background 120ms ease, color 120ms ease;
}
.ar-row:hover .ar-icon-btn, .ar-icon-btn--visible {
  opacity: 1;
  transform: scale(1);
}
.ar-icon-btn--info {
  color: var(--ar-blue);
  opacity: 1;
  transform: scale(1);
}
.ar-icon-btn--flagged {
  color: var(--ar-orange);
  opacity: 1;
  transform: scale(1);
}
.ar-icon-btn--flagged svg {
  animation: arFlagBounce 300ms var(--ar-ease-bounce);
}
.ar-icon-btn:hover {
  background: var(--ar-surface-hover);
  color: var(--ar-text-primary);
}
.ar-icon-btn:active {
  transform: scale(0.88);
}
.ar-icon-btn--info:hover {
  color: var(--ar-blue);
}
.ar-inline-editor {
  padding: 9px 2px 11px;
  border-bottom: 1px solid var(--ar-divider);
  transform-origin: top center;
  animation: arEditorIn 210ms var(--ar-ease-spring);
}
.ar-ie-top {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ar-ie-title {
  flex: 1 1 auto;
  min-width: 0;
  border: 0;
  outline: 0;
  padding: 0;
  background: transparent;
  color: var(--ar-text-primary);
  font: inherit;
  font-size: 14px;
  line-height: 1.4;
}
.ar-ie-title::placeholder {
  color: var(--ar-text-muted);
}
.ar-ie-fields {
  margin-left: 28px;
  margin-top: 3px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.ar-ie-notes {
  width: 100%;
  border: 0;
  outline: 0;
  padding: 1px 0;
  background: transparent;
  color: var(--ar-text-secondary);
  font: inherit;
  font-size: 12.5px;
}
.ar-ie-notes::placeholder {
  color: var(--ar-text-muted);
}
.ar-ie-tags-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
}
.ar-ie-tag-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  border-radius: 5px;
  background: rgba(29, 155, 240, 0.16);
  color: var(--ar-blue);
  font-size: 12px;
  animation: arBtnPopIn 150ms var(--ar-ease-spring);
}
.ar-ie-tag-x {
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font-size: 12px;
  cursor: pointer;
}
.ar-ie-tag-input {
  flex: 1 1 90px;
  min-width: 70px;
  border: 0;
  outline: 0;
  padding: 1px 0;
  background: transparent;
  color: var(--ar-blue);
  font: inherit;
  font-size: 12.5px;
}
.ar-ie-tag-input::placeholder {
  color: var(--ar-text-muted);
}
.ar-quick-pills {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 7px;
}
.ar-qpill {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 9px;
  border: 1px solid var(--ar-pill-border);
  border-radius: 999px;
  background: var(--ar-pill-bg);
  color: var(--ar-text-secondary);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition:
    background 140ms ease,
    color 140ms ease,
    border-color 140ms ease,
    transform 150ms var(--ar-ease-spring);
}
.ar-qpill:hover {
  color: var(--ar-text-primary);
  background: var(--ar-surface-active);
}
.ar-qpill:active {
  transform: scale(0.94);
}
.ar-qpill--blue {
  color: var(--ar-blue);
  border-color: rgba(29, 155, 240, 0.32);
  background: rgba(29, 155, 240, 0.09);
}
.ar-qpill--pink {
  color: var(--ar-pink);
  border-color: rgba(255, 55, 95, 0.35);
  background: rgba(255, 55, 95, 0.1);
}
.ar-qpill--pink svg {
  animation: arBellWiggle 380ms var(--ar-ease-spring);
}
.ar-qpill--orange {
  color: var(--ar-orange);
  border-color: rgba(255, 159, 10, 0.35);
  background: rgba(255, 159, 10, 0.1);
}
.ar-qpill--orange svg {
  animation: arFlagBounce 300ms var(--ar-ease-bounce);
}
.ar-qpill-clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: 2px;
  padding: 0 2px;
  color: var(--ar-text-muted);
  font-size: 13px;
  line-height: 1;
}
.ar-qpill-clear:hover {
  color: var(--ar-text-primary);
}
.ar-popover {
  margin-top: 8px;
  padding: 10px 12px;
  border: 1px solid var(--ar-border);
  border-radius: 10px;
  background: var(--ar-popover-bg);
  box-shadow: var(--ar-shadow);
  display: flex;
  flex-direction: column;
  gap: 8px;
  transform-origin: top left;
  animation: arPopoverIn 180ms var(--ar-ease-spring);
}
.ar-pop-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.ar-pop-label {
  min-width: 58px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--ar-text-secondary);
}
.ar-pop-chip {
  padding: 4px 9px;
  border: 1px solid var(--ar-pill-border);
  border-radius: 7px;
  background: var(--ar-pill-bg);
  color: var(--ar-text-primary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease, transform 140ms var(--ar-ease-spring);
}
.ar-pop-chip:hover {
  background: var(--ar-surface-active);
}
.ar-pop-chip:active {
  transform: scale(0.95);
}
.ar-pop-chip--on {
  background: var(--ar-blue);
  border-color: var(--ar-blue);
  color: #FFFFFF;
}
.ar-pop-chip--on:hover {
  background: var(--ar-blue);
}
.ar-pop-input {
  flex: 1 1 140px;
  height: 28px;
  box-sizing: border-box;
  padding: 0 8px;
  border: 1px solid var(--ar-pill-border);
  border-radius: 7px;
  background: var(--ar-pill-bg);
  color: var(--ar-text-primary);
  font: inherit;
  font-size: 12px;
  transition: border-color 140ms ease;
}
.ar-pop-input:focus {
  outline: none;
  border-color: var(--ar-blue);
}
.ar-color-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}
.ar-color-dot {
  width: 20px;
  height: 20px;
  padding: 0;
  border: 2px solid transparent;
  border-radius: 50%;
  cursor: pointer;
  transition: transform 150ms var(--ar-ease-bounce), border-color 120ms ease;
}
.ar-color-dot:hover {
  transform: scale(1.1);
}
.ar-color-dot--on {
  border-color: var(--ar-text-primary);
  transform: scale(1.14);
}
.ar-empty-state {
  padding: 36px 16px;
  text-align: center;
  color: var(--ar-text-muted);
  font-size: 13px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}
.ar-click-space {
  min-height: 64px;
  cursor: text;
}
@media (prefers-reduced-motion: reduce) {
  .ar-root *,
  .ar-root *::before,
  .ar-root *::after {
    animation: none !important;
    transition-duration: 0.01ms !important;
  }
}
`

    // =========================================================================
    // Main Component: TodoPanel (Strict deterministic 16-hook order)
    // =========================================================================

    function TodoPanel(props) {
      const t = props.t

      // 16 fixed React.useState hooks at top level (0..15):
      const [items, setItems] = React.useState([])                              // 0: active tasks
      const [trash, setTrash] = React.useState([])                              // 1: soft-deleted tasks
      const [sync, setSync] = React.useState(null)                              // 2: sync & list metadata
      const [phase, setPhase] = React.useState('loading')                       // 3: 'loading' | 'ready' | 'failed'
      const [slow, setSlow] = React.useState(false)                             // 4: loading delay flag
      const [loadError, setLoadError] = React.useState('')                      // 5: initial load error
      const [opError, setOpError] = React.useState('')                          // 6: mutation error
      const [view, setView] = React.useState(readInitialView)                   // 7: active smart/list/tag view
      const [sidebarOpen, setSidebarOpen] = React.useState(readSidebarOpen)     // 8: left sidebar expanded
      const [search, setSearch] = React.useState('')                            // 9: live search query
      const [collapsed, setCollapsed] = React.useState(readCollapsedGroups)     // 10: folded groups/sections/subtasks
      const [showCompletedMap, setShowCompletedMap] = React.useState({})        // 11: per-view Show Completed
      const [editorState, setEditorState] = React.useState(null)                // 12: inline task/draft editor
      const [popover, setPopover] = React.useState(null)                        // 13: active pill/inspector/modal popover
      const [armed, setArmed] = React.useState('')                              // 14: two-step confirmation key
      const [groceriesDismissed, setGroceriesDismissed] = React.useState(readGroceriesDismissed) // 15: Groceries card dismissed

      const rootRef = React.useRef(null)
      const narrowRef = React.useRef(false)
      const titleInputRef = React.useRef(null)
      const tagInputRef = React.useRef(null)
      const lastRev = React.useRef(-1)
      const editorRef = React.useRef(null)
      const pointerInEditorRef = React.useRef(false)
      const justDismissedRef = React.useRef(null)
      const editorStateRef = React.useRef(editorState)
      editorStateRef.current = editorState
      const editorDismissHelpersRef = React.useRef({ getEditorBucket: () => '', closeEditor: () => {} })

      const accept = React.useCallback((state) => {
        if (!state || typeof state !== 'object') return
        if (typeof state.rev === 'number') {
          if (state.rev < lastRev.current) return
          lastRev.current = state.rev
        }
        setItems(Array.isArray(state.items) ? state.items : [])
        if (Array.isArray(state.trash)) setTrash(state.trash)
        setSync(state.sync ?? null)
        setPhase('ready')
      }, [])

      const refresh = React.useCallback(async () => {
        try {
          accept(await callHost({ op: 'list' }))
        } catch {
          // Event stream or next user action will reconcile.
        }
      }, [accept])

      const load = React.useCallback(async () => {
        try {
          let state = await callHost({ op: 'list' })
          const legacy = readLegacyItems()
          if (legacy.length > 0) {
            state = await callHost({ op: 'migrate', items: legacy })
            const texts = new Set((state.items ?? []).map((item) => item.text))
            if (legacy.every((item) => texts.has(item.text))) {
              safeStorageRemove(LEGACY_KEY)
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

      React.useEffect(() => {
        if (phase !== 'loading') return undefined
        const timer = window.setTimeout(() => setSlow(true), 250)
        return () => window.clearTimeout(timer)
      }, [phase])

      React.useEffect(() => {
        if (typeof EventSource !== 'function') return undefined
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
            // Ignore malformed SSE frames.
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

      React.useEffect(() => {
        if (typeof ResizeObserver !== 'function' || !rootRef.current) return undefined
        const ro = new ResizeObserver((entries) => {
          const w = entries[0]?.contentRect?.width ?? 600
          narrowRef.current = w > 0 && w < 500
        })
        ro.observe(rootRef.current)
        return () => ro.disconnect()
      }, [])

      React.useEffect(() => {
        if (armed === '') return undefined
        const timer = window.setTimeout(() => setArmed(''), CONFIRM_MS)
        return () => window.clearTimeout(timer)
      }, [armed])

      React.useEffect(() => {
        safeStorageSet(COLLAPSED_KEY, JSON.stringify(collapsed))
      }, [collapsed])

      React.useEffect(() => {
        safeStorageSet(VIEW_KEY, view)
      }, [view])

      React.useEffect(() => {
        safeStorageSet(SIDEBAR_KEY, sidebarOpen ? '1' : '0')
      }, [sidebarOpen])

      React.useEffect(() => {
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
        const onDocMouseDown = (e) => {
          const currentEd = editorStateRef.current
          if (!currentEd) return
          if (editorRef.current && typeof editorRef.current.contains === 'function' && editorRef.current.contains(e.target)) {
            return
          }
          const { getEditorBucket: getBucket, closeEditor: closeEd } = editorDismissHelpersRef.current
          const bucket = getBucket(currentEd)
          justDismissedRef.current = { bucket, at: Date.now() }
          if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
            window.setTimeout(() => {
              if (justDismissedRef.current && Date.now() - justDismissedRef.current.at >= 240) {
                justDismissedRef.current = null
              }
            }, 250)
          }
          if (currentEd.mode === 'new' && currentEd.text.trim() === '') {
            closeEd(false)
          } else {
            closeEd(true)
          }
        }
        document.addEventListener('mousedown', onDocMouseDown, true)
        return () => document.removeEventListener('mousedown', onDocMouseDown, true)
      }, [])

      const run = async (op) => {
        try {
          const nextState = await callHost(op)
          accept(nextState)
          setOpError('')
          return nextState
        } catch (error) {
          setOpError(messageOf(error))
          void refresh()
          return null
        }
      }

      // =====================================================================
      // Derived Metadata: Lists, Colors, Icons, Sections, Counts
      // =====================================================================

      const configuredLists = Array.isArray(sync?.lists) && sync.lists.length > 0
        ? sync.lists
        : (typeof sync?.listName === 'string' && sync.listName !== '' ? [sync.listName] : ['DSH 待办'])

      const defaultList = configuredLists[0] ?? 'DSH 待办'

      const metaByName = {}
      if (Array.isArray(sync?.lists) && Array.isArray(sync?.listColors)) {
        sync.lists.forEach((name, idx) => {
          const c = resolveHexColor(sync.listColors[idx])
          if (c) metaByName[name] = { ...(metaByName[name] ?? { name }), color: c }
        })
      }
      if (Array.isArray(sync?.available) && Array.isArray(sync?.availableColors)) {
        sync.available.forEach((name, idx) => {
          const c = resolveHexColor(sync.availableColors[idx])
          if (c) metaByName[name] = { ...(metaByName[name] ?? { name }), color: c }
        })
      }
      if (Array.isArray(sync?.availableLists)) {
        for (const entry of sync.availableLists) {
          if (entry && typeof entry.name === 'string') {
            metaByName[entry.name] = {
              ...(metaByName[entry.name] ?? { name: entry.name }),
              ...(entry.color ? { color: resolveHexColor(entry.color) } : {}),
              ...(entry.icon ? { icon: entry.icon } : {}),
            }
          }
        }
      }
      if (Array.isArray(sync?.listMeta)) {
        for (const entry of sync.listMeta) {
          if (entry && typeof entry.name === 'string') {
            metaByName[entry.name] = {
              ...(metaByName[entry.name] ?? { name: entry.name }),
              ...entry,
              ...(entry.color ? { color: resolveHexColor(entry.color) } : {}),
            }
          }
        }
      }

      const itemList = (item) => (typeof item.list === 'string' && item.list !== '' ? item.list : defaultList)

      const allListNames = [...configuredLists]
      if (Array.isArray(sync?.listMeta)) {
        for (const entry of sync.listMeta) {
          if (entry && typeof entry.name === 'string' && entry.pinned === true && !allListNames.includes(entry.name)) {
            allListNames.push(entry.name)
          }
        }
      }
      for (const item of items) {
        const ln = itemList(item)
        if (!allListNames.includes(ln)) allListNames.push(ln)
      }

      const colourOf = (name) => {
        const c = metaByName[name]?.color
        if (typeof c === 'string' && c !== '') return c
        let hash = 0
        for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0
        return LIST_COLORS[hash % LIST_COLORS.length].hex
      }

      const iconOf = (name) => {
        const ic = metaByName[name]?.icon
        const text = typeof ic === 'string' ? ic.trim() : ''
        if (text === '') return ''
        // Apple stores its own emoji emblems as {"Emoji":"👏"}; show the emoji only.
        if (!text.startsWith('{')) return text
        try {
          const parsed = JSON.parse(text)
          for (const key of ['Emoji', 'emoji', 'Value', 'value', 'Char', 'char', 'Text', 'text']) {
            const value = parsed === null || typeof parsed !== 'object' ? undefined : parsed[key]
            if (typeof value === 'string' && value.trim() !== '') return value.trim()
          }
        } catch {
          // Not JSON; nothing renderable.
        }
        return ''
      }

      const isPinned = (name) => metaByName[name]?.pinned === true

      const sectionsOf = (name) => {
        const base = Array.isArray(metaByName[name]?.sections) ? [...metaByName[name].sections] : []
        for (const it of items) {
          if (itemList(it) === name && typeof it.section === 'string' && it.section !== '' && !base.includes(it.section)) {
            base.push(it.section)
          }
        }
        return base
      }

      const today = todayPrefix()
      const tomorrow = addDays(today, 1)
      const weekEnd = endOfThisWeek(today)

      const openItems = items.filter((item) => !item.done)
      const doneItems = items.filter((item) => item.done)

      const dueTodayOrOverdue = openItems.filter((item) => typeof item.due === 'string' && item.due !== '' && item.due <= today)
      const scheduledOpen = openItems.filter((item) => typeof item.due === 'string' && item.due !== '')
      const flaggedOpen = openItems.filter((item) => item.flagged === true)
      const urgentOpen = openItems.filter((item) => item.urgent === true || normalizePriorityBucket(item.priority) === 1)

      const openCountByList = {}
      for (const ln of allListNames) openCountByList[ln] = 0
      for (const it of openItems) {
        const ln = itemList(it)
        openCountByList[ln] = (openCountByList[ln] ?? 0) + 1
      }

      const allTags = []
      for (const it of items) {
        if (Array.isArray(it.tags)) {
          for (const tg of it.tags) {
            if (typeof tg === 'string' && tg !== '' && !allTags.includes(tg)) allTags.push(tg)
          }
        }
      }
      allTags.sort((a, b) => a.localeCompare(b))

      const trashCount = trash.length > 0
        ? trash.length
        : (typeof sync?.trashCount === 'number' ? sync.trashCount : 0)

      const pinnedListNames = allListNames.filter((name) => isPinned(name))
      const hasGroceriesList = allListNames.some((n) => {
        const low = n.trim().toLowerCase()
        return low === 'groceries' || low === '购物单'
      })

      // =====================================================================
      // Inline Editor & View Navigation Helpers
      // =====================================================================

      const commitActiveDraftIfNeeded = (ed = editorStateRef.current ?? editorState) => {
        if (!ed) return
        if (ed.mode === 'new') {
          const trimmed = ed.text.trim()
          if (trimmed !== '') {
            const op = {
              op: 'add',
              text: trimmed,
              list: ed.list || defaultList,
            }
            if (ed.notes.trim() !== '') op.notes = ed.notes.trim()
            if (ed.due) op.due = ed.due
            if (ed.dueTime) op.dueTime = ed.dueTime
            if (ed.urgent) op.urgent = true
            if (ed.flagged) op.flagged = true
            if (ed.priority > 0) op.priority = ed.priority
            if (ed.tags.length > 0) op.tags = ed.tags
            if (ed.url.trim() !== '') op.url = ed.url.trim()
            if (ed.repeat && ed.repeat !== 'none') op.repeat = ed.repeat
            if (ed.location.trim() !== '') op.location = ed.location.trim()
            if (ed.section) op.section = ed.section
            if (ed.parentId) op.parentId = ed.parentId
            void run(op)
          }
        } else if (ed.mode === 'edit' && ed.id) {
          const orig = items.find((i) => i.id === ed.id)
          if (orig) {
            const patch = {}
            const nextText = ed.text.trim()
            if (nextText !== '' && nextText !== orig.text) patch.text = nextText
            if ((orig.notes ?? '') !== ed.notes) patch.notes = ed.notes
            if ((orig.url ?? '') !== ed.url.trim()) patch.url = ed.url.trim()
            if (Object.keys(patch).length > 0) {
              void run({ op: 'update', id: orig.id, patch })
            }
          }
        }
      }

      const closeEditor = (shouldCommit = true) => {
        const currentEd = editorStateRef.current ?? editorState
        if (shouldCommit) commitActiveDraftIfNeeded(currentEd)
        editorStateRef.current = null
        setEditorState(null)
        setPopover((curr) => (curr && ['date', 'time', 'repeat', 'location', 'tag', 'inspector'].includes(curr.kind) ? null : curr))
      }

      const getEditorBucket = (ed) => {
        if (!ed || ed.mode !== 'new') return ''
        if (view === 'today') {
          if (ed.dueTime >= '18:00') return 'tonight'
          if (ed.dueTime >= '12:00') return 'afternoon'
          return 'morning'
        }
        if (view === 'planned') {
          if (ed.due === today) return 'plan:today'
          if (ed.due === tomorrow) return 'plan:tomorrow'
          if (ed.due > tomorrow && ed.due <= weekEnd) return 'plan:week'
          if (ed.due > weekEnd) return 'plan:later'
          return 'plan:other'
        }
        if (view === 'all') {
          return `all:${ed.list || defaultList}`
        }
        if (view.startsWith('list:')) {
          return ed.section ? `sec:${ed.list || defaultList}:${ed.section}` : `list:${ed.list || defaultList}`
        }
        return view
      }

      editorDismissHelpersRef.current = { getEditorBucket, closeEditor }

      const selectView = (nextView) => {
        closeEditor(true)
        setSearch('')
        setView(nextView)
        if (narrowRef.current) setSidebarOpen(false)
      }

      const openEditorForItem = (item, openInspectorImmediately = false) => {
        if (editorState?.mode === 'edit' && editorState.id === item.id) {
          if (openInspectorImmediately) {
            setPopover(popover?.kind === 'inspector' ? null : { kind: 'inspector' })
          }
          return
        }
        commitActiveDraftIfNeeded()
        setEditorState({
          mode: 'edit',
          id: item.id,
          text: item.text ?? '',
          notes: item.notes ?? '',
          tagInput: '',
          tags: Array.isArray(item.tags) ? [...item.tags] : [],
          due: item.due ?? '',
          dueTime: item.dueTime ?? '',
          urgent: item.urgent === true,
          repeat: item.repeat ?? 'none',
          location: item.location ?? '',
          flagged: item.flagged === true,
          url: item.url ?? '',
          priority: normalizePriorityBucket(item.priority),
          list: itemList(item),
          section: item.section ?? '',
          parentId: item.parentId ?? '',
          subtaskDraft: '',
        })
        setPopover(openInspectorImmediately ? { kind: 'inspector' } : null)
      }

      const openNewDraft = (overrides = {}) => {
        commitActiveDraftIfNeeded()
        const currentList = view.startsWith('list:') ? view.slice(5) : defaultList
        const currentTag = view.startsWith('tag:') ? view.slice(4) : ''
        const base = {
          mode: 'new',
          text: '',
          notes: '',
          tagInput: '',
          tags: currentTag ? [currentTag] : [],
          due: view === 'today' || view === 'planned' || view === 'urgent' ? today : '',
          dueTime: view === 'today' || view === 'urgent' ? '09:00' : '',
          urgent: view === 'urgent',
          repeat: 'none',
          location: '',
          flagged: view === 'flagged',
          url: '',
          priority: 0,
          list: currentList,
          section: '',
          parentId: '',
          subtaskDraft: '',
          ...overrides,
        }
        editorStateRef.current = base
        setEditorState(base)
        setPopover(null)
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
          window.requestAnimationFrame(() => titleInputRef.current?.focus?.())
        }
      }

      const handleSectionAddClick = (bucketKey, overrides = {}) => {
        const dismissed = justDismissedRef.current
        if (dismissed && Date.now() - dismissed.at < 250 && dismissed.bucket === bucketKey) {
          justDismissedRef.current = null
          return
        }
        justDismissedRef.current = null
        openNewDraft(overrides)
      }

      const handleClickSpaceAdd = (overrides = {}) => {
        const dismissed = justDismissedRef.current
        if (dismissed && Date.now() - dismissed.at < 250) {
          justDismissedRef.current = null
          return
        }
        justDismissedRef.current = null
        if (!editorStateRef.current) openNewDraft(overrides)
      }

      const updateEditorField = (fields, immediatePatch = null) => {
        setEditorState((prev) => {
          const next = prev ? { ...prev, ...fields } : prev
          editorStateRef.current = next
          return next
        })
        const currentEd = editorStateRef.current
        if (immediatePatch && currentEd?.mode === 'edit' && currentEd.id) {
          void run({ op: 'update', id: currentEd.id, patch: immediatePatch })
        }
      }

      const addTagToEditor = (rawTag) => {
        if (!editorState) return
        const clean = rawTag.replace(/^#+/, '').trim().toLowerCase()
        if (clean === '') return
        const nextTags = editorState.tags.includes(clean) ? editorState.tags : [...editorState.tags, clean]
        updateEditorField({ tags: nextTags, tagInput: '' }, { tags: nextTags })
      }

      const removeTagFromEditor = (tagToRemove) => {
        if (!editorState) return
        const nextTags = editorState.tags.filter((tg) => tg !== tagToRemove)
        updateEditorField({ tags: nextTags }, { tags: nextTags })
      }

      const toggleGroup = (key) => {
        setCollapsed((curr) => ({ ...curr, [key]: curr[key] !== true }))
      }

      const toggleShowCompleted = (key) => {
        setShowCompletedMap((curr) => ({ ...curr, [key]: curr[key] !== true }))
      }

      // =====================================================================
      // Inline Quick-Action Pills & Inspector Renderers
      // =====================================================================

      const renderEditorPopover = (ed, siblingPrevId) => {
        if (!popover) return null
        const kind = popover.kind

        if (kind === 'date') {
          return h('div', { className: 'ar-popover' },
            h('div', { className: 'ar-pop-row' },
              h('span', { className: 'ar-pop-label' }, t('editor.date')),
              h('button', {
                type: 'button',
                className: ed.due === today ? 'ar-pop-chip ar-pop-chip--on' : 'ar-pop-chip',
                onClick: () => { updateEditorField({ due: today }, { due: today }); setPopover(null) },
              }, t('editor.date.today')),
              h('button', {
                type: 'button',
                className: ed.due === tomorrow ? 'ar-pop-chip ar-pop-chip--on' : 'ar-pop-chip',
                onClick: () => { updateEditorField({ due: tomorrow }, { due: tomorrow }); setPopover(null) },
              }, t('editor.date.tomorrow')),
              h('button', {
                type: 'button',
                className: 'ar-pop-chip',
                onClick: () => {
                  const wk = upcomingWeekend(today)
                  updateEditorField({ due: wk }, { due: wk })
                  setPopover(null)
                },
              }, t('editor.date.weekend'))),
            h('div', { className: 'ar-pop-row' },
              h('span', { className: 'ar-pop-label' }, t('editor.date.custom')),
              h('input', {
                type: 'date',
                className: 'ar-pop-input',
                value: ed.due,
                'aria-label': t('editor.due'),
                onChange: (e) => updateEditorField(
                  { due: e.target.value, ...(e.target.value === '' ? { dueTime: '' } : {}) },
                  { due: e.target.value }
                ),
              }),
              ed.due !== '' ? h('button', {
                type: 'button',
                className: 'ar-action-link ar-action-link--danger',
                onClick: () => { updateEditorField({ due: '', dueTime: '' }, { due: '', dueTime: '' }); setPopover(null) },
              }, t('editor.clearDue')) : null))
        }

        if (kind === 'time') {
          const applyTime = (hhmm) => {
            const nextDue = ed.due || today
            updateEditorField({ due: nextDue, dueTime: hhmm }, { due: nextDue, dueTime: hhmm })
            setPopover(null)
          }
          return h('div', { className: 'ar-popover' },
            h('div', { className: 'ar-pop-row' },
              h('span', { className: 'ar-pop-label' }, t('editor.time')),
              h('button', { type: 'button', className: ed.dueTime === '09:00' ? 'ar-pop-chip ar-pop-chip--on' : 'ar-pop-chip', onClick: () => applyTime('09:00') }, t('editor.time.morning')),
              h('button', { type: 'button', className: ed.dueTime === '15:00' ? 'ar-pop-chip ar-pop-chip--on' : 'ar-pop-chip', onClick: () => applyTime('15:00') }, t('editor.time.afternoon')),
              h('button', { type: 'button', className: ed.dueTime === '20:00' ? 'ar-pop-chip ar-pop-chip--on' : 'ar-pop-chip', onClick: () => applyTime('20:00') }, t('editor.time.tonight'))),
            h('div', { className: 'ar-pop-row' },
              h('span', { className: 'ar-pop-label' }, t('editor.time.custom')),
              h('input', {
                type: 'time',
                className: 'ar-pop-input',
                value: ed.dueTime,
                onChange: (e) => {
                  const val = e.target.value
                  const nextDue = val ? (ed.due || today) : ed.due
                  updateEditorField({ due: nextDue, dueTime: val }, { due: nextDue, dueTime: val })
                },
              }),
              ed.dueTime !== '' ? h('button', {
                type: 'button',
                className: 'ar-action-link ar-action-link--danger',
                onClick: () => { updateEditorField({ dueTime: '' }, { dueTime: '' }); setPopover(null) },
              }, t('editor.clearTime')) : null))
        }

        if (kind === 'repeat') {
          return h('div', { className: 'ar-popover' },
            h('div', { className: 'ar-pop-row' },
              h('span', { className: 'ar-pop-label' }, t('editor.repeat')),
              REPEAT_OPTIONS.map((rep) => h('button', {
                key: rep,
                type: 'button',
                className: (ed.repeat || 'none') === rep ? 'ar-pop-chip ar-pop-chip--on' : 'ar-pop-chip',
                onClick: () => {
                  const nextDue = rep !== 'none' && !ed.due ? today : ed.due
                  updateEditorField(
                    { repeat: rep, due: nextDue },
                    { repeat: rep === 'none' ? '' : rep, ...(nextDue !== ed.due ? { due: nextDue } : {}) }
                  )
                  setPopover(null)
                },
              }, t(`editor.repeat.${rep}`)))))
        }

        if (kind === 'location') {
          const presets = [
            { key: 'home', label: t('editor.location.home') },
            { key: 'work', label: t('editor.location.work') },
            { key: 'car', label: t('editor.location.car') },
          ]
          return h('div', { className: 'ar-popover' },
            h('div', { className: 'ar-pop-row' },
              h('span', { className: 'ar-pop-label' }, t('editor.location')),
              presets.map((p) => h('button', {
                key: p.key,
                type: 'button',
                className: ed.location === p.label ? 'ar-pop-chip ar-pop-chip--on' : 'ar-pop-chip',
                onClick: () => { updateEditorField({ location: p.label }, { location: p.label }); setPopover(null) },
              }, p.label))),
            h('div', { className: 'ar-pop-row' },
              h('input', {
                type: 'text',
                className: 'ar-pop-input',
                value: ed.location,
                placeholder: t('editor.location.custom'),
                onChange: (e) => updateEditorField({ location: e.target.value }),
                onBlur: () => updateEditorField({}, { location: ed.location.trim() }),
                onKeyDown: (e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    updateEditorField({}, { location: ed.location.trim() })
                    setPopover(null)
                  }
                },
              }),
              ed.location !== '' ? h('button', {
                type: 'button',
                className: 'ar-action-link ar-action-link--danger',
                onClick: () => { updateEditorField({ location: '' }, { location: '' }); setPopover(null) },
              }, t('editor.location.none')) : null))
        }

        if (kind === 'tag') {
          return h('div', { className: 'ar-popover' },
            h('div', { className: 'ar-pop-row' },
              h('span', { className: 'ar-pop-label' }, t('sidebar.tags')),
              allTags.length === 0
                ? h('span', { style: { color: 'var(--ar-text-muted)', fontSize: '12px' } }, t('editor.tagPlaceholder'))
                : allTags.map((tg) => h('button', {
                  key: tg,
                  type: 'button',
                  className: ed.tags.includes(tg) ? 'ar-pop-chip ar-pop-chip--on' : 'ar-pop-chip',
                  onClick: () => (ed.tags.includes(tg) ? removeTagFromEditor(tg) : addTagToEditor(tg)),
                }, `#${tg}`))))
        }

        if (kind === 'inspector') {
          const listSections = sectionsOf(ed.list || defaultList)
          const childSubtasks = ed.mode === 'edit' && ed.id
            ? items.filter((c) => c.parentId === ed.id)
            : []

          return h('div', { className: 'ar-popover', 'data-ar-inspector': 'true' },
            h('div', { className: 'ar-pop-row' },
              h('span', { className: 'ar-pop-label' }, t('editor.priority')),
              PRIORITIES.map((val) => {
                const bangs = priorityBangs(val)
                const label = bangs ? `${t(`priority.${val}`)} ${bangs}` : t(`priority.${val}`)
                return h('button', {
                  key: String(val),
                  type: 'button',
                  className: ed.priority === val ? 'ar-pop-chip ar-pop-chip--on' : 'ar-pop-chip',
                  'aria-pressed': ed.priority === val,
                  onClick: () => updateEditorField({ priority: val }, { priority: val }),
                }, label)
              })),
            h('div', { className: 'ar-pop-row' },
              h('span', { className: 'ar-pop-label' }, t('list.label')),
              allListNames.map((ln) => h('button', {
                key: ln,
                type: 'button',
                className: ed.list === ln ? 'ar-pop-chip ar-pop-chip--on' : 'ar-pop-chip',
                onClick: () => updateEditorField({ list: ln, section: '' }, { list: ln, section: '' }),
              }, ln))),
            listSections.length > 0 ? h('div', { className: 'ar-pop-row' },
              h('span', { className: 'ar-pop-label' }, t('editor.section')),
              h('button', {
                type: 'button',
                className: ed.section === '' ? 'ar-pop-chip ar-pop-chip--on' : 'ar-pop-chip',
                onClick: () => updateEditorField({ section: '' }, { section: '' }),
              }, t('editor.sectionNone')),
              listSections.map((sec) => h('button', {
                key: sec,
                type: 'button',
                className: ed.section === sec ? 'ar-pop-chip ar-pop-chip--on' : 'ar-pop-chip',
                onClick: () => updateEditorField({ section: sec }, { section: sec }),
              }, sec))) : null,
            h('div', { className: 'ar-pop-row' },
              h('span', { className: 'ar-pop-label' }, t('editor.url')),
              h('input', {
                type: 'url',
                className: 'ar-pop-input',
                value: ed.url,
                placeholder: t('editor.urlPlaceholder'),
                onChange: (e) => updateEditorField({ url: e.target.value }),
                onBlur: () => updateEditorField({}, { url: ed.url.trim() }),
              })),
            ed.mode === 'edit' && ed.id ? h('div', { className: 'ar-pop-row', style: { alignItems: 'flex-start', flexDirection: 'column' } },
              h('span', { className: 'ar-pop-label' }, `${t('editor.subtasks')} (${childSubtasks.length})`),
              childSubtasks.map((sub) => h('div', { key: sub.id, style: { display: 'flex', alignItems: 'center', gap: '6px', width: '100%' } },
                h('button', {
                  type: 'button',
                  className: sub.done ? 'ar-check ar-check--done' : 'ar-check',
                  onClick: () => { void run({ op: 'toggle', id: sub.id }) },
                }, sub.done ? h(CheckGlyph) : null),
                h('span', { style: { flex: 1, textDecoration: sub.done ? 'line-through' : 'none', fontSize: '12px' } }, sub.text),
                h('button', {
                  type: 'button',
                  className: 'ar-mini-btn',
                  onClick: () => { void run({ op: 'remove', id: sub.id }) },
                }, '×'))),
              h('div', { style: { display: 'flex', gap: '6px', width: '100%' } },
                h('input', {
                  type: 'text',
                  className: 'ar-pop-input',
                  value: ed.subtaskDraft ?? '',
                  placeholder: t('editor.addSubtask'),
                  onChange: (e) => updateEditorField({ subtaskDraft: e.target.value }),
                  onKeyDown: (e) => {
                    if (e.key === 'Enter' && !e.nativeEvent?.isComposing) {
                      e.preventDefault()
                      const st = (ed.subtaskDraft ?? '').trim()
                      if (st !== '') {
                        updateEditorField({ subtaskDraft: '' })
                        void run({ op: 'add', text: st, list: ed.list, section: ed.section, parentId: ed.id })
                      }
                    }
                  },
                }),
                ed.parentId ? h('button', {
                  type: 'button',
                  className: 'ar-pop-chip',
                  onClick: () => updateEditorField({ parentId: '' }, { parentId: '' }),
                }, t('editor.outdent')) : (siblingPrevId ? h('button', {
                  type: 'button',
                  className: 'ar-pop-chip',
                  onClick: () => updateEditorField({ parentId: siblingPrevId }, { parentId: siblingPrevId }),
                }, t('editor.indent')) : null))) : null,
            h('div', { className: 'ar-pop-row', style: { justifyContent: 'space-between', marginTop: '2px' } },
              ed.mode === 'edit' && ed.id
                ? h('button', {
                  type: 'button',
                  className: 'ar-action-link ar-action-link--danger',
                  onClick: () => {
                    const delId = ed.id
                    closeEditor(false)
                    void run({ op: 'remove', id: delId })
                  },
                }, t('delete'))
                : h('span', null),
              h('button', {
                type: 'button',
                className: 'ar-action-link',
                onClick: () => closeEditor(true),
              }, t('manage.done'))))
        }

        return null
      }

      const renderInlineEditor = (ed, siblingPrevId = null) => {
        const isDraft = ed.mode === 'new'
        const listHex = colourOf(ed.list || defaultList)
        const hasDue = ed.due !== ''
        const hasTime = ed.dueTime !== ''
        const hasRepeat = ed.repeat && ed.repeat !== 'none'
        const hasLoc = ed.location.trim() !== ''

        return h('li', {
          ref: editorRef,
          key: isDraft ? '__inline_draft__' : ed.id,
          className: ed.parentId ? 'ar-inline-editor ar-row--subtask' : 'ar-inline-editor',
          'data-ar-editor': isDraft ? 'new' : ed.id,
          onMouseDown: (e) => {
            pointerInEditorRef.current = true
            const schedule = typeof window !== 'undefined' && typeof window.setTimeout === 'function'
              ? window.setTimeout
              : setTimeout
            schedule(() => { pointerInEditorRef.current = false }, 0)
            const target = e?.target
            if (target && typeof target.closest === 'function') {
              const isInputLike = Boolean(target.closest('input, textarea, select, [contenteditable="true"]'))
              if (!isInputLike && typeof e.preventDefault === 'function') {
                e.preventDefault()
              }
            }
          },
          onBlur: () => {
            const schedule = typeof window !== 'undefined' && typeof window.setTimeout === 'function'
              ? window.setTimeout
              : setTimeout
            schedule(() => {
              if (pointerInEditorRef.current) return
              if (editorRef.current && typeof document !== 'undefined' && document.activeElement && typeof editorRef.current.contains === 'function' && editorRef.current.contains(document.activeElement)) {
                return
              }
              const currentEd = editorStateRef.current
              if (!currentEd) return
              if (currentEd.mode === 'new' && currentEd.text.trim() === '') {
                closeEditor(false)
              } else {
                closeEditor(true)
              }
            }, 0)
          },
        },
        h('div', { className: 'ar-ie-top' },
          h('button', {
            type: 'button',
            className: isDraft ? 'ar-check ar-check--draft' : 'ar-check',
            style: isDraft ? undefined : { borderColor: listHex },
            onClick: () => {
              if (!isDraft && ed.id) {
                closeEditor(true)
                void run({ op: 'toggle', id: ed.id })
              }
            },
            'aria-label': t('done.aria', { text: ed.text || t('editor.titlePlaceholder') }),
          }),
          h('input', {
            ref: titleInputRef,
            type: 'text',
            className: 'ar-ie-title',
            value: ed.text,
            placeholder: t('editor.titlePlaceholder'),
            'aria-label': t('input.label'),
            onChange: (e) => updateEditorField({ text: e.target.value }),
            onKeyDown: (e) => {
              if (e.nativeEvent?.isComposing) return
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                closeEditor(true)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                closeEditor(!isDraft)
              }
            },
          }),
          h('button', {
            type: 'button',
            className: 'ar-icon-btn ar-icon-btn--info',
            'aria-label': t('editor.details'),
            title: t('editor.details'),
            onClick: () => setPopover(popover?.kind === 'inspector' ? null : { kind: 'inspector' }),
          }, h(InfoCircleIcon))),

        h('div', { className: 'ar-ie-fields' },
          h('input', {
            type: 'text',
            className: 'ar-ie-notes',
            value: ed.notes,
            placeholder: t('editor.notesPlaceholder'),
            'aria-label': t('editor.notes.aria', { text: ed.text }),
            onChange: (e) => updateEditorField({ notes: e.target.value }),
            onBlur: () => {
              if (!isDraft) updateEditorField({}, { notes: ed.notes })
            },
            onKeyDown: (e) => {
              if (e.key === 'Escape') { e.preventDefault(); closeEditor(!isDraft) }
            },
          }),
          h('div', { className: 'ar-ie-tags-row' },
            ed.tags.map((tg) => h('span', { key: tg, className: 'ar-ie-tag-chip' },
              `#${tg}`,
              h('button', {
                type: 'button',
                className: 'ar-ie-tag-x',
                onClick: () => removeTagFromEditor(tg),
              }, '×'))),
            h('input', {
              ref: tagInputRef,
              type: 'text',
              className: 'ar-ie-tag-input',
              value: ed.tagInput,
              placeholder: ed.tags.length === 0 ? t('editor.addTags') : t('editor.tagPlaceholder'),
              onChange: (e) => updateEditorField({ tagInput: e.target.value }),
              onKeyDown: (e) => {
                if (e.nativeEvent?.isComposing) return
                if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
                  if (ed.tagInput.trim() !== '') {
                    e.preventDefault()
                    addTagToEditor(ed.tagInput)
                  }
                } else if (e.key === 'Backspace' && ed.tagInput === '' && ed.tags.length > 0) {
                  removeTagFromEditor(ed.tags[ed.tags.length - 1])
                }
              },
              onBlur: () => {
                if (ed.tagInput.trim() !== '') addTagToEditor(ed.tagInput)
              },
            })),

          // 8 Quick-Action Pills matching macOS Reminders screenshot
          h('div', { className: 'ar-quick-pills' },
            // 1. Date Pill
            h('button', {
              type: 'button',
              className: hasDue ? 'ar-qpill ar-qpill--blue' : 'ar-qpill',
              onClick: () => setPopover(popover?.kind === 'date' ? null : { kind: 'date' }),
            },
            h(CalendarPillIcon),
            hasDue ? h('span', null, formatDuePill(ed.due, today, tomorrow, t)) : null,
            hasDue ? h('span', {
              className: 'ar-qpill-clear',
              role: 'button',
              onClick: (e) => {
                e.stopPropagation()
                updateEditorField({ due: '', dueTime: '' }, { due: '', dueTime: '' })
              },
            }, '×') : null),

            // 2. Time Pill
            h('button', {
              type: 'button',
              className: hasTime ? 'ar-qpill ar-qpill--blue' : 'ar-qpill',
              onClick: () => setPopover(popover?.kind === 'time' ? null : { kind: 'time' }),
            },
            h(ClockPillIcon, { filled: hasTime }),
            hasTime ? h('span', null, ed.dueTime) : null,
            hasTime ? h('span', {
              className: 'ar-qpill-clear',
              role: 'button',
              onClick: (e) => {
                e.stopPropagation()
                updateEditorField({ dueTime: '' }, { dueTime: '' })
              },
            }, '×') : null),

            // 3. Urgent Alarm Pill ((⏰))
            h('button', {
              type: 'button',
              className: ed.urgent ? 'ar-qpill ar-qpill--pink' : 'ar-qpill',
              title: t('editor.urgent'),
              'aria-pressed': ed.urgent,
              onClick: () => {
                const nextUrgent = !ed.urgent
                updateEditorField({ urgent: nextUrgent }, { urgent: nextUrgent })
              },
            }, h(RingingAlarmIcon)),

            // 4. Repeat Pill
            h('button', {
              type: 'button',
              className: hasRepeat ? 'ar-qpill ar-qpill--blue' : 'ar-qpill',
              title: t('editor.repeat'),
              onClick: () => setPopover(popover?.kind === 'repeat' ? null : { kind: 'repeat' }),
            },
            h(RepeatIcon),
            hasRepeat ? h('span', null, t(`editor.repeat.${ed.repeat}`)) : null,
            hasRepeat ? h('span', {
              className: 'ar-qpill-clear',
              role: 'button',
              onClick: (e) => {
                e.stopPropagation()
                updateEditorField({ repeat: 'none' }, { repeat: '' })
              },
            }, '×') : null),

            // 5. Location Pill
            h('button', {
              type: 'button',
              className: hasLoc ? 'ar-qpill ar-qpill--blue' : 'ar-qpill',
              title: t('editor.location'),
              onClick: () => setPopover(popover?.kind === 'location' ? null : { kind: 'location' }),
            },
            h(LocationArrowIcon),
            hasLoc ? h('span', null, ed.location) : null,
            hasLoc ? h('span', {
              className: 'ar-qpill-clear',
              role: 'button',
              onClick: (e) => {
                e.stopPropagation()
                updateEditorField({ location: '' }, { location: '' })
              },
            }, '×') : null),

            // 6. Tag Pill (#)
            h('button', {
              type: 'button',
              className: ed.tags.length > 0 ? 'ar-qpill ar-qpill--blue' : 'ar-qpill',
              title: t('sidebar.tags'),
              onClick: () => {
                tagInputRef.current?.focus?.()
                setPopover(popover?.kind === 'tag' ? null : { kind: 'tag' })
              },
            }, h(HashTagIcon)),

            // 7. Flag Pill
            h('button', {
              type: 'button',
              className: ed.flagged ? 'ar-qpill ar-qpill--orange' : 'ar-qpill',
              title: t('editor.flag'),
              'aria-pressed': ed.flagged,
              onClick: () => {
                const nextFlag = !ed.flagged
                updateEditorField({ flagged: nextFlag }, { flagged: nextFlag })
              },
            }, h(FlagIcon, { filled: ed.flagged })),

            // 8. Subtask / Indent Pill
            h('button', {
              type: 'button',
              className: ed.parentId ? 'ar-qpill ar-qpill--blue' : 'ar-qpill',
              title: t('editor.subtasks'),
              onClick: () => {
                if (!isDraft && siblingPrevId && !ed.parentId) {
                  updateEditorField({ parentId: siblingPrevId }, { parentId: siblingPrevId })
                } else if (!isDraft && ed.parentId) {
                  updateEditorField({ parentId: '' }, { parentId: '' })
                } else {
                  setPopover({ kind: 'inspector' })
                }
              },
            }, h(SubtaskIndentIcon))),

          renderEditorPopover(ed, siblingPrevId)))
      }

      // =====================================================================
      // Collapsed Task Row Renderer (with Subtasks)
      // =====================================================================

      const renderTaskRow = (item, opts = {}) => {
        if (editorState?.mode === 'edit' && editorState.id === item.id) {
          return renderInlineEditor(editorState, opts.prevSiblingId ?? null)
        }

        const ln = itemList(item)
        const listHex = colourOf(ln)
        const bangs = priorityBangs(item.priority)
        const pBucket = normalizePriorityBucket(item.priority)
        const overdue = !item.done && typeof item.due === 'string' && item.due !== '' && item.due < today
        const safeUrl = sanitizeExternalUrl(item.url)
        const children = opts.enableSubtasks
          ? items.filter((c) => c.parentId === item.id && (opts.includeDone || !c.done))
          : []
        const subtasksFolded = collapsed[`sub:${item.id}`] === true

        const metaNodes = []
        if (opts.showListName) {
          metaNodes.push(h('span', { key: 'list', style: { color: listHex, fontWeight: 500 } }, ln))
        }
        if (typeof item.due === 'string' && item.due !== '') {
          const dLabel = formatDuePill(item.due, today, tomorrow, t)
          const dtText = item.dueTime ? `${dLabel} ${item.dueTime}` : dLabel
          metaNodes.push(h('span', {
            key: 'due',
            className: overdue ? 'ar-meta-overdue' : undefined,
            title: overdue ? t('row.overdue') : undefined,
          }, dtText))
        }
        if (item.urgent === true) {
          metaNodes.push(h('span', { key: 'urgent', className: 'ar-meta-urgent' },
            h(RingingAlarmIcon, { size: 12 }),
            t('editor.urgent')))
        }
        if (typeof item.repeat === 'string' && item.repeat !== '' && item.repeat !== 'none') {
          metaNodes.push(h('span', { key: 'repeat' }, `↻ ${t(`editor.repeat.${item.repeat}`)}`))
        }
        if (typeof item.location === 'string' && item.location !== '') {
          metaNodes.push(h('span', { key: 'loc' }, `📍 ${item.location}`))
        }
        if (pBucket > 0) {
          metaNodes.push(h('span', { key: 'prio' }, t(`priority.${pBucket}`)))
        }
        if (Array.isArray(item.tags)) {
          for (const tg of item.tags) {
            metaNodes.push(h('span', {
              key: `tag:${tg}`,
              className: 'ar-meta-tag',
              onClick: (e) => { e.stopPropagation(); selectView(`tag:${tg}`) },
            }, `#${tg}`))
          }
        }
        if (safeUrl) {
          metaNodes.push(h('a', {
            key: 'url',
            className: 'ar-meta-url',
            href: safeUrl,
            target: '_blank',
            rel: 'noopener noreferrer',
            onClick: (e) => e.stopPropagation(),
          }, `🔗 ${urlHostLabel(item.url)}`))
        }
        if (children.length > 0) {
          metaNodes.push(h('button', {
            key: 'subcount',
            type: 'button',
            className: 'ar-mini-btn',
            onClick: (e) => { e.stopPropagation(); toggleGroup(`sub:${item.id}`) },
          }, `${subtasksFolded ? '▸' : '▾'} ${children.length}`))
        }

        const rowNode = h('li', {
          key: item.id,
          className: `${item.done ? 'ar-row ar-row--done' : 'ar-row'}${opts.isSubtask ? ' ar-row--subtask' : ''}`,
          'data-dt-id': item.id,
        },
        h('div', { className: 'ar-row-main' },
          h('button', {
            type: 'button',
            className: item.done ? 'ar-check ar-check--done' : 'ar-check',
            style: item.done
              ? { '--ar-list-color': listHex, background: listHex, borderColor: listHex }
              : { '--ar-list-color': listHex, borderColor: listHex },
            role: 'checkbox',
            'aria-checked': item.done,
            'aria-label': item.done ? t('undo.aria', { text: item.text }) : t('done.aria', { text: item.text }),
            onClick: (e) => {
              e?.stopPropagation?.()
              const completedHidden = !item.done && !(opts.includeDone || showCompletedMap[view] === true) && view !== 'completed'
              const rowEl = completedHidden && typeof e?.currentTarget?.closest === 'function'
                ? e.currentTarget.closest('.ar-row')
                : null
              const reduced = typeof window !== 'undefined'
                && typeof window.matchMedia === 'function'
                && window.matchMedia('(prefers-reduced-motion: reduce)').matches
              if (rowEl && rowEl.classList && !reduced && typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
                if (rowEl.classList.contains('ar-row--completing')) return
                rowEl.classList.add('ar-row--completing')
                window.setTimeout(() => {
                  void run({ op: 'toggle', id: item.id })
                }, 240)
                return
              }
              void run({ op: 'toggle', id: item.id })
            },
          }, h(CheckGlyph)),

          h('div', {
            className: 'ar-row-body',
            onClick: () => openEditorForItem(item, false),
          },
          h('div', { className: 'ar-row-title-line' },
            bangs ? h('span', { className: 'ar-bangs', style: { color: listHex } }, bangs) : null,
            h('span', null, item.text)),
          typeof item.notes === 'string' && item.notes !== ''
            ? h('div', { className: 'ar-row-notes-preview' }, item.notes)
            : null,
          metaNodes.length > 0 ? h('div', { className: 'ar-meta-line' }, metaNodes) : null),

          h('div', { className: 'ar-row-actions' },
            h('button', {
              type: 'button',
              className: item.flagged === true ? 'ar-icon-btn ar-icon-btn--flagged' : 'ar-icon-btn',
              'aria-label': item.flagged === true ? t('unflag.aria', { text: item.text }) : t('flag.aria', { text: item.text }),
              onClick: (e) => { e.stopPropagation(); void run({ op: 'update', id: item.id, patch: { flagged: item.flagged !== true } }) },
            }, h(FlagIcon, { filled: item.flagged === true, size: 14 })),
            h('button', {
              type: 'button',
              className: 'ar-icon-btn',
              'aria-label': t('row.more', { text: item.text }),
              onClick: (e) => { e.stopPropagation(); openEditorForItem(item, true) },
            }, h(InfoCircleIcon, { size: 15 })),
            h('button', {
              type: 'button',
              className: 'ar-icon-btn',
              'aria-label': t('delete.aria', { text: item.text }),
              onClick: (e) => { e.stopPropagation(); void run({ op: 'remove', id: item.id }) },
            }, '×'))))

        if (children.length === 0 || subtasksFolded) return rowNode
        return h(React.Fragment ?? 'div', { key: `wrap:${item.id}` },
          rowNode,
          children.map((child, idx) => renderTaskRow(child, {
            isSubtask: true,
            enableSubtasks: false,
            prevSiblingId: idx > 0 ? children[idx - 1].id : item.id,
          })))
      }

      const sortTasks = (arr) => [...arr].sort((a, b) => {
        if (typeof a.order === 'number' && typeof b.order === 'number' && a.order !== b.order) {
          return a.order - b.order
        }
        const da = typeof a.due === 'string' && a.due !== '' ? a.due : '~~~~'
        const db = typeof b.due === 'string' && b.due !== '' ? b.due : '~~~~'
        if (da !== db) return da < db ? -1 : 1
        const ta = typeof a.dueTime === 'string' && a.dueTime !== '' ? a.dueTime : '~~:~~'
        const tb = typeof b.dueTime === 'string' && b.dueTime !== '' ? b.dueTime : '~~:~~'
        if (ta !== tb) return ta < tb ? -1 : 1
        return (a.text ?? '').localeCompare(b.text ?? '')
      })

      // =====================================================================
      // Sidebar Modals / Popovers (New List, Edit List, List Menu, Sync Lists)
      // =====================================================================

      const renderSidebarModal = () => {
        if (!popover) return null
        if (popover.kind === 'newList' || popover.kind === 'editList') {
          const isEdit = popover.kind === 'editList'
          const nameVal = popover.nameDraft ?? ''
          const colorVal = popover.colorDraft ?? '#0A84FF'
          const iconVal = popover.iconDraft ?? ''
          const pinnedVal = popover.pinnedDraft === true

          const submitList = () => {
            const trimmed = nameVal.trim()
            if (trimmed === '') return
            if (isEdit && popover.listName) {
              const payload = {
                op: 'update_list',
                name: popover.listName,
                color: colorVal,
                icon: iconVal,
                pinned: pinnedVal,
              }
              if (trimmed !== popover.listName) payload.newName = trimmed
              setPopover(null)
              void run(payload).then(() => {
                if (view === `list:${popover.listName}` && trimmed !== popover.listName) {
                  setView(`list:${trimmed}`)
                }
              })
            } else {
              setPopover(null)
              void run({
                op: 'create_list',
                name: trimmed,
                color: colorVal,
                icon: iconVal,
                pinned: pinnedVal,
              }).then(() => setView(`list:${trimmed}`))
            }
          }

          return h('div', { className: 'ar-popover', style: { margin: '0 4px 8px' } },
            h('div', { style: { fontWeight: 700, fontSize: '12.5px' } }, isEdit ? t('sidebar.editList') : t('sidebar.addList')),
            h('input', {
              type: 'text',
              className: 'ar-pop-input',
              value: nameVal,
              placeholder: t('sidebar.listName'),
              onChange: (e) => setPopover({ ...popover, nameDraft: e.target.value }),
              onKeyDown: (e) => { if (e.key === 'Enter' && !e.nativeEvent?.isComposing) submitList() },
            }),
            h('div', { className: 'ar-color-grid' },
              LIST_COLORS.map((c) => h('button', {
                key: c.id,
                type: 'button',
                className: colorVal.toLowerCase() === c.hex.toLowerCase() ? 'ar-color-dot ar-color-dot--on' : 'ar-color-dot',
                style: { background: c.hex },
                title: c.nameEn,
                onClick: () => setPopover({ ...popover, colorDraft: c.hex }),
              }))),
            h('div', { className: 'ar-pop-row' },
              LIST_EMOJIS.map((em) => h('button', {
                key: em || '__bullet__',
                type: 'button',
                className: iconVal === em ? 'ar-pop-chip ar-pop-chip--on' : 'ar-pop-chip',
                onClick: () => setPopover({ ...popover, iconDraft: em }),
              }, em || '≡'))),
            h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', cursor: 'pointer' } },
              h('input', {
                type: 'checkbox',
                checked: pinnedVal,
                onChange: (e) => setPopover({ ...popover, pinnedDraft: e.target.checked }),
              }),
              t('sidebar.pin')),
            h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '6px' } },
              h('button', { type: 'button', className: 'ar-mini-btn', onClick: () => setPopover(null) }, t('sidebar.cancel')),
              h('button', { type: 'button', className: 'ar-action-link', onClick: submitList }, t('sidebar.save'))))
        }

        if (popover.kind === 'syncLists') {
          const avail = Array.isArray(sync?.available) && sync.available.length > 0 ? sync.available : allListNames
          return h('div', { className: 'ar-popover', style: { margin: '4px 2px' } },
            h('div', { style: { fontSize: '11.5px', fontWeight: 600, color: 'var(--ar-text-secondary)' } }, t('manage.title')),
            h('div', { className: 'ar-pop-row' },
              avail.map((name) => {
                const active = configuredLists.includes(name)
                return h('button', {
                  key: name,
                  type: 'button',
                  className: active ? 'ar-pop-chip ar-pop-chip--on' : 'ar-pop-chip',
                  'aria-pressed': active,
                  onClick: () => {
                    const next = active ? configuredLists.filter((n) => n !== name) : [...configuredLists, name]
                    if (next.length === 0) return
                    void run({ op: 'select', lists: next })
                  },
                }, name)
              })),
            h('div', { style: { display: 'flex', justifyContent: 'flex-end' } },
              h('button', { type: 'button', className: 'ar-action-link', onClick: () => setPopover(null) }, t('manage.done'))))
        }

        return null
      }

      // =====================================================================
      // Left Sidebar Renderer (Exact Match to Screenshot)
      // =====================================================================

      const smartCards = [
        { id: 'today', label: t('view.today'), count: dueTodayOrOverdue.length, showCount: true, bg: TILE_COLORS.today.tintDark, icon: () => h(TodayCalendarIcon, { day: new Date().getDate() }) },
        { id: 'planned', label: t('view.planned'), count: scheduledOpen.length, showCount: true, bg: TILE_COLORS.planned.tintDark, icon: () => h(ScheduledIcon) },
        { id: 'all', label: t('view.all'), count: openItems.length, showCount: true, bg: TILE_COLORS.all.tintDark, icon: () => h(AllInboxIcon) },
        { id: 'flagged', label: t('view.flagged'), count: flaggedOpen.length, showCount: true, bg: TILE_COLORS.flagged.tintDark, icon: () => h(FlagIcon, { filled: true, size: 18 }) },
        { id: 'urgent', label: t('view.urgent'), count: urgentOpen.length, showCount: true, bg: TILE_COLORS.urgent.tintDark, icon: () => h(UrgentAlarmIcon) },
        { id: 'completed', label: t('view.completed'), count: doneItems.length, showCount: false, bg: TILE_COLORS.completed.tintDark, icon: () => h(CompletedCheckIcon) },
      ]

      const renderSidebar = () => h('aside', {
        className: sidebarOpen ? 'ar-sidebar' : 'ar-sidebar ar-sidebar--closed',
        'aria-label': t('sidebar.myLists'),
        'aria-hidden': !sidebarOpen,
      },
      h('div', { className: 'ar-sb-top' },
        h('button', {
          type: 'button',
          className: 'ar-circle-btn',
          'aria-label': t('sidebar.addList'),
          title: t('sidebar.addList'),
          onClick: () => setPopover(popover?.kind === 'newList'
            ? null
            : { kind: 'newList', nameDraft: '', colorDraft: '#0A84FF', iconDraft: '', pinnedDraft: false }),
        }, h(AddListIcon)),
        h('button', {
          type: 'button',
          className: 'ar-circle-btn',
          'aria-label': t('sidebar.toggle'),
          title: t('sidebar.toggle'),
          onClick: () => setSidebarOpen(false),
        }, h(SidebarToggleIcon))),

      h('div', { className: 'ar-sb-scroll' },
        popover && (popover.kind === 'newList' || popover.kind === 'editList') ? renderSidebarModal() : null,

        // 2-Column Smart Cards + Pinned Lists Grid
        h('div', { className: 'ar-smart-grid' },
          smartCards.map((card) => h('button', {
            key: card.id,
            type: 'button',
            className: view === card.id ? 'ar-smart-card ar-smart-card--on' : 'ar-smart-card',
            style: { background: card.bg },
            'aria-pressed': view === card.id,
            onClick: () => selectView(card.id),
          },
          h('div', { className: 'ar-smart-top' },
            card.icon(),
            card.showCount ? h('span', { className: 'ar-smart-count' }, String(card.count)) : h('span', null)),
          h('div', { className: 'ar-smart-label' }, card.label))),

          pinnedListNames.map((name) => {
            const hex = colourOf(name)
            const matchedColor = LIST_COLORS.find((c) => c.hex.toLowerCase() === hex.toLowerCase())
            const cardBg = matchedColor ? matchedColor.cardDark : TILE_COLORS.pinned.tintDark
            const ic = iconOf(name)
            const targetView = `list:${name}`
            return h('button', {
              key: `pin:${name}`,
              type: 'button',
              className: view === targetView ? 'ar-smart-card ar-smart-card--on' : 'ar-smart-card',
              style: { background: cardBg },
              'aria-pressed': view === targetView,
              onClick: () => selectView(targetView),
            },
            h('div', { className: 'ar-smart-top' },
              ic ? h('span', { style: { fontSize: '16px', lineHeight: 1 } }, ic) : h(ListBulletIcon, { size: 18 }),
              h('span', { className: 'ar-smart-count' }, String(openCountByList[name] ?? 0))),
            h('div', { className: 'ar-smart-label' }, name))
          })),

        // Suggested List: Groceries Banner
        !groceriesDismissed && !hasGroceriesList
          ? h('div', { className: 'ar-groceries' },
            h('div', { className: 'ar-groceries-icon' }, h(CarrotIcon)),
            h('div', { className: 'ar-groceries-body' },
              h('div', { className: 'ar-groceries-title' }, t('sidebar.suggestedTitle')),
              h('div', { className: 'ar-groceries-sub' }, t('sidebar.suggestedSub'))),
            h('button', {
              type: 'button',
              className: 'ar-groceries-add',
              'aria-label': t('sidebar.addList'),
              onClick: () => {
                const gLabel = t('view.groceries')
                const listTitle = gLabel && gLabel !== 'view.groceries' ? gLabel : 'Groceries'
                void run({ op: 'create_list', name: listTitle, color: '#30D158', icon: '🥕' }).then(() => {
                  selectView(`list:${listTitle}`)
                })
              },
            }, h(PlusIcon, { size: 13 })),
            h('button', {
              type: 'button',
              className: 'ar-groceries-dismiss',
              onClick: () => {
                setGroceriesDismissed(true)
                safeStorageSet(GROCERIES_DISMISSED_KEY, '1')
              },
            }, '×'))
          : null,

        // My Lists Section + Recently Deleted
        h('div', { className: 'ar-sb-section' },
          h('div', { className: 'ar-sb-heading-row' },
            h('span', { className: 'ar-sb-heading' }, t('sidebar.myLists')),
            h('div', { className: 'ar-sb-mini-actions' },
              h('button', {
                type: 'button',
                className: 'ar-mini-btn',
                onClick: () => {
                  if (popover?.kind !== 'syncLists') {
                    void callHost({ op: 'lists' }).then(accept, () => {})
                    setPopover({ kind: 'syncLists' })
                  } else {
                    setPopover(null)
                  }
                },
              }, t('manage.open')),
              h('button', {
                type: 'button',
                className: 'ar-mini-btn',
                onClick: () => setPopover({ kind: 'newList', nameDraft: '', colorDraft: '#0A84FF', iconDraft: '', pinnedDraft: false }),
              }, '+'))),

          popover?.kind === 'syncLists' ? renderSidebarModal() : null,

          allListNames.map((name) => {
            const targetView = `list:${name}`
            const hex = colourOf(name)
            const ic = iconOf(name)
            const menuOpen = popover?.kind === 'listMenu' && popover.listName === name
            return h('div', { key: `mylist:${name}` },
              h('div', {
                className: view === targetView ? 'ar-list-row ar-list-row--on' : 'ar-list-row',
                onClick: () => selectView(targetView),
              },
              h('span', { className: 'ar-list-badge', style: { background: hex } },
                ic ? ic : h(ListBulletIcon, { size: 14 })),
              h('span', { className: 'ar-list-name' }, name),
              h('button', {
                type: 'button',
                className: menuOpen ? 'ar-list-more ar-list-more--on' : 'ar-list-more',
                onClick: (e) => {
                  e.stopPropagation()
                  setPopover(menuOpen ? null : { kind: 'listMenu', listName: name })
                },
              }, '⋯'),
              h('span', { className: 'ar-list-count' }, String(openCountByList[name] ?? 0))),

              menuOpen ? h('div', { className: 'ar-popover', style: { margin: '4px 2px 6px' } },
                h('div', { className: 'ar-pop-row' },
                  h('button', {
                    type: 'button',
                    className: 'ar-pop-chip',
                    onClick: () => {
                      setPopover(null)
                      void run({ op: 'update_list', name, pinned: !isPinned(name) })
                    },
                  }, isPinned(name) ? t('sidebar.unpin') : t('sidebar.pin')),
                  h('button', {
                    type: 'button',
                    className: 'ar-pop-chip',
                    onClick: () => setPopover({
                      kind: 'editList',
                      listName: name,
                      nameDraft: name,
                      colorDraft: hex,
                      iconDraft: ic,
                      pinnedDraft: isPinned(name),
                    }),
                  }, t('sidebar.renameList')),
                  allListNames.length > 1 ? h('button', {
                    type: 'button',
                    className: 'ar-pop-chip',
                    style: { color: 'var(--ar-red)' },
                    onClick: () => {
                      setPopover(null)
                      if (view === targetView) setView('today')
                      void run({ op: 'delete_list', name })
                    },
                  }, t('sidebar.deleteList')) : null)) : null)
          }),

          // Recently Deleted Row
          h('div', {
            className: view === 'trash' ? 'ar-list-row ar-list-row--on' : 'ar-list-row',
            onClick: () => selectView('trash'),
          },
          h('span', { className: 'ar-list-badge ar-list-badge--trash' }, h(TrashIcon)),
          h('span', { className: 'ar-list-name' }, t('view.trash')),
          h('span', { className: 'ar-list-count' }, String(trashCount)))),

        // Tags Section
        h('div', { className: 'ar-sb-section' },
          h('div', { className: 'ar-sb-heading-row' },
            h('span', { className: 'ar-sb-heading' }, t('sidebar.tags'))),
          allTags.length > 0
            ? h('div', { className: 'ar-tags-wrap' },
              h('button', {
                type: 'button',
                className: view === 'tags' ? 'ar-tag-pill ar-tag-pill--on' : 'ar-tag-pill',
                onClick: () => selectView('tags'),
              }, t('sidebar.allTags')),
              allTags.map((tg) => h('button', {
                key: tg,
                type: 'button',
                className: view === `tag:${tg}` ? 'ar-tag-pill ar-tag-pill--on' : 'ar-tag-pill',
                onClick: () => selectView(`tag:${tg}`),
              }, `#${tg}`)))
            : null)))

      // =====================================================================
      // Right Main Pane Content Renderers per View
      // =====================================================================

      const resolveTitleAndColor = () => {
        if (search.trim() !== '') {
          return { title: t('search.results', { query: search.trim() }), color: 'var(--ar-text-primary)' }
        }
        if (view === 'today') return { title: t('view.today'), color: TILE_COLORS.today.active }
        if (view === 'planned') return { title: t('view.planned'), color: TILE_COLORS.planned.active }
        if (view === 'all') return { title: t('view.all'), color: 'var(--ar-text-primary)' }
        if (view === 'flagged') return { title: t('view.flagged'), color: TILE_COLORS.flagged.active }
        if (view === 'urgent') return { title: t('view.urgent'), color: TILE_COLORS.urgent.active }
        if (view === 'completed') return { title: t('view.completed'), color: TILE_COLORS.completed.active }
        if (view === 'trash') return { title: t('view.trash'), color: TILE_COLORS.completed.active }
        if (view === 'tags') return { title: t('sidebar.allTags'), color: TILE_COLORS.today.active }
        if (view.startsWith('tag:')) return { title: `#${view.slice(4)}`, color: TILE_COLORS.today.active }
        if (view.startsWith('list:')) {
          const ln = view.slice(5)
          return { title: ln, color: colourOf(ln) }
        }
        return { title: t('view.today'), color: TILE_COLORS.today.active }
      }

      const renderSectionList = (secKey, label, secItems, draftMatch, onAddClick, opts = {}) => {
        const headerAdds = Boolean(onAddClick && (opts.clickHeaderToAdd || secItems.length === 0))
        const folded = !headerAdds && collapsed[secKey] === true
        const headClass = [
          'ar-section-head',
          opts.overdue ? 'ar-section-head--overdue' : '',
          onAddClick ? 'ar-section-head--clickable' : '',
        ].filter(Boolean).join(' ')

        return h('div', { key: secKey, className: 'ar-section' },
          h('div', {
            className: headClass,
            onClick: onAddClick ? () => onAddClick() : undefined,
          },
          h('div', { style: { display: 'inline-flex', alignItems: 'center', gap: '4px' } },
            !headerAdds && secItems.length > 0 ? h('button', {
              type: 'button',
              className: folded ? 'ar-section-chevron ar-section-chevron--folded' : 'ar-section-chevron',
              'aria-expanded': !folded,
              'aria-label': label,
              onClick: (e) => {
                e?.stopPropagation?.()
                toggleGroup(secKey)
              },
            }, '▾') : null,
            h('button', {
              type: 'button',
              className: 'ar-section-title-btn',
              onClick: (e) => {
                e?.stopPropagation?.()
                if (headerAdds) {
                  onAddClick()
                } else {
                  toggleGroup(secKey)
                }
              },
            },
            opts.dotColor ? h('span', { style: { width: '9px', height: '9px', borderRadius: '50%', background: opts.dotColor } }) : null,
            h('span', null, label),
            secItems.length > 0 ? h('span', { style: { color: 'var(--ar-text-muted)', fontWeight: 500 } }, String(secItems.length)) : null)),
          onAddClick ? h('button', {
            type: 'button',
            className: 'ar-section-add',
            onClick: (e) => {
              e?.stopPropagation?.()
              onAddClick()
            },
            title: t('input.label'),
          }, '+') : null),
          folded ? null : h('ul', { className: 'ar-task-list' },
            secItems.map((it, idx) => renderTaskRow(it, {
              showListName: opts.showListName,
              enableSubtasks: opts.enableSubtasks,
              includeDone: opts.includeDone,
              prevSiblingId: idx > 0 ? secItems[idx - 1].id : null,
            })),
            draftMatch && editorState?.mode === 'new' ? renderInlineEditor(editorState) : null),
          opts.emptySlot && secItems.length === 0 && !(draftMatch && editorState?.mode === 'new') && onAddClick
            ? h('div', {
              className: 'ar-section-slot',
              onClick: onAddClick,
            })
            : null)
      }

      const renderMainBody = () => {
        if (phase === 'loading') {
          return slow ? h('div', { className: 'ar-empty-state' }, t('loading')) : null
        }
        if (phase === 'failed') {
          return h('div', { className: 'ar-empty-state' },
            h('div', null, t('load.failed')),
            loadError !== '' ? h('div', { style: { fontSize: '12px' } }, loadError) : null,
            h('button', {
              type: 'button',
              className: 'ar-pop-chip',
              onClick: () => { setPhase('loading'); setSlow(false); setLoadError(''); void load() },
            }, t('load.retry')))
        }

        // 1. Live Search View
        const q = search.trim().toLowerCase()
        if (q !== '') {
          const matched = items.filter((it) => {
            const hay = [
              it.text ?? '',
              it.notes ?? '',
              it.location ?? '',
              it.url ?? '',
              itemList(it),
              it.section ?? '',
              ...(Array.isArray(it.tags) ? it.tags.map((tg) => `#${tg}`) : []),
            ].join(' ').toLowerCase()
            return hay.includes(q)
          })
          if (matched.length === 0) {
            return h('div', { className: 'ar-empty-state' }, t('search.empty'))
          }
          return allListNames
            .map((ln) => ({ ln, arr: sortTasks(matched.filter((it) => itemList(it) === ln)) }))
            .filter((g) => g.arr.length > 0)
            .map((g) => renderSectionList(`search:${g.ln}`, g.ln, g.arr, false, null, { dotColor: colourOf(g.ln) }))
        }

        // 2. Recently Deleted (`trash`) View
        if (view === 'trash') {
          if (trash.length === 0) {
            return h('div', { className: 'ar-empty-state' }, t('trash.emptyDesc'))
          }
          const sortedTrash = [...trash].sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))
          return h('ul', { className: 'ar-task-list' },
            sortedTrash.map((item) => h('li', { key: item.id, className: 'ar-row' },
              h('div', { className: 'ar-row-main' },
                h('div', { className: 'ar-row-body', style: { cursor: 'default' } },
                  h('div', { className: 'ar-row-title-line' }, item.text),
                  h('div', { className: 'ar-meta-line' },
                    h('span', { style: { color: colourOf(itemList(item)) } }, itemList(item)),
                    item.notes ? h('span', null, item.notes) : null)),
                h('div', { className: 'ar-row-actions', style: { opacity: 1 } },
                  h('button', {
                    type: 'button',
                    className: 'ar-action-link',
                    onClick: () => { void run({ op: 'restore', id: item.id }) },
                  }, t('trash.recover')),
                  h('button', {
                    type: 'button',
                    className: 'ar-action-link ar-action-link--danger',
                    onClick: () => { void run({ op: 'destroy', id: item.id }) },
                  }, t('trash.deletePermanently')))))))
        }

        // 3. Completed View
        if (view === 'completed') {
          if (doneItems.length === 0) {
            return h('div', { className: 'ar-empty-state' }, t('empty.completed'))
          }
          const sortedDone = [...doneItems].sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0))
          return h('ul', { className: 'ar-task-list' },
            sortedDone.map((it) => renderTaskRow(it, { showListName: true })))
        }

        const includeDone = showCompletedMap[view] === true
        const pool = includeDone ? items : openItems

        // 4. Today View (Exact Screenshot Match: Overdue optional + Morning / Afternoon / Tonight ALWAYS shown)
        if (view === 'today') {
          const overdueRaw = sortTasks(openItems.filter((it) => typeof it.due === 'string' && it.due !== '' && it.due < today))
          const overdueIds = new Set(overdueRaw.map((it) => it.id))
          const overdueArr = overdueRaw.filter((it) => !it.parentId || !overdueIds.has(it.parentId))

          const todayRaw = sortTasks(pool.filter((it) => it.due === today))
          const todayIds = new Set(todayRaw.map((it) => it.id))
          const todayPool = todayRaw.filter((it) => !it.parentId || !todayIds.has(it.parentId))

          const morningArr = todayPool.filter((it) => !it.dueTime || it.dueTime < '12:00')
          const afternoonArr = todayPool.filter((it) => typeof it.dueTime === 'string' && it.dueTime >= '12:00' && it.dueTime < '18:00')
          const tonightArr = todayPool.filter((it) => typeof it.dueTime === 'string' && it.dueTime >= '18:00')

          const draftBucket = editorState?.mode === 'new'
            ? (editorState.dueTime >= '18:00' ? 'tonight' : (editorState.dueTime >= '12:00' ? 'afternoon' : 'morning'))
            : ''

          return h('div', null,
            overdueArr.length > 0
              ? renderSectionList('today:overdue', t('section.overdue'), overdueArr, false, null, { overdue: true, showListName: true, enableSubtasks: true, includeDone })
              : null,
            renderSectionList(
              'today:morning',
              t('section.morning'),
              morningArr,
              draftBucket === 'morning',
              () => handleSectionAddClick('morning', { due: today, dueTime: '09:00' }),
              { showListName: allListNames.length > 1, enableSubtasks: true, includeDone, clickHeaderToAdd: true, emptySlot: true }
            ),
            renderSectionList(
              'today:afternoon',
              t('section.afternoon'),
              afternoonArr,
              draftBucket === 'afternoon',
              () => handleSectionAddClick('afternoon', { due: today, dueTime: '15:00' }),
              { showListName: allListNames.length > 1, enableSubtasks: true, includeDone, clickHeaderToAdd: true, emptySlot: true }
            ),
            renderSectionList(
              'today:tonight',
              t('section.tonight'),
              tonightArr,
              draftBucket === 'tonight',
              () => handleSectionAddClick('tonight', { due: today, dueTime: '20:00' }),
              { showListName: allListNames.length > 1, enableSubtasks: true, includeDone, clickHeaderToAdd: true, emptySlot: true }
            ),
            h('div', {
              className: 'ar-click-space',
              onClick: () => handleClickSpaceAdd({ due: today, dueTime: '09:00' }),
            }))
        }

        // 5. Scheduled (`planned`) View
        if (view === 'planned') {
          const dated = sortTasks(pool.filter((it) => typeof it.due === 'string' && it.due !== ''))
          const overdueArr = dated.filter((it) => !it.done && it.due < today)
          const todayArr = dated.filter((it) => it.due === today)
          const tomorrowArr = dated.filter((it) => it.due === tomorrow)
          const weekArr = dated.filter((it) => it.due > tomorrow && it.due <= weekEnd)
          const laterArr = dated.filter((it) => it.due > weekEnd)
          const draftDue = editorState?.mode === 'new' ? editorState.due : ''

          return h('div', null,
            overdueArr.length > 0 ? renderSectionList('plan:overdue', t('section.overdue'), overdueArr, false, null, { overdue: true, showListName: true }) : null,
            renderSectionList('plan:today', t('view.today'), todayArr, draftDue === today, () => handleSectionAddClick('plan:today', { due: today }), { showListName: true, clickHeaderToAdd: true }),
            renderSectionList('plan:tomorrow', t('section.tomorrow'), tomorrowArr, draftDue === tomorrow, () => handleSectionAddClick('plan:tomorrow', { due: tomorrow }), { showListName: true, clickHeaderToAdd: true }),
            renderSectionList('plan:week', t('section.thisWeek'), weekArr, draftDue > tomorrow && draftDue <= weekEnd, () => handleSectionAddClick('plan:week', { due: upcomingWeekend(today) }), { showListName: true, clickHeaderToAdd: true }),
            renderSectionList('plan:later', t('section.later'), laterArr, draftDue > weekEnd, () => handleSectionAddClick('plan:later', { due: addDays(weekEnd, 1) }), { showListName: true, clickHeaderToAdd: true }))
        }

        // 6. All View (Grouped by List)
        if (view === 'all') {
          if (pool.length === 0 && editorState?.mode !== 'new') {
            return h('div', {
              className: 'ar-empty-state',
              onClick: () => handleClickSpaceAdd({}),
            }, t('empty'))
          }
          return h('div', null,
            allListNames.map((ln) => {
              const topLevel = sortTasks(pool.filter((it) => itemList(it) === ln && !it.parentId))
              const draftHere = editorState?.mode === 'new' && (editorState.list || defaultList) === ln
              return renderSectionList(
                `all:${ln}`,
                ln,
                topLevel,
                draftHere,
                () => handleSectionAddClick(`all:${ln}`, { list: ln }),
                { dotColor: colourOf(ln), enableSubtasks: true, includeDone }
              )
            }))
        }

        // 7. Single List View (`list:<name>`) with Sections & Subtasks
        if (view.startsWith('list:')) {
          const ln = view.slice(5)
          const listPool = sortTasks(pool.filter((it) => itemList(it) === ln && !it.parentId))
          const secs = sectionsOf(ln)
          const unsectioned = listPool.filter((it) => !it.section)

          return h('div', null,
            popover?.kind === 'newSection' && popover.listName === ln
              ? h('div', { className: 'ar-popover', style: { marginBottom: '10px' } },
                h('div', { className: 'ar-pop-row' },
                  h('input', {
                    type: 'text',
                    className: 'ar-pop-input',
                    value: popover.nameDraft ?? '',
                    placeholder: t('sidebar.sectionName'),
                    onChange: (e) => setPopover({ ...popover, nameDraft: e.target.value }),
                    onKeyDown: (e) => {
                      if (e.key === 'Enter' && !e.nativeEvent?.isComposing) {
                        const sn = (popover.nameDraft ?? '').trim()
                        if (sn !== '') {
                          setPopover(null)
                          void run({ op: 'update_list', name: ln, addSection: sn })
                        }
                      }
                    },
                  }),
                  h('button', {
                    type: 'button',
                    className: 'ar-action-link',
                    onClick: () => {
                      const sn = (popover.nameDraft ?? '').trim()
                      if (sn !== '') {
                        setPopover(null)
                        void run({ op: 'update_list', name: ln, addSection: sn })
                      }
                    },
                  }, t('sidebar.save'))))
              : null,

            unsectioned.length === 0 && secs.length === 0 && editorState?.mode !== 'new'
              ? h('div', { className: 'ar-empty-state', onClick: () => handleClickSpaceAdd({ list: ln }) }, t('empty'))
              : h('ul', { className: 'ar-task-list' },
                unsectioned.map((it, idx) => renderTaskRow(it, {
                  enableSubtasks: true,
                  includeDone,
                  prevSiblingId: idx > 0 ? unsectioned[idx - 1].id : null,
                })),
                editorState?.mode === 'new' && !editorState.section ? renderInlineEditor(editorState) : null),

            secs.map((sec) => {
              const secItems = listPool.filter((it) => it.section === sec)
              const draftInSec = editorState?.mode === 'new' && editorState.section === sec
              return renderSectionList(
                `sec:${ln}:${sec}`,
                sec,
                secItems,
                draftInSec,
                () => handleSectionAddClick(`sec:${ln}:${sec}`, { list: ln, section: sec }),
                { enableSubtasks: true, includeDone }
              )
            }),

            h('div', {
              className: 'ar-click-space',
              onClick: () => handleClickSpaceAdd({ list: ln }),
            }))
        }

        // 8. Flagged, Urgent, Tags Views
        const filtered = view === 'flagged'
          ? sortTasks(pool.filter((it) => it.flagged === true))
          : view === 'urgent'
            ? sortTasks(pool.filter((it) => it.urgent === true || normalizePriorityBucket(it.priority) === 1))
            : view === 'tags'
              ? sortTasks(pool.filter((it) => Array.isArray(it.tags) && it.tags.length > 0))
              : view.startsWith('tag:')
                ? sortTasks(pool.filter((it) => Array.isArray(it.tags) && it.tags.includes(view.slice(4))))
                : sortTasks(pool)

        if (filtered.length === 0 && editorState?.mode !== 'new') {
          return h('div', {
            className: 'ar-empty-state',
            onClick: () => handleClickSpaceAdd({}),
          }, t('empty'))
        }

        return h('div', null,
          h('ul', { className: 'ar-task-list' },
            filtered.map((it, idx) => renderTaskRow(it, {
              showListName: true,
              prevSiblingId: idx > 0 ? filtered[idx - 1].id : null,
            })),
            editorState?.mode === 'new' ? renderInlineEditor(editorState) : null),
          h('div', {
            className: 'ar-click-space',
            onClick: () => handleClickSpaceAdd({}),
          }))
      }

      // =====================================================================
      // Top Bar, Header Contextual Controls & Error Banner
      // =====================================================================

      const { title: headerTitle, color: headerColor } = resolveTitleAndColor()
      const syncEnabled = sync !== null && sync.enabled === true
      const syncFailed = syncEnabled && sync.status === 'error'
      const statusBanner = opError !== ''
        ? { text: t('op.failed'), detail: opError }
        : syncFailed
          ? { text: t('sync.error', { reason: sync.error ?? '' }), detail: sync.error ?? '' }
          : null

      const canAddTask = view !== 'trash' && view !== 'completed'

      return h('div', { ref: rootRef, className: 'ar-root' },
        h('style', null, CSS),

        // Responsive drawer scrim (visible only in narrow <500px containers when sidebarOpen)
        h('div', {
          className: sidebarOpen ? 'ar-scrim ar-scrim--open' : 'ar-scrim',
          onClick: () => setSidebarOpen(false),
        }),

        renderSidebar(),

        h('main', { className: 'ar-main' },
          // Right Pane Top Toolbar
          h('div', { className: 'ar-main-top' },
            h('div', { className: 'ar-main-top-left' },
              !sidebarOpen ? h('button', {
                type: 'button',
                className: 'ar-circle-btn',
                'aria-label': t('sidebar.toggle'),
                title: t('sidebar.toggle'),
                onClick: () => setSidebarOpen(true),
              }, h(SidebarToggleIcon)) : null,
              syncEnabled ? h('button', {
                type: 'button',
                className: sync.status === 'error'
                  ? 'ar-sync-btn ar-sync-btn--error'
                  : sync.status === 'syncing'
                    ? 'ar-sync-btn ar-sync-btn--syncing'
                    : 'ar-sync-btn',
                disabled: sync.status === 'syncing',
                'aria-label': t('sync.aria'),
                title: t('sync.aria'),
                onClick: () => { void run({ op: 'sync' }) },
              },
              h(SyncIcon, { size: 13 }),
              h('span', { className: 'ar-sync-label' }, sync.status === 'syncing' ? t('sync.syncing') : sync.status === 'error' ? t('sync.retry') : t('sync.now'))) : null),

            h('div', { className: 'ar-main-top-right' },
              canAddTask ? h('button', {
                type: 'button',
                className: 'ar-circle-btn',
                'aria-label': t('input.label'),
                title: t('input.label'),
                onClick: () => openNewDraft({}),
              }, h(PlusIcon)) : null,

              h('div', { className: 'ar-search-box' },
                h(SearchIcon),
                h('input', {
                  type: 'search',
                  className: 'ar-search-input',
                  value: search,
                  placeholder: t('search.placeholder'),
                  'aria-label': t('search.placeholder'),
                  onChange: (e) => setSearch(e.target.value),
                }),
                search !== '' ? h('button', {
                  type: 'button',
                  className: 'ar-search-clear',
                  'aria-label': t('search.clear'),
                  onClick: () => setSearch(''),
                }, '×') : null))),

          // Large Colored View Title + Contextual Actions
          h('div', { className: 'ar-header-bar' },
            h('h1', { className: 'ar-view-title', style: { color: headerColor } }, headerTitle),
            search.trim() === '' ? h('div', { className: 'ar-header-actions' },
              view.startsWith('list:') ? h('button', {
                type: 'button',
                className: 'ar-action-link',
                onClick: () => setPopover({ kind: 'newSection', listName: view.slice(5), nameDraft: '' }),
              }, `+ ${t('sidebar.addSection')}`) : null,
              view !== 'completed' && view !== 'trash' && doneItems.length > 0 ? h('button', {
                type: 'button',
                className: 'ar-action-link',
                onClick: () => toggleShowCompleted(view),
              }, showCompletedMap[view] === true ? t('completed.hide') : t('completed.show')) : null) : null),

          // Sub-bar for Completed View
          search.trim() === '' && view === 'completed' && doneItems.length > 0
            ? h('div', { className: 'ar-subbar' },
              h('span', null, t('completed', { count: doneItems.length })),
              h('button', {
                type: 'button',
                className: armed === 'clear_done' ? 'ar-action-link ar-action-link--danger' : 'ar-action-link',
                'aria-label': armed === 'clear_done' ? t('clear.ariaArmed') : t('clear.aria'),
                onClick: () => {
                  if (armed !== 'clear_done') {
                    setArmed('clear_done')
                    return
                  }
                  setArmed('')
                  void run({ op: 'clear_done' })
                },
              }, armed === 'clear_done' ? t('clear.confirm') : t('clear')))
            : null,

          // Sub-bar for Recently Deleted View
          search.trim() === '' && view === 'trash' && trash.length > 0
            ? h('div', { className: 'ar-subbar' },
              h('span', null, t('trash.count', { count: trash.length })),
              h('div', { style: { display: 'flex', gap: '8px' } },
                h('button', {
                  type: 'button',
                  className: 'ar-action-link',
                  onClick: () => { void run({ op: 'restore', all: true }) },
                }, t('trash.recoverAll')),
                h('button', {
                  type: 'button',
                  className: 'ar-action-link ar-action-link--danger',
                  onClick: () => {
                    if (armed !== 'empty_trash') {
                      setArmed('empty_trash')
                      return
                    }
                    setArmed('')
                    void run({ op: 'empty_trash' })
                  },
                }, armed === 'empty_trash' ? t('trash.emptyConfirm') : t('trash.empty'))))
            : null,

          phase === 'ready' && statusBanner !== null
            ? h('div', { className: 'ar-status-banner', role: 'status', title: statusBanner.detail }, statusBanner.text)
            : null,

          h('div', { className: 'ar-content' },
            h('div', {
              key: search ? '__search__' : view,
              className: 'ar-view-stage',
            }, renderMainBody()))))
    }

    // =========================================================================
    // DSH Plugin Registration (Locale, Sidebar Tab Type, Slot, Keyboard Shortcut)
    // =========================================================================

    return {
      inject: ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-apple-reminders: dictionaries')
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
        }), 'dsh-apple-reminders: tab type')

        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: ID,
          locale: NS,
        }, TodoPanel))

        ctx.inject(['shortcuts'], (shortcutsCtx) => {
          shortcutsCtx.effect(() => shortcutsCtx.shortcuts.register({
            id: COMMAND,
            label: () => t('guide.title'),
            aliases: ['todo', 'todos', 'to-do', 'reminders', '待办', '提醒事项'],
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
          }), 'dsh-apple-reminders: shortcut')
        })

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
            // Best effort on dispose.
          }
        }, 'dsh-apple-reminders: open tabs')
      },
    }
  },
})
