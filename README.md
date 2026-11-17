# dsh-apple-reminders — 右侧边栏的待办清单，与苹果「提醒事项」双向同步

一份待办清单，三个入口，两边都能改：

- **侧边栏**：右侧边栏「开始」页里的「待办」卡片，或 `⌘/Ctrl + Alt + T`。
- **AI 模型**：工具 `personal_todos`，能读、能加、能勾、能删。
- **手机/iPad**：苹果「提醒事项」里名为「DSH 待办」的列表。

清单存在本机 `~/.dsh/dsh-apple-reminders/todos.json`，是持久副本；「提醒事项」和它双向同步，任何一边改都会到另一边。镜像里放的是**未完成任务 + 30 天内完成的任务**——所以「添加后马上勾掉」也能在提醒事项里看到（显示为已完成）。

## 安装

要求：macOS（提醒事项同步只在 macOS 上可用；其他平台插件仍能当本地待办用）、DeepSeek Harness `0.2.2-rc.3` 及以上、桌面版 Web GUI。

**方式一：插件管理器（推荐）**

1. DSH → 设置 → 插件 → 添加插件
2. 选这个仓库的本地目录，或填入 `github:foranewlife/dsh-apple-reminders`
3. 启用后**重启一次应用**（Host 侧代码不会热更新），再刷新页面

**方式二：命令行**

```sh
dsh plugin --profile <profile> add github:foranewlife/dsh-apple-reminders
```

然后把 `dsh-todo` 加进该 profile `package.json` 里 `dsh.profile.bundles` 数组，重启应用。

**方式三：本地开发**

```sh
git clone https://github.com/foranewlife/dsh-apple-reminders.git
dsh plugin --profile <profile> add link:$PWD/dsh-todo
```

首次同步会在提醒事项里创建 `DSH 待办` 列表，并在系统里弹一次「DeepSeek Harness 想要控制提醒事项」的授权。

## 每条任务能带什么

| 面板 | 提醒事项字段 | 说明 |
|---|---|---|
| 截止日期（行尾 ⋯ 里的日期） | `due date` | 显示为 `MM-DD`，过期标红 |
| 旗标（行内 ⚑） | `flagged` | 点一下切换 |
| 优先级（无/低/中/高） | `priority` 0/1/5/9 | 行尾显示档位 |
| 备注（⋯ 里的文本框） | `body` | 行尾显示「备注」 |
| 所属列表 | 列表本身（`move`） | 输入框下方选「新任务加到」；每行 `⋯` 里也能改 |

这些字段全部参与双向合并：在手机上改日期/备注/旗标/优先级，会拉回面板；在面板里改，会推过去。

## 架构

```
        ┌──────────────┐   读/写    ┌───────────────────────────┐
        │ 侧边栏面板   │ ─────────▶ │ Host（index.js）           │
        │ client.js    │ ◀───────── │  todos.json（原子写、串行） │
        └──────────────┘   SSE 推送 └───────────┬───────────────┘
                                                │ 工具 personal_todos
        ┌──────────────┐   读/写               │
        │ AI 模型      │ ──────────────────────┘
        └──────────────┘
                                    双向合并（osascript / JXA）
                                                │
                                                ▼
                                       苹果「提醒事项」· DSH 待办
```

- 面板到 Host：`POST /api/dsh-todo/op`（同源 fetch，带 cookie），实时推送走 `GET /api/dsh-todo/events`（SSE）。两条都是 `ctx.connection.fetch.register` 注册的精确路由，鉴权由 DSH 连接层负责。
- Host 到模型：`ctx.tools.register` 注册的原生 JSON Schema 工具。

## 同步是怎么算的

每条任务记录一份**基准**（`synced`：上次告诉提醒事项的文字和完成状态）。每轮合并比较三方——基准、DSH 当前、提醒事项当前：

| 情况 | 结果 |
|---|---|
| 只有一边改了文字 / 完成状态 | 以改的那边为准，同步到另一边 |
| 两边都改了同一项且结果不同 | **以 DSH 为准** |
| 提醒事项里删掉一条 | DSH 里对应任务也删掉 |
| 提醒事项里新增一条 | 导入成新的 DSH 任务 |
| 提醒事项里勾 / 取消勾 | DSH 里跟着改 |
| DSH 里删掉一条 | 提醒事项里也删掉 |
| 整张「DSH 待办」列表被删 | **不删任务**，重建列表并补回内容 |
| 「DSH 待办」还不存在 | 合并时先建出空列表，sync 因此总是看得见 |

界面照着苹果「提醒事项」的样子做：每个列表用它在提醒事项里的颜色显示一个圆点，列表行带分隔线、右侧显示未完成数量，日期/优先级/备注用胶囊标签。

面板里的排列：多个列表时，**未完成的任务按列表分组**，每组一个可折叠的表头（箭头 + 列表名 + 未完成数量，折叠状态记在浏览器本地，刷新后保持）；组内按**截止日期排序**，没有日期的排在最后，同日期按文字排；组本身按你勾选列表的顺序排。**已完成的任务默认不显示**，点工具栏上的「已完成 N ▸」才展开，展开后「清除已完成」也在那一行里。

