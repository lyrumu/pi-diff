# pi-diff 项目计划书（源文件对照版）

> 状态：阶段 1–4 与阶段 5 简单交互改进已完成；2026-10-19 已同步上游基线 `ba06ff9`，本次上游 diff 相关源码无变化；后续双语、快捷键、分隔线和默认范围改进及 80 项自测证据见文末。复杂功能暂缓，见 docs/deferred-features.md；真实模型连续使用和物理终端视觉仍需反馈。
> 新对话按本文档执行；已确认的设计决策见 `AGENTS.md`（勿改动）。

## 移植原则（用户已确认，勿改动）

1. **默认逐行照搬 opencode 源码**：opencode 维护得更好，凡可复制即复制（MIT 许可，`NOTICE.md` 已声明）。只有 pi 生态不兼容处才替换实现，明显更优/更适合 pi 才自写；其余一对一参考。
2. **对齐优先级：功能语义 > 界面布局与视觉 > 快捷键**。
3. 每个偏离 opencode 的实现必须在本文档「偏离登记」处记录原因；无登记即视为 bug。
4. 源码基线（只读，勿改动、勿入库）：
   - 本地路径 `reference/opencode/`（sparse clone，仅 core/src 与 tui/src + LICENSE）
   - commit `ba06ff9e0bf2dcefbbbc3a1d6094f3572d77c84e`（dev），基线 hash 另存于 `reference/opencode.pin`
   - 定期同步：`./scripts/sync-opencode.sh`（见「上游同步（定期维护）」节）
5. `reference/` 与 opencode 行为规格冲突时，以 opencode 行为规格为准。

## 全局不变量（每阶段遵守，与 AGENTS.md 一致）

1. **单一登记入口** `Tracker.recordFileChange()`：edit/write 工具、bash 扫描、轮次基线扫描三个来源同一管道，禁止旁路。
2. **单一扫描函数** `Tracker.scanWorkspace(marker)`：轮次基线扫描与 bash 前后扫描只传不同 marker，禁止第二套扫描逻辑。
3. **持久化自包含**：每轮 patch 以 `pi-diff.turn` custom entry 写入会话 JSONL；磁盘快照（`~/.pi/agent/data/pi-diff/`）仅是增量缓存。
4. Git 只 spawn 系统 `git` CLI，只读。
5. 数据只写 `~/.pi/agent/data/pi-diff/`；每阶段完成标准 = `npm run typecheck` 零错误 + 该阶段验收通过。

---

## opencode 源码行为规格（研读结论，实现的对齐基准）

来自基线 commit 的源码研读（2026-10-19 复核：本次映射源码、行为规格及清单行数均未变化）：

| 主题 | opencode 行为 |
|---|---|
| 会话 diff 上下文 | `vcs/patch.ts`：`PATCH_CONTEXT_LINES = 2_147_483_647`（**全文件 patch**）；`MAX_PATCH_BYTES = MAX_TOTAL_PATCH_BYTES = 10_000_000` |
| VCS diff 上下文 | TUI `diff-viewer.tsx`：`VCS_DIFF_CONTEXT_LINES = 12`；`Vcs.diff()` 内对总量超 `MAX_TOTAL_PATCH_BYTES` 的文件降级为 `emptyPatch`（0 上下文空 patch） |
| patch 原语 | `vcs/patch.ts`：`structuredPatch`/`addPatch`/`deletePatch`/`emptyPatch`/`countPatch`（±行数统计）/`splitGitPatch`/`chunksByFile`/`fileFromPatchChunk` |
| 轮次定义 | `session/diff.ts`：turn = 上一次 idle 后首个用户任务到下一次 idle；运行中的追加提示属于同一轮；没有 idle 的旧会话回退到相邻用户消息边界。diff 使用范围内首个 start 与最后 end snapshot，仍在运行时 live capture；跨 Location 切换的范围拒绝比较 |
| 快照服务 | `snapshot.ts`（core 根目录）：Snapshot.Service，capture() 限定当前 Location 目录，未跟踪文件捕获上限 2MiB；diff() 输出 per-file patch，存储走 Location 数据目录。pi 替代捕获及 10MB 降级见 D4/D11 |
| VCS 模式 | `vcs.ts` + `plugin/vcs/git.ts`：`working` = HEAD → 工作副本（含暂存及未跟踪文件），`committed` = merge-base → HEAD，`branch` = merge-base → 工作副本；provider 化（git/hg 插件），总量保护 |
| Git 基点选择 | 显式 base 优先，否则主 remote 的 HEAD → 配置的 `init.defaultBranch`（存在的本地分支）→ main → master；解析为 commit 后求 merge-base；无有效基点报错，不冒充空 diff |
| TUI 布局常量 | `diff-viewer.tsx`：`MIN_SPLIT_WIDTH=100`、`FILE_TREE_MIN_WIDTH=30`、`FILE_TREE_MAX_WIDTH=40`、`FILE_HEADER_HEIGHT=2`；全屏宽度 <88 列或停靠面板使用紧凑布局（无文件树、无卡片外侧留白），其余左右各留 2 列 |
| TUI 数据源 | `DIFF_SOURCES`：session diff（按 turn）+ VCS_SOURCES（branch/committed/working）；mode 切换（unified/split，`storedView` 持久化偏好） |
| 文件树 | `diff-viewer-file-tree-utils.ts`：`buildFileTree`（目录树）/`flattenFileTree`（展开集）/`toggleFileTreeDirectory`/`movePatchFileIndex` 等纯函数，可近乎直接复制 |
| diff 渲染 | `component/patch-diff.tsx`：`VIRTUAL_MIN_LINES=3000`、`VIRTUAL_CHUNK_LINES=128`（虚拟滚动）；新增 gutterPadding，紧凑布局行号前补 1 列并按行背景着色；等待行号侧挂载最多重试 5 次。pi 按整文件一次计算行号宽度，无异步挂载问题 |
| 状态管理 | `diff-viewer.tsx`：selectedFileIndex / expandedFileNodes / reviewedFileNames / selectedHunk 等 signal 集合；单文件模式审阅最后一项后 exhaustedFileIndex 阻止重复快捷键重新打开它；新增侧边面板/全屏切换与 fullscreen 偏好 |

**对既有骨架的修正项**（阶段 1 执行）：
- `src/diff-engine.ts` 的 `PATCH_CONTEXT_LINES = 3` 是旧版假设 → 改为照搬 opencode：会话 diff 全文件上下文（`2_147_483_647`）、10MB 上限；git scope 用 12 行上下文
- patch 数据形态：opencode 以 **unified patch 文本**（`Patch = string`）为核心原语，`FilePatch` 结构体只作 TUI 层视图 → 我方 `Hunk` 结构体保留为 TUI 解析产物，核心层对齐 opencode 用 patch 字符串 + `countPatch`/`splitGitPatch`

---

## 上游同步（定期维护）

opencode 在持续演进，基线会过期。**每个阶段开工前**（以及至少每两周一次）执行：

```bash
./scripts/sync-opencode.sh          # 检查 + 有更新则拉取
./scripts/sync-opencode.sh --check  # 只检查，过期时退出码 1
```

脚本行为：sparse clone 不存在则创建；否则 fetch dev tip，与当前 HEAD 比对；有更新则
checkout 新 tip、更新 `reference/opencode.pin`、列出 `packages/core/src` 与
`packages/tui/src` 下的改动文件（自动过滤 test）。

**拉取后必须做的四件事**（否则基线漂移无迹可循）：
1. 通读改动文件（`git -C reference/opencode diff <old> <new> -- <path>`），确认行为规格是否变化
2. 行为变化 → 更新本文件「opencode 源码行为规格」表与「源文件对照移植清单」（行数）
3. 已有代码依赖旧行为 → 同步改代码，或在「偏离登记」补记
4. 新 commit hash 同步到本文件第 4 条与 `AGENTS.md` 的「源码基线」行

网络访问走代理：`/bin/zsh -ic 'proxyon && ./scripts/sync-opencode.sh'`

---

## 源文件对照移植清单

标记：**[复制]** 逐行照搬（仅改 import/命名/路径）；**[替换底座]** 逻辑保留、运行时换（Effect/drizzle/solid-js → 纯 TS/pi-tui）；**[pi 替代]** opencode 有内建机制、pi 无对应物。

