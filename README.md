# dsh-apple-reminders — 苹果「提醒事项」风格待办清单与双向同步

一份待办清单，三个入口，两边都能改：

- **侧边栏**：右侧边栏「开始」页里的「待办」卡片，或 `⌘/Ctrl + Alt + T`。
- **AI 模型**：工具 `personal_todos`，支持任务、子任务、列表/分区、软删除恢复与同步。
- **手机/iPad**：苹果「提醒事项」里勾选同步的列表（默认 `DSH 待办`）。

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

然后把 `dsh-apple-reminders` 加进该 profile `package.json` 里 `dsh.profile.bundles` 数组，重启应用。

**方式三：本地开发**

```sh
git clone https://github.com/foranewlife/dsh-apple-reminders.git
dsh plugin --profile <profile> add link:$PWD/dsh-todo
```

### 从旧名字升级（原来叫 `dsh-todo`）

包名换成了 `dsh-apple-reminders`，profile 里旧的链接名对不上新包名，**直接重启会让插件加载不出来**。正确做法：

1. 设置 → 插件 → 移除 `dsh-todo`
2. 添加插件 → 选本地目录（或填新名字的 `github:` 地址）
3. 重启应用

清单不会丢：第一次加载会把旧的 `~/.dsh/dsh-todo/todos.json` 自动导入到 `~/.dsh/dsh-apple-reminders/todos.json`。

首次同步会在提醒事项里创建 `DSH 待办` 列表，并在系统里弹一次「DeepSeek Harness 想要控制提醒事项」的授权。

## 界面与功能（Apple Reminders 完整对齐）

### 可折叠双栏布局

- **左侧边栏（可折叠）**：
  - **实时搜索**：按标题、备注、标签、位置等即时过滤任务。
  - **6 张智能列表卡片**：
    - **今天**（自动按「逾期 / 上午 / 下午 / 今晚」时间段分组）
    - **计划**（按日期汇总即将到期的任务）
    - **全部**（按列表与自定义分区展示所有未完成任务）
    - **旗标**（所有带旗标的任务）
    - **紧急**（所有标记为紧急 `((⏰))` 的任务）
    - **已完成**（查看已完成的任务历史，支持一键清理已完成）
  - **置顶列表** & **建议「购物清单」**（Groceries）快捷入口。
  - **最近删除（Recently Deleted）**：删除的任务与子任务会先进入回收站保留 30 天，支持单条/全部恢复或永久彻底删除。
  - **`#标签` 筛选**：按标签快速过滤任务。
  - **我的列表**：自定义列表颜色、图标、置顶状态与列表内分区（Sections），支持新建、重命名与删除。

### 行内编辑与快捷胶囊栏

点击任务即可展开行内编辑与快捷操作胶囊栏，以及 `ⓘ` 检查器弹窗：

- **日期与时间**：支持纯日期（`YYYY-MM-DD`）或精确到分钟的 24 小时时间（`HH:MM`）。
- **紧急提醒 `((⏰))`**：标记高紧迫度任务并在「紧急」智能列表中汇总。
- **重复（Repeat）**：支持 `daily`（每天）、`weekdays`（工作日）、`weekly`（每周）、`biweekly`（每两周）、`monthly`（每月）、`yearly`（每年）；勾选完成重复任务时，会自动保留已完成记录并生成下一次到期任务。
- **位置（Location）**：记录地点触发标签（如 `Arriving Home`）。
- **标签（Tags）**：支持 `#tag` 形式或标签列表编辑，手机端导入的 `#标签` 也会自动提取。
- **旗标（Flag）** & **优先级（Priority）**：无（`0`）、高（`1`）、中（`5`）、低（`9`）。
- **子任务（Subtasks）**：通过 `parentId` 挂在父任务下，默认继承父任务的列表与分区。
- **URL**：关联链接并在行内/检查器中打开。
- **列表与分区（List & Section）**：支持把任务移动到其他列表或列表内的指定分区，支持手动拖拽/排序（`order`）。

## 每条任务能带什么（与提醒事项互通）

| 能力 | 提醒事项同步字段 | 说明 |
|---|---|---|
| 标题与完成状态 | `name` / `completed` | 双向同步 |
| 截止日期 / 时间 | `alldayDueDate` / `dueDate` + `remindMeDate` | 纯日期走全天字段，带 `HH:MM` 走定时与提醒时间 |
| 旗标 | `flagged` | 双向同步 |
| 优先级（无/高/中/低） | `priority`（0 / 1 / 5 / 9） | 双向同步（读取时 `1–4`→高、`5`→中、`6–9`→低） |
| 备注 | `body` | 双向同步（保持备注干净，不混入额外元数据） |
| 所属列表 | 列表本身（`move` / `color` / `emblem`） | 支持多列表同步、列表颜色/图标读取与跨列表移动 |
| `#标签`、URL、重复、位置、紧急、分区、子任务 | 仅存本地 `todos.json` | 提醒事项 JXA 接口未暴露的富字段；从手机导入时会自动提取文本里的 `#tag` |