任务换列表也能同步：在面板里把任务改到另一列表，会用提醒事项的 `move` 把那条提醒搬过去（id 不变）；反过来在手机上把提醒拖到别的列表，会回流成 DSH 里列表的变化。取消勾选某个列表只影响「之后是否从它导入」，已经同步进来的任务仍继续同步（要清掉就在面板里删）。

安全阀：

- 刚推送 60 秒内的提醒事项条目不会被判为「被删了」（`raceWindowMs` 可调），避免提醒事项索引延迟导致误删。
- 完成满 30 天的任务会从提醒事项里剪掉（DSH 里历史仍在），让镜像列表的体积和读取耗时保持有界。

同步时机：

- **本地改动后 0.6 秒只推送**——不读提醒事项，所以勾一个任务就一次 Apple 事件（约 0.3–1 秒），不会卡。
- **合并分两级**：

- 每 60 秒一次「快合并」，只读名字和完成状态（够用且便宜），覆盖新增/改名/完成/删除；
- 每 5 次快合并（约 5 分钟）一次「详合并」，额外读日期、备注、旗标、优先级——因为提醒事项每读一个属性都是一次 Apple 事件；
- 打开面板、切回窗口、点「立即同步」都是详合并。
- 合并失败时面板底部才出现一行红字和「重试」，平时不占高度。

## 数据与配置

- 清单：`~/.dsh/dsh-apple-reminders/todos.json`（遵循 `DSH_HOME`）。原子替换写入、权限 600；文件损坏会改名留档而不是覆盖。
- 默认只同步一个列表 `DSH 待办`。面板里点输入框下方那个 `+` 就能勾选要同步的提醒事项列表——选择存在数据文件的 `settings.lists` 里，立即生效、不用改配置也不用重启。也可以在 profile 的 `cordis.patch.yml` 里给初始值：

```yaml
- id: dsh-todo
  name: dsh-todo
  config:
    lists: [我的待办, 愿望]   # 初始要同步的列表（第一次运行时写进数据文件）
    # listName: 我的待办      # 只同步一个列表时的简写
    syncIntervalMs: 60000    # 面板开着时的完整合并间隔
    raceWindowMs: 60000      # 刚推送的条目多久内不判为已删除
    reminders: false         # 关掉双向同步，只在本机存
```

- 非 macOS 上同步自动关闭，其余功能照常。
- 首次同步会创建「DSH 待办」列表，并在系统里弹一次「DeepSeek Harness 想要控制提醒事项」（本机已授权过）。

## 修改后怎么生效

- `client.js`（浏览器侧）：刷新页面即可。
- `index.js` / `lib/*`（Host 侧）：需要**重启应用**——这个 profile 的 HMR 只监听 `root: []`，不热加载 Host 模块。

## 测试

```sh
node test/host-check.mjs                    # 两套计划、存储、工具、路由
DSH_TODO_LIVE=1 node test/host-check.mjs    # 再加一轮真实提醒事项双向往返
```

离线覆盖：推送计划（新建 / 改名 / 勾选 / 剪枝）、合并计划（本侧改、对侧改、双侧冲突、对侧删除、对侧新增、整表被删后重建、索引竞态、旧文档无基准时的首次接触）、原子写入与重载、工具 schema（用 DSH 自己的校验器）、面板 op 路由、SSE 首帧。

真实往返覆盖：任务改列表时提醒事项里跟着搬（双向）；DSH 新建 → 镜像出现；日期/备注/优先级/旗标双向往返；DSH 勾选 / 取消勾选 → 镜像跟着变；手机勾选 / 取消勾 / 改名 / 新增 / 删除 → DSH 跟着变；任务落在指定列表、手机在第二个列表新增也能带列表和备注导入；DSH 删除 → 镜像消失。

## 文件

- `index.js` — Host 半：存储所有权、模型工具、两条 `/api` 路由、同步调度与执行
- `lib/store.js` — 清单文档（含基准与墓碑）、原子写、串行提交
- `lib/reminders.js` — `osascript`/JXA 桥（读镜像、建/改/删）
- `lib/sync.js` — 纯函数：`planPush`（无读取）与 `planMerge`（三方合并）
- `client.js` — 侧边栏标签页、SSE 订阅、旧版 localStorage 数据一次性迁移
- `test/host-check.mjs` — 上述测试

## English

A to-do list plugin for the DeepSeek Harness web client, two-way synced with **Apple Reminders** (macOS). It lives in the right sidebar, is shared by every conversation, is readable and writable by the model through the `personal_todos` tool, and is kept in **two-way sync with Apple Reminders** on macOS.

- Open it from the right sidebar guide page or press `Cmd/Ctrl + Alt + T`.
- Each task can carry a due date, a flag, a priority and notes, all shared with the matching Reminders fields.
- Several Reminders lists can be synced at once; tasks group by list behind foldable headers and sort by due date.
- Edits on either side reach the other; a field edited differently on both sides resolves in DSH favour. Deleting a whole Reminders list rebuilds it instead of deleting tasks.

Install: DSH → Settings → Plugins → Add plugin (`github:foranewlife/dsh-apple-reminders`), then restart the app once. Reminders sync is macOS-only; everything else works everywhere.

MIT licensed.

> Not affiliated with Apple Inc. *Reminders* and *Apple* are trademarks of Apple Inc., used here only to describe what the plugin integrates with.