| opencode 源文件（行数） | 移植方式 | 目标 | 关键点 |
|---|---|---|---|
| `core/src/vcs/patch.ts` (106) | **[复制]** | `src/diff-engine.ts` | 全部导出原语逐个照搬；类型改 TS strict 兼容 |
| `core/src/snapshot.ts` (244) | **[替换底座]** | `src/snapshot.ts` | 快照捕获/diff 算法保留；Effect Service → class；存储 → `~/.pi/agent/data/pi-diff/` 内容寻址 |
| `core/src/session/diff.ts` (138) | **[pi 替代]** | `src/tracker.ts` | turn 边界：消息 $snapshot 元数据 → pi 的 before_agent_start/agent_settled 事件；SQL 查询 → custom entries 遍历 |
| `core/src/vcs.ts` (260) | **[替换底座]** | `src/git.ts` | provider 抽象（hg 支持砍掉，登记偏离：pi 只需 git）；diff/status 语义与总量保护逻辑照搬 |
| `core/src/plugin/vcs/git.ts` (752) | **[复制]**（主体） | `src/git.ts` | spawn git CLI 的参数/refspec/输出解析逐行对齐；只读不变量加严 |
| `tui/.../diff-viewer-file-tree-utils.ts` (174) | **[复制]** | `src/tui/file-tree-utils.ts` | 纯函数，直接搬 |
| `tui/.../diff-viewer.tsx` (1380) | **[替换底座]** | `src/tui/diff-screen.ts` + `scopes.ts` | solid-js signal → class 字段；布局常量、mode 切换、焦点管理、选中态行为照搬；面板及紧凑布局偏离见 D32 |
| `tui/.../diff-viewer-file-tree.tsx` (271) | **[替换底座]** | `src/tui/file-tree.ts` | 渲染换 pi-tui；折叠/选中/标记行为照搬 |
| `tui/src/component/patch-diff.tsx` (242) | **[替换底座]** | `src/tui/patch-diff.ts` | 虚拟滚动参数照搬（3000/128）；unified/split 双渲染对齐；pi 同步行号计算不需要上游挂载重试 |
| `tui/.../diff-viewer-file-menu.tsx` (87) | **[替换底座]** | v3 可选 | 文件右键菜单（reviewed 标记等），一期可缓，登记 |
| `tui/.../diff-viewer-image.tsx` (96) | **[pi 替代]** | 一期占位 | 二进制/图片显示 `binary file changed` |

## 偏离登记