## AI 工具：`personal_todos`

模型通过 `personal_todos` 工具读写同一份清单，支持的操作（`op`）：

- **任务操作**：`list`（默认）、`add`、`toggle`、`update`、`remove`（默认软删除到「最近删除」，传 `permanent: true` 可跳过回收站）、`clear_done`
- **回收站操作**：`restore`（单条 `id` 或 `all: true` 恢复）、`destroy`（永久删除单条）、`empty_trash`（清空回收站）；默认 `list` 不返回 `trash` 以保持输出精简，传 `includeTrash: true` 可包含回收站条目
- **列表与同步**：`create_list`、`update_list`（重命名/颜色/图标/置顶/分区）、`delete_list`、`sync`

`add` / `update` 支持的任务字段：`text`、`list`、`due`（`YYYY-MM-DD`）、`dueTime`（`HH:MM`）、`notes`、`urgent`、`flagged`、`priority`（`0|1|5|9`）、`tags`、`url`、`repeat`（`daily|weekdays|weekly|biweekly|monthly|yearly`）、`location`、`parentId`、`section`、`order`、`done`。

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

- 面板到 Host：`POST /api/dsh-apple-reminders/op`（同源 fetch，带 cookie），实时推送走 `GET /api/dsh-apple-reminders/events`（SSE）。两条都是 `ctx.connection.fetch.register` 注册的精确路由，鉴权由 DSH 连接层负责。
- Host 到模型：`ctx.tools.register` 注册的原生 JSON Schema 工具。

## 同步是怎么算的

每条任务记录一份**基准**（`synced`：上次告诉提醒事项的文字、完成状态、备注、日期/时间、旗标、优先级）。每轮合并比较三方——基准、DSH 当前、提醒事项当前：

| 情况 | 结果 |
|---|---|
| 只有一边改了受支持字段 | 以改的那边为准，同步到另一边 |
| 两边都改了同一项且结果不同 | **以 DSH 为准** |
| 提醒事项里删掉一条 | DSH 里对应任务也移除 |
| 提醒事项里新增一条 | 导入成新的 DSH 任务（自动提取 `#tag`） |
| 提醒事项里勾 / 取消勾 | DSH 里跟着改 |
| DSH 里删掉一条（进入最近删除） | 提醒事项里也删掉；从回收站恢复后会重新推回提醒事项 |
| 整张「DSH 待办」列表被删 | **不删任务**，重建列表并补回内容 |
| 「DSH 待办」还不存在 | 合并时先建出空列表，sync 因此总是看得见 |

任务换列表也能同步：在面板里把任务改到另一列表，会用提醒事项的 `move` 把那条提醒搬过去（id 不变）；反过来在手机上把提醒拖到别的列表，会回流成 DSH 里列表的变化。取消勾选某个列表只影响「之后是否从它导入」，已经同步进来的任务仍继续同步。

安全阀：

- 刚推送 60 秒内的提醒事项条目不会被判为「被删了」（`raceWindowMs` 可调），避免提醒事项索引延迟导致误删。
- 完成满 30 天的任务会从提醒事项里剪掉（DSH 里历史仍在），「最近删除」超过 30 天会自动清理，让列表体积和读取耗时保持有界。

同步时机：

- **本地改动后 0.6 秒只推送**——不读提醒事项，所以勾一个任务就一次 Apple 事件（约 0.3–1 秒），不会卡。
- **合并分两级**：
  - 每 60 秒一次「快合并」，只读名字和完成状态（够用且便宜），覆盖新增/改名/完成/删除；
  - 每 5 次快合并（约 5 分钟）一次「详合并」，额外读全天/定时日期、备注、旗标、优先级——因为提醒事项每读一个属性都是一次 Apple 事件；
  - 打开面板、切回窗口、点「立即同步」都是详合并。
- 合并失败时面板底部才出现一行红字和「重试」，平时不占高度。

## 数据与配置

- 清单：`~/.dsh/dsh-apple-reminders/todos.json`（遵循 `DSH_HOME`）。原子替换写入、权限 600；文件损坏会改名留档而不是覆盖。
- 默认只同步一个列表 `DSH 待办`。面板里可以勾选要同步的提醒事项列表，或直接新建/编辑列表——选择存在数据文件里，立即生效、不用改配置也不用重启。也可以在 profile 的 `cordis.patch.yml` 里给初始值：

```yaml
- id: dsh-apple-reminders
  name: dsh-apple-reminders
  config:
    lists: [我的待办, 愿望]   # 初始要同步的列表（第一次运行时写进数据文件）
    # listName: 我的待办      # 只同步一个列表时的简写
    syncIntervalMs: 60000    # 面板开着时的完整合并间隔
    raceWindowMs: 60000      # 刚推送的条目多久内不判为已删除
    reminders: false         # 关掉双向同步，只在本机存
```

