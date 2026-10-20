# pi-diff — 项目规范与架构

pi 扩展：注册 `/diff` 命令，在全屏 TUI 中查看 **每轮改动 / 会话累计改动 / git 范畴改动（未暂存、未提交、分支全部）**。
左侧为改动文件树，顶部显示改动文件数统计，右侧为选中文件的 diff，`Tab`/`Shift+Tab` 切换改动范围，`v`/`V` 切换合并/拆分布局；默认自动换行，保留源行号并对齐拆分两侧；支持鼠标选择与滚动。

Git 仓库 `/diff` 默认打开 Unstaged（未暂存），即使为空也不回退；非 Git 项目保持 Last turn（最近一轮）。Tab/Shift+Tab 循环顺序不变。文件树 A/M/D 标记固定在选择箭头后的左侧一列，先保留标记再裁切名称，不随分隔线移动；颜色、整行选中背景与目录语义保持不变。

新增/删除文件固定使用合并视图：从首次显示即说明原因，顶部显示“仅合并视图”，不提供布局切换；v/V 和点击均不改变其布局、说明或已保存偏好。修改文件仍可切换布局。

双栏布局的文件树／diff 分隔线可左右拖动：展开时文件树最少 10 列、最多占终端四分之一，右侧内容至少 40 列；自动默认仍按 30–40 列计算，但必须受窗口四分之一上限约束。拖到窗口最左边缘可完全收起，焦点切到内容；同次拖动可向右拖回展开，用 `[` 或顶部 `[Show files]`／`[展开文件树]` 恢复此前宽度，双击分隔线（300ms 内）恢复自动默认宽度。宽度与收起状态仅在当前 `/diff` 中跨范围保留，关闭后恢复默认，不落盘。普通调整不改变选中文件、焦点、滚动锚点及已保存的合并／拆分偏好；宽度不足仍自动合并。窄屏切页或加载新范围取消当前拖动，缩放时按实时终端尺寸限制宽度；鼠标捕获期间旧事件 bounds 不可作为缩放后的尺寸依据。仅分隔线正文两列命中区接受左键拖动，松开按最终位置结算，其合成 click 不触发文件选择。显式按 `[` 展开时取消旧拖动并清除双击计时，迟到的 drag/release/click 不得重新收起；新的 press 才能开始下一次拖动。

指针悬停在分隔线两列命中区时，分隔线单列背景以 pi selectedBg 高亮，底栏优先显示“↔ 拖动调整宽度”／“↔ Drag to resize”，不限定鼠标按键或触控板手势；展开拖动中保持提示。复用同一命中判断，进入／离开才请求 hover 重绘，不改变焦点或文件选择。缩放后按当前分隔线位置重新判断，窄屏／空文件／收起时不显示无效提示，切范围清除旧悬停状态。

界面首次默认英语，不跟随系统语言；`l`／`L` 即时切换英语／简体中文；`[` 聚焦文件树、`]` 聚焦差异内容，窄屏时切换对应页面；`j/k` 按焦点操作：文件树中为下一个/上一个文件，内容区为向下/向上滚动，不能在内容区换文件；方向键仍按焦点导航或滚动；底部靠前显示“焦点：文件树／内容”（英语为 Focus: Files/Diff），不只依赖颜色表示焦点。关闭时将语言偏好原子保存到 `~/.pi/agent/data/pi-diff/language.json`，跨项目／会话生效；缺失或损坏时回退英语。切换只刷新文案，保留范围、选中文件、目录、焦点、滚动与布局，不重新查 Git。命令菜单简介固定英文，原始路径／源码／diff／底层错误不翻译。

功能设计移植自 **opencode**（github.com/anomalyco/opencode，MIT，见 `NOTICE.md`），渲染层用 pi 的 `@earendil-works/pi-tui` 重写。

**移植原则（用户已确认）**：默认逐行照搬 opencode 源码；仅 pi 生态不兼容处替换、明显更优才自写，一切偏离须在 `PLAN.md` 偏离登记表留痕。对齐优先级：**功能语义 > 界面 > 快捷键**。

**源码基线（只读）**：`reference/opencode/`（sparse clone，仅 core/src + tui/src + LICENSE），commit `ba06ff9e0bf2dcefbbbc3a1d6094f3572d77c84e`，基线 hash 见 `reference/opencode.pin`，已 `.gitignore` 排除。执行计划见 `PLAN.md`（阶段任务与验收），新对话按其推进。

**上游同步**：每阶段开工前与定期跑 `./scripts/sync-opencode.sh`（或 `--check` 只查）；拉取后按 `PLAN.md`「上游同步」节的四步更新行为规格/偏离登记/基线 hash，勿让基线静默漂移。

## 参考源码映射（opencode → 本项目）