| # | 偏离 | 原因 |
|---|---|---|
| D1 | 不支持 hg provider，只支持 git | pi 场景只需 git；`plugin/vcs/hg.ts` 不移植 |
| D2 | turn 边界用 pi 事件（before_agent_start/agent_settled），非消息 $snapshot 元数据 | pi 会话格式无内建 snapshot 挂点；轮次收尾见 D7 |
| D3 | 持久化用 custom entries 而非数据库 | pi 唯一的扩展持久化通道 |
| D4 | 扫描捕获时机：opencode 全量 snapshot 捕获 → 我方轮次基线 + bash 前后扫描 + 工具事件（单入口统一） | pi 无消息生命周期快照挂点；不变量见 AGENTS.md |
| D5 | TUI 渲染层 solid-js → pi-tui | 框架不同；行为对齐优先级：功能>界面>快捷键 |
| D6 | `diff-viewer-file-menu` / `diff-viewer-image` 一期不移植 | 交互锦上添花；阶段 4 后视情况补 |
| D7 | finalize 挂 `agent_settled` 而非 `turn_end`（用户已确认） | 实测 pi `turn_end` 每 LLM 迭代发一次；`agent_settled` 每 run 一次才对齐 opencode 轮次定义 |
| D8 | git 后端 marker = HEAD + porcelain + 脏文件内容哈希签名；前后路径取并集，HEAD 变化补查 commit diff | 纯状态码漏掉脏文件再次变化、恢复干净及 bash 修改后提交的文件；保留同一 scanWorkspace 入口，旧侧仍固定轮次起点 |
| D9 | 干净文件旧侧用钉定的轮次起始 HEAD（`git show <startHead>:path`），非 `:path`/实时 `HEAD:path` | AGENTS.md 原定方案会被 bash 内 `git add`/`git commit` 竞态破坏；钉定 commit 不受影响（自测覆盖） |
| D10 | 每轮均写现有格式的 entry，无改动时 fileCount=0、patches=[] | 用户于 2026-10-14 确认：空轮次必须参与历史，确保打开 /diff、重载、恢复及分支切换后的编号和 Last turn 准确；撤销此前不保存空轮次的方案 |
| D11 | session 累计视图依赖快照缓存重算；无法恢复完整两端时展示最后一轮 patch，并标明 latest turn only | 每轮 patch 自包含；跨轮首次旧侧→最新新侧需要缓存。null 表示已知不存在，可正确重算创建/删除/重建；未知、缺失、二进制或超限侧明确降级，累计也遵守 10MB 总量保护 |
| D12 | `src/git.ts` 用 `const Git = {...}` 对象而非 `namespace`；Tracker 无参数属性 | Node 原生 TS strip 模式不支持 namespace/parameter property（自测直跑 .ts 需要） |
| D13 | Git provider 只移植 diff 三 mode 及其依赖查询；Effect/AppProcess → Node async/spawn；不搬 init 或临时索引 intent-to-add 批处理，未跟踪文件走原有逐文件 `--no-index` 兜底 | pi 无 Effect 底座；Git 必须只读；大量未跟踪文件会增加 CLI 调用次数，后续性能实测有需要再优化 |
| D14 | 原生 Git 输出适配现有 `FilePatch`：二进制为空 patch + binary，超限为 emptyPatch + tooLarge；行数保留 Git numstat；默认上下文 12 | pi TUI 需要明确降级标记；对齐上游 TUI 的 VCS 上下文，与会话全文件上下文区分 |
| D15 | 逐文件查询加入 `--literal-pathspecs`；上下文校验为非负安全整数；读取文件失败抛错 | 防止特殊文件名被解释为 pathspec；参数边界与错误路径明确，避免失败冒充空 diff |
| D16 | 全屏显示改用 `ctx.ui.custom(..., { overlay: true })`，width/maxHeight 100%、无边距、原点定位；通过 done 退出 | pi 1.2.0 的非 overlay custom 固定安装在编辑器容器，公开 API 无法安全替换并恢复全屏根布局；用户于 2026-10-14 比较使用性/维护性后明确批准 |
| D17 | 一期只展示选中文件；键盘 [/] 切焦点、j/k 切下一个/上一个文件；宽度 <90 时 [/] 切整页文件树/diff（键位于 2026-10-19 按 D34 更新）；不搬 reviewed、hunk 跳转、鼠标菜单、基点选择器 | 选中文件视图及键位按已确认的 pi 设计；上游额外交互后续有需求再补。Git 基点仍按阶段二规则解析，不改变后端语义 |
| D18 | DiffRenderable → 自有逐行解析/配对与 viewport 渲染；默认字符级软换行，3000/128 按视觉行分块缓存，最多 4 块 | pi-tui 无原生 diff 组件；2026-10-15 用户确认换行替代横移。Intl.Segmenter 保持字素、pi visibleWidth 计算终端列；按逻辑行保存布局及累计视觉高度，不把超长行全部物化为渲染字符串。布局偏好回调保存，v/V 切换 |
| D19 | 文件名、标题、历史时间与源码控制字符转为可见转义；使用 pi-tui 组件协议直接组合固定视口字符串，不用会物化全部内容的 ScrollView | 防止输入被终端解释为控制指令；虚拟化时只格式化可见块。普通行上下文用 muted、增加用 success、删除用 error，行内高亮仍留 v2 |
| D20 | 无 git 的 mtime marker 附带起始路径清单，扫描并报告新增/消失的文件（包含保留旧 mtime 的拷贝）；失败/中断也清理临时 marker | 仅扫描现存文件的 mtime 会漏掉删除及旧时间的新文件；保留同一个扫描实现，不扩大无 git 旧侧能力，删除显示 previous contents unavailable |
| D21 | 缓存与布局偏好使用临时文件 + rename 原子替换；读取缓存验证 sha256，entry 校验编号/时间/计数/状态/hash/flags；缓存分片仅 rmdir 空目录 | 防止半写入、损坏或伪造 hash 变成错误 patch；清理不递归删除并发新增对象。偏好存在数据目录 view.json，退出 done 后保存，坏配置恢复默认 |
| D22 | FilePatch 增加 unavailable/cumulativeFallback 可选标记；文件读取或旧侧捕获失败明确显示内容不可用 | 失败不能冒充文件不存在、成功删除或空变更；保持旧格式兼容。Git 子目录路径统一换算到 cwd；已删除基线记录 null；单一登记入口在异步捕获后再次防覆盖 |
| D23 | 新增 unstaged 范围：索引 → 当前文件，并列出未跟踪文件；其余三个 Git 范围不变 | 用户实测要求区分未提交与未暂存；复用原生 git diff 不带 revision 的语义及现有解析、上下文/总量保护管线，所有查询只读 |
| D24 | 原范围名称用英文、说明与状态用中文（2026-10-19 由 D33 双语方案替代）；Tab/Shift+Tab 循环范围，v 切合并/拆分；鼠标点击文件/目录和视图按钮及分区滚动 | 用户最终确认无选择器；v 与 opencode 布局切换一致。pi 正式 handleMouse 支持鼠标；文件树滚动不改变文件选择 |
| D27 | 整个 /diff 只挂载一次 custom/overlay，切范围只更新当前组件；请求编号隔离乱序结果，关闭后忽略迟到回调；查询失败留在当前范围内提示 | 修复切范围先关闭 overlay 导致聊天内容闪露；对齐 opencode 原视图内切数据源的生命周期，加载中不冒充成功空 diff |
| D28 | 鼠标滚动自动决定键盘操作区域，保留纯键盘导航与窄屏切页（当前键位见 D34）；横移与按钮于 2026-10-15 移除 | 旧版 Shift+滚轮横移按整文件最长行限制，当前可见短行会出现空白；用户确认默认换行后直接删除横移状态/控件，普通和 Shift+滚轮均纵向滚动 |
| D29 | 默认软换行，续行留空源行号并标 ↳；拆分两侧按每对源行最大高度补齐，布局/宽度变化按源字符重定位；增删行背景复用 toolSuccessBg/toolErrorBg；v/V 接受大小写，不能切换时提示原因 | 对齐上游主 diff 的 wrapMode=char 和增删背景；上游超长新增 patch 的虚拟分块强制 none，我方为满足用户统一换行改用累计高度索引。pi 的 wrapTextWithAnsi 会丢代码空白，故保留字素与空格；不新建配色系统或依赖，不改追踪/Git/快照 |
| D30 | A/D 文件从首次显示即固定标明合并视图，按钮与快捷键提示禁用布局切换，v/V 和点击不改变说明或偏好 | 上游渲染也强制 A/D unified，但布局命令操作全局偏好；本项目按用户本次选择禁用当前 A/D 的切换，避免出现“说明变了但画面没变”的状态。M 文件仍可切换，提示与真实布局分别显示 |
| D31 | 顶栏汇总当前范围所有文件的增删行数；文件树选中行使用 pi selectedBg 整行背景与 accent 文件名 | 用户要求左上角显示范围总增删行数、强化选中项；直接相加现有 FilePatch 计数，沿用降级计数，不改后端。上游选中文件仅加粗，本项目复用 pi 主题选中背景提高辨识度 |
| D32 | 同步紧凑布局取消 diff 外侧留白；保留本项目 <90 列阈值、文件树页（当前键位见 D34）和全屏单 overlay，不移植停靠面板及 gutterPadding | opencode 全屏紧凑阈值 88 列来自其宿主分栏最小宽度；pi 没有对应 session.panel 槽位，继续已有 90 列边界。pi 行号在构造时按整文件同步计算，现有增删背景已覆盖行号；无挂载时序修复或卡片 gutter 补列需求 |
| D33 | 界面默认英语，大写 L 即时切换英语／简体中文；语言偏好关闭时原子保存到 language.json，全局沿用；最初小写 l 保留焦点操作，现按 D34 改为同样切换语言 | 用户于 2026-10-19 确认；轻量类型约束文案表，不增加依赖。切换保留浏览状态，不查询 Git；标题／状态与占位提示按当前语言解析，按钮按实际译文宽度命中。命令菜单简介固定英文，原始内容及底层错误不翻译；追踪／快照／Git／entry 格式不变 |
| D34 | j/k 在文件树中切下一个/上一个文件，内容区按 D36 滚动；[/] 分别聚焦文件树/内容，窄屏仍切对应页面；l/L 均切换语言，移除旧 h/n/p 绑定 | 用户于 2026-10-19 确认；复用现有文件导航和焦点逻辑，仅替换按键与双语提示。方向键/鼠标/目录折叠、五范围和布局切换行为不变，无配置迁移或后端改动 |
| D35 | 底部靠前明确显示当前焦点（Focus: Files/Diff／焦点：文件树/内容），[/] 和鼠标切换后同步更新 | 用户反馈括号切换看不出变化；本地普通括号与 pi 1.3 按键识别正常，原宽屏仅文件树标题变色，纯文本画面没有变化。新增实际 overlay 路由回归覆盖普通、CSI-u、xterm 格式及两种语言/宽度/主题；不改变按键解析与导航逻辑 |
| D36 | j/k 服从当前焦点：文件树中切下一个/上一个文件，内容区向下/向上滚动；底栏同步显示文件/滚动语义 | 用户确认括号能切焦点，真正问题是 j/k 全局分支在焦点判断前直接切文件。为文件导航增加 tree 条件，diff 中复用已有纵向滚动与边界限制；补验实际 overlay 的 j/k 输入及鼠标焦点，保留箭头和目录行为，不改后端 |
| D37 | countPatch 按 hunk 声明的旧／新行数计数，区分正文与文件头 | 固定上游基线也按 +++/--- 前缀排除，误吞源码以 ++/-- 开头的改动；独立核验已复现。只修统计，不改 patch 生成或上下文，保留多文件、多 hunk 和无末尾换行语义 |
| D38 | Git 的明确 edit/write 目标若缺失于轮次基线和起始 HEAD，在执行前补取磁盘旧侧 | 上游 Snapshot 按 ignore 规则过滤；pi 的工具目标已明确，不能把已有忽略文件冒充新增。仍经 recordFileChange，不扩大自动扫描或 Git 范围，不改 HEAD 钉定和预脏基线优先级 |
| D39 | 无 Git 临时 marker 保存路径及 mtime/ctime 纳秒值、大小、设备/inode 元数据签名 | 替代仅判断 mtime 大于 marker 的规则，捕获保留 mtime 的同大小改写／替换；沿用同一 walk/scanWorkspace 和临时文件释放，不全量读文件，不宣称 shell 旧侧可恢复 |
| D40 | Git 的 HEAD／status 并发查询；无 Git 的每目录文件 stat 分批并发（最多 32），目录递归串行 | 借鉴上游 Effect.all 的独立查询并发；不省略前后边界、不写 Git 索引，不引入常驻监控或跨扫描缓存。目录串行避免深层树放大并发，保留读取失败与删除竞态处理 |
| D41 | 文件树／diff 分隔线支持拖动，树宽 30 列至窗口一半，右侧至少 40 列；仅本次视图保留宽度 | 用户确认的 UI 扩展；上游仍固定自动 30–40 列，默认值沿用。复用 pi handleMouse/capture，不修改宿主；窗口缩放、释放合成 click、切范围／窄屏取消均明确处理，不改后端、Git 查询或落盘偏好 |
| D42 | 分隔线 hover 高亮并在底栏显示双语“拖动调整宽度”，进入／离开才重绘，拖动命中与 hover 共用判断 | 用户确认 reload 后拖动已生效，补足可发现性。借鉴上游 session-tabs-rail/dialog 的 hover/leave 状态模式，pi 侧使用正常 move 事件；提示不限定按键或手势。不改鼠标协议／宿主，不改变焦点、选中项或限宽规则 |
| D43 | 两列命中、单列背景高亮、300ms 双击恢复自动宽度、release 最终位置结算；左边缘完全收起，顶部按钮／`[` 恢复 | 移植上游 ui/pane-resize.ts 与 pane-resize-handle.tsx 的交互语义，用现有 pi capture 替代 OpenTUI 父级事件。核实上游左会话栏最小 5 列为紧凑态，diff 文件树另有开关；按用户要求为 pi diff 增加完全收起。展开限宽现按 D47，收起转焦点到内容；只保留本次视图状态，不移植上游持久化及 SolidJS 控制器 |
| D44 | Git 默认打开 Unstaged，非 Git 保持 Last turn；循环顺序不变，无改动也不回退 | 用户于 2026-10-20 明确要求；复用已有 Git.isAvailable 和 loadScope，不增加额外探测，不记忆上次范围或修改追踪。上游默认取 initialMode/记忆/配置/branch，pi 按此次要求选择入口 |
| D45 | A/M/D 从树最右端改到选择箭头后的固定左列，先保留标记再裁切名称 | 用户要求始终可见且不跟随分隔线移动；上游为 flexGrow 文件名 + 固定右端状态列，pi 依用户要求替换为前缀，保留颜色、整行选中背景、目录排序／折叠与命中逻辑 |
| D46 | 展开树宽下限由 30 改为 20 列，上限由半屏改为窗口三分之一；默认自动 30–40 列不变 | 用户明确需要更多向左缩窄空间，右侧不能拖到中间。仅修改拖动边界并将默认下限与拖动下限分开；正坐标始终保持展开，只有真正到最左列 x <= 0 才收起。右侧至少 40 列、临时状态、双击复位与跨范围行为沿用 |
| D47 | 展开最小 10 列、最大窗口四分之一，默认宽度也受新上限约束 | 用户再次要求向左更多、向右更少，并明确选择此组参数；仅替换 D46 的两个限宽参数。正坐标仍保持展开，最左边缘收起、复位、临时状态及右侧至少 40 列沿用 |
| D48 | 显式 `[` 展开时取消旧拖动并清空双击计时，忽略旧手势迟到的 drag/release/click | 复现用户反馈：收起后拖动捕获尚未结束，键盘展开只改 collapsed，迟到事件再次按 x=0 收起。复用 released 哨兵阻止旧手势写入，保留真实边缘收起和同次反向拖回；新的 press 重新开启拖动。不改 pi 宿主或鼠标协议 |
| D26 | UI 只显示 Last turn、Session total、Unstaged、Uncommitted、All branch changes；默认入口现按 D44；删除选择器/d/范围按钮与历史列表，不展示独立 Committed | 用户于 2026-10-14 明确收敛为这五项；后端每轮持久化和 Git committed 查询保留，避免改变历史数据与底层行为 |
| D25 | 检测旧嵌套 customType/损坏 entry 并提示历史不可用，不修补或伪造 patch | 本机「阶段1」80 条旧记录全是 turn=0/patches=[]，不能等同于有效空轮次；旧历史恢复与外部文件追踪另写暂缓设计，不改用户会话 |