- 非 macOS 上同步自动关闭，其余功能照常。
- 首次同步会创建「DSH 待办」列表，并在系统里弹一次「DeepSeek Harness 想要控制提醒事项」。

## 修改后怎么生效

- `client.js`（浏览器侧）：刷新页面即可。
- `index.js` / `lib/*`（Host 侧）：需要**重启应用**——这个 profile 的 HMR 只监听 `root: []`，不热加载 Host 模块。

## 测试

```sh
node test/host-check.mjs                    # 两套计划、存储、工具、路由
node test/render-check.mjs                  # 面板在各种状态下都能渲染（防止白屏）
DSH_TODO_LIVE=1 node test/host-check.mjs    # 再加一轮真实提醒事项双向往返
```

离线覆盖：推送计划（新建 / 改名 / 勾选 / 剪枝）、合并计划（本侧改、对侧改、双侧冲突、对侧删除、对侧新增、整表被删后重建、索引竞态、旧文档无基准时的首次接触）、原子写入与重载、工具 schema（用 DSH 自己的校验器）、面板 op 路由、SSE 首帧。

真实往返覆盖：任务改列表时提醒事项里跟着搬（双向）；DSH 新建 → 镜像出现；全天与定时日期/备注/优先级/旗标双向往返；DSH 勾选 / 取消勾选 → 镜像跟着变；手机勾选 / 取消勾 / 改名 / 新增 / 删除 → DSH 跟着变；任务落在指定列表、手机在第二个列表新增也能带列表和备注导入；DSH 删除 → 镜像消失。

## 文件

- `index.js` — Host 半：存储所有权、模型工具、两条 `/api/dsh-apple-reminders/*` 路由、同步调度与执行
- `lib/store.js` — 清单文档（含基准、回收站与墓碑）、原子写、串行提交
- `lib/reminders.js` — `osascript`/JXA 桥（读镜像、建/改/移/删）
- `lib/sync.js` — 纯函数：`planPush`（无读取）与 `planMerge`（三方合并）
- `client.js` — Apple Reminders 风格双栏侧边栏面板、SSE 订阅、行内编辑器与检查器
- `test/host-check.mjs` — 上述 Host 与同步测试
- `test/render-check.mjs` — 前端渲染检查

## English

An Apple Reminders-style to-do list plugin for the DeepSeek Harness web client, kept in **two-way sync with Apple Reminders** (macOS). It lives in the right sidebar, is shared across every conversation, and is readable and writable by the model through the `personal_todos` tool.

- **Two-pane collapsible layout**: A collapsible sidebar with live search, **6 Smart Lists** (`Today` grouped into Overdue / Morning / Afternoon / Tonight, `Scheduled`, `All`, `Flagged`, `Urgent`, `Completed`), **Pinned Lists**, a **Suggested Groceries** list, **Recently Deleted** (30-day soft-delete & recovery), **`#Tags`** filtering, and custom **My Lists** (colors, icons, sections). Open from the right sidebar guide page or press `Cmd/Ctrl + Alt + T`.
- **Inline editor & quick-action pill bar**: Date (`YYYY-MM-DD`), Time (`HH:MM` 24h), Urgent (`((⏰))`), Repeat recurrence (`daily` / `weekdays` / `weekly` / `biweekly` / `monthly` / `yearly`, spawning the next occurrence on completion), Location, `#Tags`, Flag, Subtasks (`parentId`), URL, Priority (`0` None / `1` High / `5` Medium / `9` Low), List & Section assignment, and a `ⓘ` Inspector.
- **`personal_todos` AI tool**: Supports `list`, `add`, `toggle`, `update`, `remove`, `restore`, `destroy`, `empty_trash`, `clear_done`, `create_list`, `update_list`, `delete_list`, and `sync` across all task, subtask, list/section, and trash fields.
- **Two-way Apple Reminders sync (macOS)**: Syncs multiple lists and list moves, distinguishes all-day vs timed due dates (`alldayDueDate` vs `dueDate` + `remindMeDate`), extracts inline `#tags` on phone imports, keeps local-only rich fields out of Reminders `body`, resolves conflicts in DSH favour, rebuilds deleted Reminders lists, and prunes tasks completed over 30 days ago from Reminders while keeping DSH history.

Install: DSH → Settings → Plugins → Add plugin (`github:foranewlife/dsh-apple-reminders`), then restart the app once. Reminders sync is macOS-only; everything else works everywhere.

MIT licensed.

> Not affiliated with Apple Inc. *Reminders* and *Apple* are trademarks of Apple Inc., used here only to describe what the plugin integrates with.