| opencode 源文件 | 作用 | 本项目对应 |
|---|---|---|
| `packages/core/src/session/diff.ts` | 每轮 diff = 消息元数据中两个 snapshot ID 的对比 | `src/tracker.ts`（turn 级 patch 计算） |
| `packages/core/src/snapshot.ts` | 快照服务：capture 记录工作副本，diff 输出 per-file patch | `src/snapshot.ts`（内容寻址缓存） |
| `packages/core/src/vcs/patch.ts` | patch 原语：全文件上下文（`PATCH_CONTEXT_LINES = 2^31-1`）、10MB 上限、countPatch/splitGitPatch 等 | `src/diff-engine.ts` |
| `packages/core/src/vcs.ts` + `plugin/vcs/git.ts` | Vcs 服务 + git provider（branch/committed/working，总量保护） | `src/git.ts` |
| `packages/tui/src/feature-plugins/system/diff-viewer*.tsx` | diff 全屏视图：mode/布局常量/文件树/选中态 | `src/tui/`（pi-tui 重写，不可直接搬） |
| `packages/tui/src/component/patch-diff.tsx` | patch 渲染：unified/split、虚拟滚动（3000/128） | `src/tui/patch-diff.ts` |
| `packages/tui/src/ui/pane-resize.ts` + `pane-resize-handle.tsx` | 两列拖动命中、hover 背景、双击复位、释放结算 | `src/tui/diff-screen.ts`（pi 鼠标 capture 适配；完全收起为本项目扩展） |

阅读 opencode 源码用本地只读副本 `reference/opencode/`（已按基线 commit 钉死），不要改动、不要重新 clone、不要整库拉取。

## pi API 挂钩点

- `pi.registerCommand("diff", { handler })` — 命令入口；`ctx.mode === "tui"` 且有 UI 才可用，否则 notify 报错
- `pi.on("before_agent_start")` — 轮次开始：`tracker.onTurnStart()`（轮次号 +1、基线扫描）
- `pi.on("tool_call")` / `pi.on("tool_result")` — 捕获 edit/write 的目标文件；bash 前后边界
- `pi.on("agent_settled")` — `tracker.finalizeTurn()`：计算 patch 并持久化（用户已确认：pi 的 `turn_end` 每 LLM 迭代发一次，改挂 `agent_settled` 以保持 opencode 轮次语义）
- `pi.on("session_start")` — 从 custom entries 重建状态 + 缓存清理
- `pi.appendEntry("pi-diff.turn", data)` — 每轮 diff 持久化（**自包含**，不依赖磁盘缓存）；不能把对象作为第一个参数
- `ctx.sessionManager.getBranch()` — 分支感知重放（`/tree` 切换分支后 diff 天然正确）
- `ctx.ui.custom()` — Git 默认打开 Unstaged，非 Git 打开 Last turn；Tab/Shift+Tab 在五范围间循环，无选择器；全程只挂载一个铺满终端的 overlay，切范围在原组件内加载和更新，done 仅用于退出，避免聊天闪露

pi 文档（只读）：
`~/.pi/agent/install/releases/1.2.0/node_modules/@earendil-works/pi-coding-agent/docs/`
关键文件：`extensions.md`、`tui.md`、`session-format.md`、`slash-commands.md`。

## 核心设计决策（已与用户确认，勿改动）

1. **单一改动登记入口**：一切进入某轮 diff 的文件必须经过 `Tracker.recordFileChange()`（edit/write 工具、bash 扫描、轮次基线扫描，三个来源同一管道）。快照索引只有一个写入点，杜绝“bash 改了但没进索引”。
2. **共享扫描函数**：`Tracker.scanWorkspace(marker)` 只有一个实现；轮次开始扫描与 bash 前后扫描只是传入不同 marker（git 后端：HEAD + porcelain + 内容签名；无 git 后端：临时 marker 保存路径及 mtime/ctime 纳秒值、大小、设备/inode 签名，保留时间戳的改写也能被发现）。前后路径取并集捕获删除/恢复干净，HEAD 变化补查已提交路径。**禁止**写第二套扫描逻辑。
3. **bash 兜底**：bash 工具执行前后各扫一次；发现的新变更文件补登记；git 场景旧侧按 D9 固定轮次起始 HEAD，预脏文件用轮次基线；忽略文件等缺失于 HEAD/基线的明确 edit/write 目标在工具执行前捕获内容（D38）。无 git 场景 shell 旧侧不可得 → `baselineUnknown`，UI 提示 `Previous contents unknown`／“修改前内容未知”。
4. **持久化自包含**：每轮均以 custom entry（`customType: "pi-diff.turn"`）写入会话 JSONL，无改动轮次保存空 patches（用户已确认），确保编号与 Last turn 准确。磁盘快照（`~/.pi/agent/data/pi-diff/`，内容寻址 sha256）只是增量计算缓存。**随时可看**：reload/resume/分支切换后从 entries 重建；累计缓存缺失时明确标记仅显示最后一轮。
5. **能力边界**：无 git 项目只显示 Last turn、Session total；有 git 则增加 Unstaged、Uncommitted、All branch changes。历史轮次仍持久化，当前 UI 不设轮次列表，也不展示独立 Committed 范围。
6. **降级**：对齐 opencode——`MAX_PATCH_BYTES = MAX_TOTAL_PATCH_BYTES = 10_000_000`，超限文件 patch 置空（emptyPatch）；二进制文件显示 `binary file changed`；读取/捕获失败显示内容不可用，不能当作不存在或删除。
7. **配色**：diff 行文字用 pi 主题语义 token（success/error/muted），增删行背景复用 toolSuccessBg/toolErrorBg，覆盖行号、内容及行尾空白；跟随主题。拆分侧的补齐空白不冒充增删行；字符级高亮留 v2。
8. **缓存清理**：session_start 时清理 30 天未访问的快照目录（atime LRU）。
9. Git 集成一律 spawn 系统 `git` CLI，**只读操作**，禁止任何写操作（add/commit/stash 等）。