---

## 阶段 1：数据层（core 侧移植）

步骤 0（研读与同步，开工第一件事）：
1. 跑 `./scripts/sync-opencode.sh`，若上游有更新按「上游同步」节处理后记录新基线
2. 通读 `reference/opencode/` 下 `vcs/patch.ts`、`snapshot.ts`、`session/diff.ts`，把函数级规格（签名、算法、边界）补进本节

- [x] 1.1 `src/diff-engine.ts`：照搬 `vcs/patch.ts` 全部原语（structuredPatch/addPatch/deletePatch/emptyPatch/countPatch/splitGitPatch/chunksByFile/fileFromPatchChunk）；修正常量为全文件上下文 + 10MB；TS strict 化（另加 `makeFilePatch`/`FilePatch` 视图层，D11 相关）
- [x] 1.2 `src/snapshot.ts`：按 `snapshot.ts` 移植 capture/diff（[替换底座]）；内容寻址存储；30 天 atime LRU 清理（noatime 文件系统回退 mtime）
- [x] 1.3 `src/tracker.ts`：`scanWorkspace(marker)` 双后端（git 签名串 / mtime marker，见 D8）；`recordFileChange()` 单入口（含 git 恢复旧侧 D9 / baselineUnknown）；`onTurnStart`/`onBashBoundary`/`finalizeTurn`；index.ts 接线 tool_call(bash) 前后 + edit/write 目标解析
- [x] 1.4 `src/store.ts`：`collectTurnDiffs`（getBranch 遍历）+ `restoreFromSession` + `sessionPatches`（按 path 合并各轮 patch，语义对齐 opencode 会话累计；降级见 D11）
- [x] 1.5 临时目录自测：`npm test`（tests/selftest.ts）：edit/write 2 文件 + bash sed 1 文件 → 恰好 3 文件；与 `git diff` 计数抽样比对；git add 竞态/预脏文件/净零文件/无 git baselineUnknown/重建全部覆盖

## 阶段 2：git 集成

步骤 0：跑 `./scripts/sync-opencode.sh`；通读 `vcs.ts` + `plugin/vcs/git.ts`，逐函数规格化（spawn 参数、输出解析、总量保护）。

- [x] 2.1 `src/git.ts`：移植 git provider 主体（branch/committed/working 三 mode，context=12，MAX_TOTAL_PATCH_BYTES 保护）；新增 `Git.diff(cwd, mode, { base?, context? })`，返回既有 `FilePatch[]`
- [x] 2.2 无 git 降级（静默空结果）；无 HEAD 时 committed 为空、其余列新增文件；`git show :path`/`HEAD:path` 基线内容复验
- [x] 2.3 验收：`npm run typecheck` + `npm test`（阶段一 7 项、阶段二 6 组）通过；三 mode 与裸 `git diff` patch/计数比对；无 git、基点选择、特殊路径、子目录、二进制、10MB 单文件/总量保护、索引不变覆盖；对抗性复查追加重命名、ignore、未解决合并冲突案例

阶段二同步记录（2026-10-14）：用户确认先同步上游；`3a69bae` → `34d8ded`，`git diff` 确认 `packages/core/src` 与 `packages/tui/src` 无变化，行为规格与移植清单无需因同步调整。Git 模式定义和新增适配偏离已在上表记录。

## 阶段 3：TUI

以下为当时实施记录；选择器和早期键位已由阶段 5 的最终约定替换。

步骤 0：跑 `./scripts/sync-opencode.sh`；通读 `diff-viewer*.tsx` + `patch-diff.tsx`，列 signal/键位/布局规格表；先读 pi-tui `.d.ts`（`~/.pi/agent/install/releases/1.2.0/node_modules/@earendil-works/pi-tui/`）确认可用组件，**不猜签名**。

- [x] 3.1 `src/tui/file-tree-utils.ts`：直接复制，`cmp` 与上游一致；目录链折叠、目录优先排序、展开与文件索引原语原样保留
- [x] 3.2 `src/tui/scope-selector.ts`：范围选择（最近一轮/轮次列表/会话累计/git×3，无 git 隐藏），使用 pi SelectList；轮次列表 resize 保留选中项
- [x] 3.3 `src/tui/file-tree.ts` + `diff-screen.ts` + `patch-diff.ts`：布局常量照搬；Tab unified/split；h/l 焦点；虚拟滚动 3000/128；主题 token 染色（+/−/context）；binary/tooLarge/baselineUnknown 占位；默认宽屏 split、窄屏 unified，新增/删除文件始终 unified（对齐上游）
- [x] 3.4 组件验收：`npm run typecheck` + `npm test`；新增 8 组 TUI 测试，覆盖目录折叠、范围选择、行号/多 hunk/不等长替换、降级、1–160 列/CJK/resize/控制字符/主题失效刷新、万行 patch 500 帧滚动。真实 pi TuiAltScreen + 内存终端验证 overlay 铺满、缩放、焦点与原内容恢复；物理终端与实际 `/diff` 验收留阶段四接线后

阶段三研读与同步（2026-10-14）：`sync-opencode.sh --check` 确认 `34d8ded` 为最新；已核对上游主视图、文件树及 patch 渲染器和本机/依赖 pi 1.2.0 `.d.ts`、custom 安装与退出实现。规范中的非 overlay 全屏假设与真实 API 冲突，用户确认改用全屏 overlay（D16）。未修改 Tracker、SnapshotStore、持久化或 Git 的任何后端逻辑。

| 主题 | 上游规格 → 本期实现 |
|---|---|
| 布局 | MIN_SPLIT_WIDTH=100、文件树 30–40 列且窗口 ≥90 才并列显示、文件 header 2 行；右侧空间不足时强制 unified |
| 状态 | selectedFileIndex、expandedFileNodes、viewOverride 与滚动偏移移植为 class 字段；仅缓存当前文件的解析结果，退出不留后台进程 |
| 输入 | 上游滚动/换页/首尾/切布局能力对应 ↑↓、PageUp/PageDown、Home/End、Tab；pi 指定 [/] 焦点，Enter/Space 折叠目录，j/k 文件导航（当前键位见 D34），Esc/q 退出 |
| 渲染 | split 按连续删除/增加块配对，正确推进两侧行号；新增/删除文件用 unified；所有行适配字符宽度并填满视口，防止 overlay 透出聊天内容 |

## 阶段 4：收尾与对抗性审查

以下为当时实施记录；入口已移除选择器（阶段 5），当前默认范围见 D44。

- [x] index.ts TUI 最小接线：等待 idle → 恢复当前分支 → ScopeSelector → 加载每轮/累计/Git 数据 → DiffScreen；全屏 overlay，通过 done 正常退出；取消不打开空页面、查询失败显示错误提示
- [x] 布局偏好保存/恢复：连接 DiffScreen 的 view/onViewChange；通过 ctx.ui.custom 的 done 生命周期退出，勿直接调用 overlay handle.hide
- [x] 错误路径：Git 查询失败 notify；文件读取/旧侧捕获失败 unavailable；损坏 entry 跳过；缓存缺失累计降级带标记；扫描失败释放 marker
- [x] `/tree` 分支切换后 turn 序号与 patches 正确；真实 JSONL 分支重放/重开/空轮次编号测试及实际 pi `/tree`、`/resume` 验证通过
- [x] 对抗性审查：实际 pi codemode/QuickJS 委托名为 spawn 的测试工具，以子进程写文件；Git/无 git 轮次扫描均捕获（未调用模型或真实子代理）
- [x] 全量对照偏离登记表复查；AGENTS.md 验收清单逐项打勾

