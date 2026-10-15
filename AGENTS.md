# pi-diff — 项目规范与架构

pi 扩展：注册 `/diff` 命令，在全屏 TUI 中查看 **每轮改动 / 会话累计改动 / git 范畴改动（未暂存、未提交、分支全部）**。
左侧为改动文件树，顶部显示改动文件数统计，右侧为选中文件的 diff，`Tab`/`Shift+Tab` 切换改动范围，`v`/`V` 切换合并/拆分布局；默认自动换行，保留源行号并对齐拆分两侧；支持鼠标选择与滚动。

新增/删除文件固定使用合并视图：从首次显示即说明原因，顶部显示“仅合并视图”，不提供布局切换；v/V 和点击均不改变其布局、说明或已保存偏好。修改文件仍可切换布局。

功能设计移植自 **opencode**（github.com/anomalyco/opencode，MIT，见 `NOTICE.md`），渲染层用 pi 的 `@earendil-works/pi-tui` 重写。

**移植原则（用户已确认）**：默认逐行照搬 opencode 源码；仅 pi 生态不兼容处替换、明显更优才自写，一切偏离须在 `PLAN.md` 偏离登记表留痕。对齐优先级：**功能语义 > 界面 > 快捷键**。

**源码基线（只读）**：`reference/opencode/`（sparse clone，仅 core/src + tui/src + LICENSE），commit `5fa0a4238647dc25df137cb3df7e0d7eb8454d67`，基线 hash 见 `reference/opencode.pin`，已 `.gitignore` 排除。执行计划见 `PLAN.md`（阶段任务与验收），新对话按其推进。

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

阅读 opencode 源码用本地只读副本 `reference/opencode/`（已按基线 commit 钉死），不要改动、不要重新 clone、不要整库拉取。

## pi API 挂钩点

- `pi.registerCommand("diff", { handler })` — 命令入口；`ctx.mode === "tui"` 且有 UI 才可用，否则 notify 报错
- `pi.on("before_agent_start")` — 轮次开始：`tracker.onTurnStart()`（轮次号 +1、基线扫描）
- `pi.on("tool_call")` / `pi.on("tool_result")` — 捕获 edit/write 的目标文件；bash 前后边界
- `pi.on("agent_settled")` — `tracker.finalizeTurn()`：计算 patch 并持久化（用户已确认：pi 的 `turn_end` 每 LLM 迭代发一次，改挂 `agent_settled` 以保持 opencode 轮次语义）
- `pi.on("session_start")` — 从 custom entries 重建状态 + 缓存清理
- `pi.appendEntry("pi-diff.turn", data)` — 每轮 diff 持久化（**自包含**，不依赖磁盘缓存）；不能把对象作为第一个参数
- `ctx.sessionManager.getBranch()` — 分支感知重放（`/tree` 切换分支后 diff 天然正确）
- `ctx.ui.custom()` — 默认直接打开 Last turn；Tab/Shift+Tab 在五范围间循环，无选择器；全程只挂载一个铺满终端的 overlay，切范围在原组件内加载和更新，done 仅用于退出，避免聊天闪露

pi 文档（只读）：
`~/.pi/agent/install/releases/1.2.0/node_modules/@earendil-works/pi-coding-agent/docs/`
关键文件：`extensions.md`、`tui.md`、`session-format.md`、`slash-commands.md`。

## 核心设计决策（已与用户确认，勿改动）

1. **单一改动登记入口**：一切进入某轮 diff 的文件必须经过 `Tracker.recordFileChange()`（edit/write 工具、bash 扫描、轮次基线扫描，三个来源同一管道）。快照索引只有一个写入点，杜绝“bash 改了但没进索引”。
2. **共享扫描函数**：`Tracker.scanWorkspace(marker)` 只有一个实现；轮次开始扫描与 bash 前后扫描只是传入不同 marker（git 后端：HEAD + porcelain + 内容签名；无 git 后端：mtime marker 临时文件及路径清单）。前后路径取并集捕获删除/恢复干净，HEAD 变化补查已提交路径。**禁止**写第二套扫描逻辑。
3. **bash 兜底**：bash 工具执行前后各扫一次；发现的新变更文件补登记；文件已被改时 git 场景用 `git show :path` / `HEAD:path` 恢复旧侧，无 git 场景旧侧不可得 → `baselineUnknown`，UI 显示 `new (baseline unknown)`。
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
  preferences.ts    unified/split 布局偏好（数据目录 view.json）
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
- [x] Tab/Shift+Tab 切范围不露聊天，v/V 切换合并/拆分或提示原因；h/l 键盘切文件/内容；鼠标操作自动选区域；Esc/q 退出；默认自动换行，续行不重复源行号，拆分两侧补齐对齐，移除横移及按钮
- [x] 每轮 patch 与 `git diff` 语义一致（有 git 时抽样比对）；无 git 场景 edit/write 结果准确
- [x] bash 改动的文件一定出现在该轮 diff 中（统一入口不变量）
- [x] 重启 pi / `/resume` / `/tree` 切换分支后 `/diff` 历史完整
- [x] 无 git 项目不报错、只隐藏 git 范围
- [x] 大文件/二进制降级不崩溃

验收证据：typecheck 与 50 项自测通过，历史真实 pi 1.2.0 离线 PTY 会话生命周期证据见 PLAN.md。尚未验收真实模型子代理和物理终端视觉；无 git 的 bash 旧侧仍为 baselineUnknown；累计缓存缺失只保证每轮历史完整。2026-10-15 用户确认默认换行，取消横移，窄于单个字符/行号所需宽度时仍会裁切，拉宽后恢复。

实测反馈：旧嵌套/损坏 entry 提示历史不可用，不等同于有效空轮次；复杂功能先记录在 `docs/deferred-features.md`，未经新任务不要实施旧历史迁移或项目外追踪。