## 目录结构

```
index.ts            扩展入口：注册命令、接线事件
scripts/
  sync-opencode.sh  同步上游 opencode 参考源码（见 PLAN.md「上游同步」）
src/
  tracker.ts        改动追踪核心（recordFileChange / scanWorkspace / finalizeTurn）
  snapshot.ts       内容寻址快照缓存 + 清理（移植 core/src/snapshot.ts）
  diff-engine.ts    patch 原语（移植 core/src/vcs/patch.ts，全文件上下文）
  git.ts            git CLI 只读封装
  store.ts          custom entry 持久化与重建
  preferences.ts    布局与语言偏好（数据目录 view.json / language.json）
  language.ts       英语／简体中文文案与显示层文本解析
  tui/
    scopes.ts           五范围定义与 Tab 循环
    diff-screen.ts      主界面（文件树 + unified/split diff）
```

## 代码规范

- TypeScript strict；`npm run typecheck` 必须零错误后才算完成
- 标识符与注释用英文；文档/AGENTS.md 用中文
- 遵循“第一性原理”：先读懂 pi API 真实类型（看 `dist/` 下 `.d.ts`），不猜测签名
- 不污染系统环境：数据只写 `~/.pi/agent/data/pi-diff/`；测试进程用完即关
- 终端命令涉及国外网络（如 npm 安装）用 `/bin/zsh -ic 'proxyon && <cmd>'`

## 验收标准

- [x] `/diff` 全屏 TUI：左侧文件树（目录折叠、A/M/D 标记），顶部文件数统计，右侧 diff
- [x] Tab/Shift+Tab 切范围不露聊天，v/V 切换合并/拆分或提示原因；[/] 键盘切文件/内容，j/k 按焦点切文件或滚动内容；鼠标操作自动选区域；Esc/q 退出；默认自动换行，续行不重复源行号，拆分两侧补齐对齐，移除横移及按钮
- [x] 双栏分隔线两列命中、hover 背景、双击复位、左右限宽、左边缘完全收起与按钮／键盘恢复；拖动／缩放／释放／切范围与窄屏取消正确；仅本次视图保留宽度和收起状态，重开恢复默认
- [x] 每轮 patch 与 `git diff` 语义一致（有 git 时抽样比对）；无 git 场景 edit/write 结果准确
- [x] bash 改动的文件一定出现在该轮 diff 中（统一入口不变量）
- [x] 重启 pi / `/resume` / `/tree` 切换分支后 `/diff` 历史完整
- [x] 无 git 项目不报错、只隐藏 git 范围
- [x] 大文件/二进制降级不崩溃

验收证据：typecheck 与 80 项自测通过（含双语交互、快捷键、overlay 焦点反馈、偏好回归、2026-10-20 的计数／忽略目标旧侧／保留 mtime 改写及分隔线拖动／hover／双击复位／收起恢复、Git 默认范围、左侧状态标记及 10 列／四分之一限宽及展开后迟到鼠标事件回归）；此前独立字节核验 107 次比较通过。本机 pi 1.3.0 宿主运行 35 项 TUI 自测通过；此前 pi 1.3.0 隔离类型检查通过，历史真实 pi 1.2.0 离线 PTY 会话生命周期证据见 PLAN.md。用户确认 reload 后实际可拖动，物理终端 hover／双击／收起恢复尚未由用户验收，真实模型子代理仍未验收；无 git 的 bash 旧侧仍为 baselineUnknown；累计缓存缺失只保证每轮历史完整。2026-10-15 用户确认默认换行，取消横移，窄于单个字符/行号所需宽度时仍会裁切，拉宽后恢复。

实测反馈：旧嵌套/损坏 entry 提示历史不可用，不等同于有效空轮次；复杂功能先记录在 `docs/deferred-features.md`，未经新任务不要实施旧历史迁移或项目外追踪。