阶段四第一批（2026-10-14，用户确认优先最小可用）：入口原本以 `void` 丢弃追踪 Promise，而 pi ExtensionRunner 会等待事件处理器；现改为 async/await，确保 before_agent_start 基线、tool_call 旧侧捕获、tool_result 扫描、agent_settled 持久化按契约完成。命令使用 waitForIdle 等待 settled 收尾；session_tree 后重建追踪状态，命令打开时再次按 getBranch 重放。未改动 Tracker、Git、快照或 patch 算法。

第一批验证：新增 4 组入口集成测试，覆盖实际 pi 扩展加载器、旧侧捕获与 settled 等待、shell/非内建工具改动补登记、取消/非 TUI/当前分支刷新，以及 Git 三范围与缺失基点错误；当时全量 25 项测试与 typecheck 通过。本机 pi 1.2.0 的隔离 PTY、无模型调用验收通过 `/diff` → 范围选择 → 无改动页面 → q 返回及 `/reload` 后再次打开。

阶段四收尾（2026-10-14）：开工 `sync-opencode.sh --check` 确认基线未变。布局偏好原子持久化至 `~/.pi/agent/data/pi-diff/view.json`。对抗性复现并修复累计创建/删除/重建、失败 write 虚假改动、无 git 删除、Git 恢复干净及轮内提交漏检、子目录旧侧、并行登记覆盖、读取失败、缓存损坏与临时 marker 泄漏；新加 14 组可靠性测试，合计 39 项全通过，typecheck 零错误。每轮保存（含空轮）由用户明确确认，已更新 D10。逐项复查偏离及只读 Git，不改上游参考源码，不加依赖。

真实 pi 1.2.0 离线 PTY 验证：启动加载含 patch 的 JSONL → `/diff` 显示 B 分支；Tab 切 unified、q 退出后偏好落盘，`/reload` 后再次打开保留布局和历史；`/tree` 无摘要切到 A 分支后仅显示 A 的 patch；`/resume` 选择第二会话后显示 resume.txt 的旧/新侧。进程已退出、临时会话目录已删除，原布局偏好已恢复。此验证不调用模型，不代表真实模型子代理或物理终端视觉验收；这些留日常使用反馈。旧会话此前未保存的空轮次无法补回，累计缓存缺失时保留明确的最后一轮降级提示。

试用：当前 `~/.pi/agent/extensions/pi-diff` 是指向本工作区的软链接，在已有 pi 中先输入 `/reload`，再输入 `/diff`。会话没有记录时每轮/累计页面为空，可选 Working copy 查看 Git 改动；无 Git 项目仅显示会话范围。

---

## 阶段 5：实测反馈的简单改进

用户于 2026-10-14 确认：先完成简单功能，复杂功能写文档、暂不做。范围以本节为准，不代表完全移植上游所有功能。

- [x] 英文范围名称与中文比较对象说明；区分无有效历史、有效空轮次和部分历史缺失
- [x] /diff 当时默认直接打开 Last turn（2026-10-20 Git 默认改为 Unstaged，见 D44）；按用户最终顺序 Tab/Shift+Tab 循环 Last turn → Session total → Unstaged → Uncommitted → All branch changes；无 Git 只循环前两项；彻底删除选择器、d 和范围按钮
- [x] v 或顶部按钮切换合并/拆分；宽度不足和新增/删除文件继续使用合并视图；保留布局持久化
- [x] 全程一个全屏 overlay，切范围/加载/错误不返回聊天；快速切换只接收最新结果，退出后不再更新；加载错误可继续 Tab 切其他范围
- [x] 正式鼠标接口：文件/目录点击，文件树/内容区分区滚动，视图按钮切布局；窄窗口点文件后进入内容区
- [x] 鼠标操作自动选区域；默认自动换行，删除横移及左右按钮；h/l 对纯键盘及窄屏仍有效，简化焦点提示（2026-10-15 替换旧横移方案）
- [x] 增删行含背景；续行不重复行号、拆分补齐中性空白；v/V 无法切换时解释宽度、新增/删除文件或无文件原因
- [x] 未暂存范围：索引 → 文件、含未跟踪；无 HEAD、暂存后再改、已暂存未改、子目录、删除、二进制、上限与索引不变回归
- [x] 复杂功能设计文档：[docs/deferred-features.md](docs/deferred-features.md)；本期不恢复旧历史、不扩大文件追踪边界，不实现拖选/复制、右键菜单等

同步记录：`34d8ded` → `5fa0a4238647dc25df137cb3df7e0d7eb8454d67`；原生 git diff --name-only 确认 core/src、tui/src、LICENSE 均无变化，行为规格/行数无需调整。现行 hash 已同步 AGENTS.md、NOTICE.md 和 pin；只通过已授权同步脚本更新参考副本，不编辑上游源码。

规格复核：此次重新通读纠正此前对轮次和快照捕获范围的简述（idle 边界、跨 Location 拒绝比较、未跟踪捕获 2MiB），不是本次上游变化。pi 的事件/扫描/内容缓存替代继续按 D2/D4/D11；AGENTS.md 的 appendEntry 示例改为真实两参数契约，避免旧格式错误再次发生。

后续闪屏反馈修正：之前用 done 结束一次 custom，再加载下一范围，导致聊天闪露；改为单组件 setData 更新。46 项测试覆盖同一 custom 生命周期、真实 TuiAltScreen 加载中/切数据不露聊天、快速 Tab 乱序响应、退出后迟到错误、加载失败页，以及规范化/原始 SGR Shift+滚轮、左右按钮、窄屏和自动操作区域。未修改 Tracker/Git/快照算法；未修改宿主 pi 鼠标解析。物理触控板直接横滑仍未支持，兼容替代为 Shift+滚轮或左右按钮。

本次离线真实 pi 1.2.0 PTY 补验：直接打开含长行 patch 的 Last turn，反复 Tab/Shift+Tab 切 Last turn/Session total，完整终端输出中未出现底层聊天标记；原始 SGR Shift+滚轮实际横移内容，q 后恢复聊天。未调用模型、未修改布局偏好；测试进程已退出，夹具已清理。

2026-10-15 反馈收尾：用户确认默认自动换行，替换此前横移方案。复核上游主视图 wrapMode=char、addedBg/removedBg 与虚拟分块 none 的差异；pi 仍维持 100 列拆分阈值和新增/删除统一合并的行为。50 项测试与 typecheck 通过，覆盖代码空格、中文/组合字符/emoji、续行行号、拆分高度与背景边界、深浅主题、v/V 和不能切换的解释、缩放/布局锚点、滚动末尾，以及百万字符单行仅绘制可见块。Tracker/Git/快照与五范围不变；基线仍为 5fa0a423，未修改上游源码。

本次真实 pi 1.2.0 离线 PTY 复验：160×24 窗口直接进入 Last turn，中文长行续行显示 ↳、末尾 OLD_END 可见且上下文仍为源行号 2；隔离 dark 主题实际输出增删背景色 ANSI。Tab 切到 Session total 未输出底层聊天标记，q 恢复聊天，进程正常退出。无模型调用，未改用户布局偏好或主题设置；测试夹具已清理。伪终端不回应系统配色查询，故使用隔离内置主题确认背景，物理终端视觉仍待实测。

2026-10-15 文件状态列修正：对照 opencode 文件树，继续使用固定右侧状态列 M（修改）、A（新增）、D（删除）及其语义颜色。原来文件树按含分隔线的宽度渲染，主界面再裁掉一列，导致状态字母全部被裁掉；改为渲染前预留分隔线的一列。新增完整 DiffScreen 回归先在 90 列复现失败，修复后深浅主题、40/89/90/120/160/200 列、中文长文件名及嵌套目录均保留 A/D/M；类型检查和 16 项 TUI 测试通过。本次只改一处 UI 宽度参数，不改状态判定、追踪、Git 或历史数据；未新增上游偏离。

2026-10-15 固定合并视图说明修正：原 A/D 首次显示“合并视图”，按 v 后用原因提示替换该文字，再按无变化，造成切换后卡住的观感。现从首次显示起固定为“合并视图（新增/删除文件）”，顶部“仅合并视图”，底部不再提示可切换；键盘和鼠标均无状态变化，M 文件保留布局偏好并正常切换。类型检查及 17 项 TUI 回归通过；新增用例覆盖 A/D、100/160 列、两种初始偏好、反复 v/V/点击以及回到 M 的行为。仅调整 UI，未改追踪/Git/快照；上游源码未改，未做物理终端验收。

验证：typecheck 零错误，44 项测试通过；实际 pi SGR overlay 鼠标路由与命中、五范围顺序/循环/直接进入、无选择器/d 无效、旧损坏历史与有效空轮次、Git 四个底层 mode 逐 patch 比对和只读验证。真实 pi 1.2.0 离线 PTY 验证旧历史提示、Tab/Shift+Tab 连续切范围、未提交与未暂存旧侧区别、v 切布局、鼠标点击文件/滚轮、d 返回选择器；该 PTY 验证早于删除选择器和最终英文五范围的调整，最终入口变更已通过集成回归；不调用模型。物理鼠标和不同终端兼容性仍待用户实际试用。

---

2026-10-15 范围统计与选中态改进：顶栏在当前范围文件数后显示全部文件的 +新增/-删除行数，使用 success/error 主题色；切换文件不影响总数，切换范围后直接按新数据重新汇总。文件树选中行增加整行 selectedBg 背景与 accent 文件名，焦点切回内容区时仍保留选中高亮；目录导航、A/D/M 状态列和鼠标命中保持原行为。新增 2 项回归先验证失败后通过，覆盖五范围/空数据、深浅主题、40/90/160 列、键盘/鼠标与背景覆盖状态列。typecheck 零错误，全量 55 项测试通过；未做物理终端视觉验收，未改后端或上游源码。开工 sync-opencode.sh --check 检出上游 tip 为 81200db2，按只检查模式保持本地钉住的 5fa0a423 基线，未同步源码。

## 2026-10-16 上游同步与整体对照

通过既有脚本将参考副本从 `5fa0a4238647dc25df137cb3df7e0d7eb8454d67` 同步到 `ed772f5009755b5262805a7ba07e66e1417f140a`（dev）。没有手工修改上游源码；pin、AGENTS.md、NOTICE.md 与本计划现行基线一致。

相关映射源码中仅 `diff-viewer.tsx` 与 `component/patch-diff.tsx` 有变化；快照、session/diff、VCS/Git provider、patch 原语、文件树及其工具、图片/文件菜单和 util/diff 均无差异。行为规格与移植清单行数已更新。

| 上游变更 | 本次处理 |
|---|---|
| 停靠面板、全屏切换、紧凑卡片及焦点/主题适配 | 同步窄屏取消左右各 2 列留白，释放 4 列内容宽度；宽屏维持原布局。面板依赖 opencode 宿主，不增加 pi 宿主改造（D16/D32） |
| gutterPadding 与延后同步行号侧 | pi 无异步行号组件，现有整文件行号宽度不受虚拟块挂载影响，背景已包含行号；不增加无效重试（D18/D29/D32） |
| 审阅末项后阻止重复按键重开文件（上游 3485a7b） | 本项目尚无已审阅标记，无对应缺陷；将边界条件并入暂缓设计 |
| 对话框布局统一、help 按可用功能显示 | 本项目没有对应基点/help 对话框；保留现有快捷键提示与 A/D 固定合并行为（D17/D30） |

本次范围：`DiffScreen.layout/render` 共用同一 inset，调用它的键盘、鼠标与换行计算自动获得一致宽度；新增一组回归覆盖深浅主题、40/87/88/89/90/160 列、往返缩放、h/l 和窄屏左边缘鼠标滚动。Tracker、快照、持久化、Git、五范围及布局偏好语义均未改动。README 中上一任务确认的开发环境表述保留。

整体借鉴建议按价值排序，详见 `docs/deferred-features.md`：改动块跳转、手动 Git 基点选择、已审阅标记；连续多文件和图片预览按真实需求再做。侧边面板需要 pi 宿主能力，当前不适合移植；不照搬 opencode 的数据库、Effect 或会写临时 Git 索引的优化。

验证：项目固定的 pi 1.2.0 依赖下 `npm run typecheck` 零错误，56 项全量自测通过；默认缓存/偏好通过测试进程的 homedir API 重定向到临时目录，未触碰真实用户数据。临时源码副本使用本机已安装 pi 1.3.0，类型检查与 20 项 TUI 自测也通过。`git diff --check` 通过，参考副本 core/src、tui/src、LICENSE 无手工改动，所有临时副本和测试进程已清理。本次未做真实模型会话、物理终端视觉验收或发布。

## 执行约定

- 每阶段：步骤 0 研读 → 实现 → `npm run typecheck` 零错误 → 验收 → 在本文件勾选
- 修改 `reference/opencode/` 内容 = 违规（只读基线）
- 测试临时进程/目录用完即关/删；网络命令 `/bin/zsh -ic 'proxyon && <cmd>'`
- 新对话开场白建议：「按 PLAN.md 执行阶段 N」

### 2026-10-19：英语默认与中文切换

- 首次默认英语；大写 `L` 在当前 overlay 内切换语言，底部靠前提示目标语言；退出时保存全局偏好，损坏偏好回退英语。
- 切换不重建文件树或 patch，不重查 Git；加载中和失败态可翻译，异步完成后使用当前语言。提示使用语义状态，消除对中文前缀的依赖。
- 本次运行 `sync-opencode.sh --check`，检测上游 `ba06ff9e0bf2dcefbbbc3a1d6094f3572d77c84e`；本次仅扩展本地显示层，参考源码和基线仍保留 `ed772f5009755b5262805a7ba07e66e1417f140a`，上游新增改动未合入。
- 验证通过：`npm run typecheck`；隔离 HOME 下完整 `npm test` 共 63 项（基础 7、Git 7、TUI 22、扩展 12、可靠性 15）。新增用例覆盖双语切换与浏览状态保留、按钮边界、固定合并视图、偏好回退／原子保存失败、跨实例／项目重开、五范围／旧历史及加载／失败态切换。测试临时目录已清理，未修改真实语言偏好；未做物理终端验收，未调用模型。

### 2026-10-19：快捷键调整

按用户最新选择，将文件导航从 n/p 改为 j/k（下一个/上一个），聚焦从 h/l 改为 [/]（文件树/内容），窄屏仍保留文件树页访问；l/L 统一切换语言。旧 h/n/p 不再绑定，双语底栏和 README 已同步。历史验收段落中的旧键位保留为当时记录，当前行为以 D34 为准。

验证通过：`npm run typecheck`；隔离 HOME 的完整 `npm test` 共 64 项（基础 7、Git 7、TUI 23、扩展 12、可靠性 15）。新增回归覆盖中英两种语言、40/160 列、文件导航边界、两区域导航、折叠目录、旧绑定移除及空文件列表；l/L 切语言与 [/] 聚焦不冲突。未做物理终端实测，测试临时目录已清理。

### 2026-10-19：焦点反馈修正

用户确认英文输入法，j/k 和小写 l 正常；文件导航方向最终保留 j 下一个、k 上一个。本地未复现半角括号读取失败，但复现宽屏切焦点仅改变颜色、文字不变的问题。现底部靠前显示当前焦点，仍保留语言切换提示；新增真实 pi overlay 的输入路由回归，验证 [ 后方向键选文件、] 后方向键滚动 diff。

验证通过：`npm run typecheck`；隔离 HOME 的完整 `npm test` 共 65 项（基础 7、Git 7、TUI 24、扩展 12、可靠性 15）。新用例通过实际 TuiAltScreen 输入入口验证普通、CSI-u 和 xterm 括号键，覆盖中英、40/160 列及深浅主题，检查可见焦点文字和方向键行为。另检查本机 pi 1.3 的按键解析正常；用户实际物理终端的输入未捕获，本次不宣称已复现其括号读取失败。

### 2026-10-19：j/k 按焦点分流

用户确认括号能正常切焦点，但 j/k 始终操作文件树。根因是全局文件导航分支优先于焦点判断；上一轮仅验证了方向键，未覆盖内容区 j/k。现文件导航仅在 tree 焦点时触发，diff 焦点时 j/k 复用向下/向上滚动，保持当前文件不变；默认 diff 焦点和鼠标焦点也遵循同一规则。底栏和 README 已同步，原测试“任意区域 j/k 切文件”已改为按焦点验证，并覆盖滚动首尾边界。

验证通过：`npm run typecheck` 与隔离 HOME 的完整 `npm test`（65 项）。已将既有导航回归改为真实 j/k 按焦点验证，覆盖默认内容焦点、[/] 切换、鼠标切焦点、文件不变、滚动首尾边界，以及中英/窄宽屏/深浅主题和三种括号输入格式。测试临时目录已清理，未做物理终端复测。

### 2026-10-19：上游基线同步与影响分析

按用户要求运行现有 `sync-opencode.sh`，将只读参考副本从 `ed772f5009755b5262805a7ba07e66e1417f140a` 更新到 dev 的 `ba06ff9e0bf2dcefbbbc3a1d6094f3572d77c84e`（提交时间为北京时间 2026-10-19 11:59:45）。pin、AGENTS.md、NOTICE.md 与本计划的现行基线已同步；没有手工编辑上游源码，也没有修改 pi-diff 的运行时代码或既有未提交功能改动。

此次 core/src、tui/src 与 LICENSE 范围共 29 个文件变化（新增 533 行、删除 167 行，包含生成的模型目录快照）。逐项对照确认 session/diff、snapshot、vcs、plugin/vcs、vcs/patch、全部 diff-viewer 组件、文件树工具、component/patch-diff、util/diff 和 LICENSE 均无变化；移植清单中的文件行数保持一致，现行 diff 行为规格和 D1–D36 偏离无需新增或调整。

| 上游变化 | 对 pi-diff 的影响与判断 |
|---|---|
| Shell 退出与超时只采纳首个结果；等待输出捕获完成后才发布终态；已超时的 kill 不受重设计时器中断 | 可借鉴“终态须代表结果完整”的原则，但本项目不管理 shell 执行、输出捕获或超时，依赖 pi 的 tool_result/agent_settled 后扫描；不能把 opencode 宿主的修复直接移入 Tracker，也不能据此宣称 pi 的对应竞态已验证 |
| Windows 下对临时 Git 索引更新和 write-tree 的对象并发写失败最多重试两次 | 本项目 Git 查询只读，快照为内容寻址文件，不执行这两类 Git 写操作；不添加无对应故障的重试（D13/D21） |
| 技能扫描统一为深度上限 6、跳过隐藏与忽略目录、发现 SKILL.md 后停止深入；减少目录监听范围 | 属于技能发现，不是改动追踪；不可把深度上限或隐藏目录过滤直接用于 scanWorkspace，否则会漏掉合法文件。继续保留单一扫描入口和现有范围 |
| 文件系统入口显式检查可读性；指令读取区分暂时不存在和权限拒绝 | 与本项目“读取失败不能视为删除”的原则一致。现有无 Git 目录遍历仅对 ENOENT 容错，其他错误向上传递；文件捕获失败使用 unavailable，不需要同步宿主文件系统实现 |
| 会话列表游标分页和归档/恢复；保存权限支持编辑与冲突错误；抽取通用模型重试；新增实时语音服务及模型目录更新 | 依赖 opencode 会话数据库、权限与模型服务；pi-diff 通过 pi entries 保存历史，不接管这些宿主职责，无直接移植项 |
| 选择对话框将终端宽度监听提到父级，避免每行重复注册；终端面板 WebSocket 类型修正 | 本项目没有该选择器或终端面板，DiffScreen 由 render(width) 接收宽度，无对应逐行 resize 监听，无需改动 |

结论：本次更新参考基线和文档即可，没有需要同步到 pi-diff 的 diff 功能修复。改动块跳转、基点选择、已审阅标记等仍按暂缓文档等待独立需求，不因本次同步自动实施。

验证：`npm run typecheck` 零错误；完整 `npm test` 共 65 项通过（基础 7、Git 7、TUI 24、扩展 12、可靠性 15），默认 homedir API 重定向到临时目录，保留入口测试自身的独立 home 隔离，未改真实缓存或语言/布局偏好。HEAD、pin 和四处现行基线说明一致；映射源码的旧/新 Git 对象比较及参考副本相关路径无手工修改检查通过，`git diff --check` 通过。临时测试夹具已清理，无后台服务遗留；未运行 opencode 自身测试、真实模型会话或物理终端验收，未提交或发布。

### 2026-10-20：独立核验问题修复与开销复测

用户授权依据验证结果修复，优先参考 opencode。本轮通读只读基线 `ba06ff9e0bf2dcefbbbc3a1d6094f3572d77c84e` 的 `vcs/patch.ts`、`snapshot.ts`、`plugin/vcs/git.ts`：上游计数也误排除正文 +++/---，快照按 ignore 过滤，独立查询使用 Effect.all 并发。按 D37–D40 做最小修正：hunk 边界计数；明确工具目标缺失于预脏基线与起始 HEAD 时补取执行前旧侧；无 Git marker 比较 mtime/ctime 纳秒值、大小、设备/inode；HEAD/status 并发、每目录 stat 以 32 个为批次且目录串行。没有改动 UI、依赖、entry 格式、每轮自包含、全文件上下文、Git 范围或只读约束。

开工通过现有代理命令执行 `sync-opencode.sh --check`，因本机 127.0.0.1:7897 不可连接失败；保留已固定参考副本，不声称核对了远端最新版本。

新增三项回归在修复前均失败，修复后通过：正文伪文件头计数、Git 忽略明确目标的旧侧（含未首次提交、无改动工具、真正新增、索引字节不变）、无 Git 同大小改写／替换且保留 mtime。`npm run typecheck` 零错误，隔离 HOME 的全量自测 68 项通过（基础 7、Git 8、TUI 24、扩展 12、可靠性 17）；原有并行登记、轮内暂存／提交、读失败、临时 marker 失败释放回归均保留。独立前后字节快照／自写解码器核验 107/107 次比较、10/10 类场景通过，核验器自身有 9 项正反自检。

同一真实入口事件／SessionManager 落盘基准，六场景各启用／停用三次，共 36 个新进程顺序测量。每轮附加耗时中位数：Git 100 文件 143.1→100.3ms；2,000 文件／500 预脏 677.2→621.3ms；无 Git 2,000 文件 176.3→102.4ms，10,000 文件 839.4→454.2ms；100 轮修改 128KiB 文件 143.3→119.4ms。一万文件 Git 场景 777.4→255.3ms，但复测范围 180.1–1123.4ms，波动大，不据此宣称稳定提升比例。短样本堆内存差值受 GC 噪声影响，负数不代表节省内存；JSONL／缓存字节数与修复前完全一致，保持原有历史契约。各样本模型可见消息均与独立构造的原序列相同，diff custom entry 不进入上下文。

对抗性复核：不覆盖固定 HEAD／预脏基线，不全量读取无 Git 内容，不扩大 Git ignore 范围；stat 不含 atime，目录串行防止递归放大并发。元数据方案仍依赖文件系统暴露变化，无 Git shell 旧侧仍未知；不重写旧历史的错误计数或缺失旧侧。未调用模型、未做真实子代理／物理终端／跨平台验收，未提交或发布。所有测试缓存与会话均隔离在临时目录，测试进程正常退出。

### 2026-10-20：文件树／diff 分隔线拖动

用户确认文件树最少 30 列、最多窗口一半，右侧至少 40 列；宽度仅本次 `/diff` 内保留，重开恢复默认。阅读当前 layout/handleMouse/render、pi-tui 1.2.0 `.d.ts` 与 TuiAltScreen 捕获／release 合成 click 实现，核对 opencode 固定 30–40 列默认规则，按 D41 扩展显示层。开工上游 --check 仍因本地代理 127.0.0.1:7897 不可连接失败，保留既定只读基线。

仅修改 DiffScreen 的临时宽度／手势状态与布局。左键命中正文分隔线后 capture，拖动实时限宽并高亮，松开结束；消费 release 后的合成 click，避免误选文件。捕获目标 bounds 可能滞后于 resize，因此活动拖动使用实时终端列数；窗口缩小只限制显示宽度，不抹掉此前选择的宽度。切范围／进入窄屏取消手势，作用域加载后仍保留本次宽度。原键盘／滚轮／文件选择、焦点、滚动锚点、自动合并与保存布局偏好均沿用。

新增三组回归先在旧实现失败，修复后通过：中英、深浅主题、90/120/160/240 列的左右越界及正常点击；跨范围／重开／窄屏取消与缩放恢复；真实 TuiAltScreen 中的 SGR press/drag/release，含 capture 旧 bounds、同点 release 合成 click、缩放后松开、继续选文件及底层聊天遮蔽。中文标题坐标按终端显示列宽计算，不用字符串字符数代替。隔离 HOME 下 typecheck 零错误，全量 71 项自测通过（基础 7、Git 8、TUI 27、扩展 12、可靠性 17）。未修改追踪／快照／Git／持久化或安装设置，未新增依赖／后台服务，未做物理终端拖动验收，未提交或发布。

### 2026-10-20：分隔线悬停反馈与设备无关文案

用户随后确认实际拖动正常，先前是忘记 reload；本轮补可发现性，不再把拖动描述为未复现故障。核对本机实际 pi 1.3.0、fullscreen 设置与加载到本项目的扩展链接。参考本地 opencode session-tabs-rail/dialog 的 onMouseOver/onMouseOut 反馈模式（上游 diff 本身仍固定自动宽度），按 D42 增加指针位置与共用的分隔线命中判断。move 进入／离开才请求重绘，悬停及拖动时高亮分隔线、在底栏前部显示提示；缩放按当前几何重新判定，空文件／窄屏不显示提示，切范围清除旧位置。未改拖动边界、鼠标协议、宿主或数据后端。

用户指出“按住左键”限制了输入设备，最终采用“↔ 拖动调整宽度”／“↔ Drag to resize”，README 同步中性描述，不限定鼠标按键或触控板手势。

新增两组 hover 回归先在旧实现失败，加入后全量 73 项自测通过（基础 7、Git 8、TUI 29、扩展 12、可靠性 17），typecheck 零错误；最终文案又通过固定依赖的 29 项 TUI 回归，并用本机 pi 1.3.0 宿主的内存终端测试副本通过 29 项 TUI 回归。覆盖中英／深浅主题、进入离开提示、重复 move 不重绘、语言切换、焦点／选中／滚动不变、header/footer 排除、窄屏／空范围及实际 SGR motion→press→drag→release→leave 路由。测试 home、缓存及副本全程隔离，无模型调用或宿主改动。用户确认的物理拖动成立，物理 hover 仍待试用；未提交或发布。上游 --check 因本地代理端口不可连接失败，既定基线未变。

### 2026-10-20：移植通用分隔线交互与文件树收起

补读既定基线 `ui/pane-resize.ts`、`ui/pane-resize-handle.tsx`、`ui/layout.ts`、app/session 的挂载点及 diff-viewer 的文件树开关。纠正此前只检查 diff-viewer 而漏掉通用控制器的范围：上游有两列命中、单列 hover/拖动背景、300ms 双击默认值及 mouseDragEnd/mouseUp 的最终位置结算。其左会话栏最小 5 列、12 列以下显示紧凑态，并不等于完全关闭 diff 文件树；diff 文件树本身仍自动 30–40 列，通过单独开关隐藏。开工 --check 因本机代理不可连接失败，未改参考副本和 pin。

按 D43 移植上述可复用交互，用 pi capture 适配，背景使用 pi selectedBg，不引入 SolidJS/OpenTUI 控制器或持久化。依用户新增要求，分隔线拖到最左列（x <= 0）完全收起，尚未触边时继续守展开最少 30 列；收起切焦点到内容，保留文件选择、目录、阅读锚点和最后展开宽度，同一次捕获可反向拖回。顶部双语按钮及 `[` 可恢复，顶栏布局切换命中随按钮偏移；A/D 固定合并不受影响。临时宽度与收起状态跨范围保留，重开重置；窄屏和范围加载仍取消拖动。

新增四组回归，覆盖两列命中与状态列排除、深浅背景、双击与超时单击、复位后自动响应窗口、最终 release 位置、中英／90/160/240 列的收起恢复与同次反拖、收起后 j/k、切范围和窄屏恢复、A/D 偏好不变；真实 pi SGR 路由覆盖左边缘收起、按钮和键盘恢复、偏移后的布局切换及单 overlay 遮蔽聊天。typecheck 零错误，全量 77 项自测通过（基础 7、Git 8、TUI 33、扩展 12、可靠性 17），本机 pi 1.3.0 的内存终端副本通过 33 项 TUI 自测。后端、偏好存储及 patch/tree 渲染器文件指纹与本轮开始相同，未新增依赖或后台服务。测试均使用临时 HOME，未调用模型或修改宿主设置；新增物理 hover／双击／收起恢复尚待用户试用，未提交或发布。


### 2026-10-20：Git 默认未暂存与左侧文件类型标记

用户要求 Git 环境直接打开未暂存，非 Git 保持最近一轮；A/M/D 置于名称左侧或紧接右侧，裁切时仍可见且不随分隔线移动。阅读入口 loadScope/cycleScope、文件树渲染及上游 diff-viewer 的初始模式和右端状态列，按 D44–D45 修改：入口复用已有 gitAvailable 判断选择初始 scope；文件树将 badge 前置到选择箭头后，整行 fit 只裁切名称及其后内容。生产代码仅两处单行替换，追踪、Git 封装、快照、持久化、布局偏好和分隔线控制器均未改。上游 --check 仍因代理 127.0.0.1:7897 无法连接失败，既定基线未变。

新增两项回归先在原实现失败：真实 Git 仓库覆盖无提交／无历史、暂存区与工作副本不同、未跟踪文件、有历史仍选未暂存、全部暂存后空页不回退，读取前后索引字节相同；TUI 覆盖中英／深浅主题、长中文文件名、嵌套和根文件、树宽 40→80→30 及 40 列窄屏，三类标记始终固定在第 3 显示列。既有默认入口、五范围双向循环、乱序响应、退出后错误、语言加载与失败页等集成回归调整为从未暂存起步；非 Git 入口仍覆盖最新轮次。保留整行 selectedBg 和 A/D 固定合并回归。

隔离 HOME 下 typecheck 零错误，完整 79 项自测通过（基础 7、Git 8、TUI 34、扩展 13、可靠性 17）；本机 pi 1.3.0 的内存终端副本通过 34 项 TUI 自测，git diff --check 通过。未做本轮物理终端视觉验收；无新增依赖、后台进程、模型调用或宿主设置改动，未提交或发布。


### 2026-10-20：收紧右侧拖动并增加向左缩窄空间

用户选择最大占窗口三分之一、最小 20 列，并强调向左应能继续缩窄而非直接关闭。按 D46 只调整展开态的边界参数，默认 30–40 列仍保持；最左边缘收起与恢复机制不变。将默认计算中的 30 列与可拖动下限 20 列分开，避免较小窗口的初始树宽也跟着变窄。未改追踪、Git 范围、文件标记或分隔线事件控制逻辑。

调整既有边界与复位测试：旧实现先在新的三分之一上限断言失败；中英／深浅主题、90/120/160/240 列验证左右边界、初始尺寸不变、焦点／选中／阅读锚点及偏好不变。逐步拖动 30→25→20 列保持展开，只有 x=0 才收起；实际 pi SGR 路由验证对应坐标序列、20 列恢复、跨窗口限宽与旧 capture bounds、范围切换取消。双击仍复位到自动默认值，固定左列 A/M/D 在 20 列树中仍可见。

隔离 HOME 下 typecheck 和完整 79 项自测通过；本机 pi 1.3.0 内存终端 34 项 TUI 自测通过。后端、入口、文件树标记、偏好与 patch 渲染器文件指纹未变，git diff --check 通过。参考副本仍沿用既定基线；此前上游检查的代理不可连接问题未改变，本次未同步源码。无新增依赖、后台服务或宿主改动，未做本轮物理终端手势复验，未提交或发布。


### 2026-10-20：进一步调整为 10 列／窗口四分之一

用户明确选择最小 10 列、最大窗口四分之一，并知悉较窄窗口的默认宽度同样受新上限约束。按 D47 仅修改两个参数，仍是到最左列才完全收起，复位仍按原默认规则计算并限宽。更新已有回归中的几何预期，覆盖 20→15→10 列渐进缩窄、10 列下 A/M/D 保持固定可见、窗口 90/120/160/240 列下的默认值／上限／跨范围／缩放恢复、双击复位及真实 pi SGR 事件路由。

隔离 HOME 下 typecheck 与完整 79 项自测通过；本机 pi 1.3.0 的 34 项内存终端 TUI 自测通过。后端、入口、文件树、偏好及 patch 渲染器指纹未变，git diff --check 通过；无新增依赖或后台服务，未做本轮物理终端复验，未提交或发布。


### 2026-10-20：修复键盘展开后被旧拖动重新收起

通读 DiffScreen 和本机 pi 1.3.0 的 TuiAltScreen 鼠标捕获流程：宿主直到 release 才清除捕获，键盘事件照常送入当前组件；插件按 [ 只清除 treeCollapsed，仍让旧 dividerGesture=dragging 生效。新增真实 SGR 回归在原实现复现“先展开、迟到 drag 后再次关闭”；同一路径的迟到 release 也会在 moved=true 时按最终 x=0 重新收起。

按 D48 在共用 [ 展开入口将旧拖动标为 released，并清空边界双击计时；顶部恢复按钮仍复用该入口。不强行关闭边缘收起，不改当前 10 列／四分之一限宽，也不修改宿主捕获协议。迟到事件被消费但不能改变宽度或收起状态；新的 press 可正常启动下一次拖动。

新增一项双语回归，覆盖未 release 的边缘收起→键盘展开→迟到 drag/release、文件及焦点不变、释放后的新拖动和单 overlay 不露聊天。typecheck 零错误，完整 80 项自测通过（基础 7、Git 8、TUI 35、扩展 13、可靠性 17），本机 pi 1.3.0 内存终端 35 项 TUI 自测通过。后端、入口、文件树、偏好及 patch 渲染器指纹未变，git diff --check 通过。开工上游 --check 仍因代理 127.0.0.1:7897 不可连接失败，基线未变；未做物理终端复验，无新增依赖或后台服务，未提交或发布。
