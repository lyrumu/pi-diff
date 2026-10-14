# pi-diff — 项目规范与架构

pi 扩展：注册 `/diff` 命令，在全屏 TUI 中查看 **每轮改动 / 会话累计改动 / git 范畴改动（未暂存、未提交、分支）**。
左侧为改动文件树，顶部显示改动文件数统计，右侧为选中文件的 diff，`Tab` 切换 unified ↔ split 布局。

功能设计移植自 **opencode**（github.com/anomalyco/opencode），渲染层用 pi 的 `@earendil-works/pi-tui` 重写。

## 参考源码映射（opencode → 本项目）

| opencode 源文件 | 作用 | 本项目对应 |
|---|---|---|
| `packages/core/src/session/diff.ts` | 每轮 diff = 消息元数据中两个 snapshot ID 的对比 | `src/tracker.ts`（turn 级 patch 计算） |
| `packages/core/src/session/snapshot.ts` | 工作副本快照服务，磁盘存储 | `src/snapshot.ts`（内容寻址缓存） |
| `packages/core/src/vcs/patch.ts` | patch 计算，`PATCH_CONTEXT_LINES = 3` | `src/diff-engine.ts` |
| `packages/core/src/vcs/`（git 集成） | 未暂存/未提交/分支 diff | `src/git.ts` |
| `packages/tui/src/`（diff 视图组件） | 文件树 + unified/split diff 渲染 | `src/tui/`（pi-tui 重写，不可直接搬） |

阅读 opencode 源码用只读方式（GitHub API / raw），不要整库 clone（>500MB）。

## pi API 挂钩点

- `pi.registerCommand("diff", { handler })` — 命令入口；`ctx.mode === "tui"` 且有 UI 才可用，否则 notify 报错
- `pi.on("before_agent_start")` — 轮次开始：`tracker.onTurnStart()`（轮次号 +1、基线扫描）
- `pi.on("tool_call")` / `pi.on("tool_result")` — 捕获 edit/write 的目标文件；bash 前后边界
- `pi.on("turn_end")` — `tracker.finalizeTurn()`：计算 patch 并持久化
- `pi.on("session_start")` — 从 custom entries 重建状态 + 缓存清理
- `pi.appendEntry({ customType: "pi-diff.turn", data })` — 每轮 diff 持久化（**自包含**，不依赖磁盘缓存）
- `ctx.sessionManager.getBranch()` — 分支感知重放（`/tree` 切换分支后 diff 天然正确）
- `ctx.ui.custom()` — 全屏 TUI（ScopeSelector → DiffScreen）；overlay 不用

pi 文档（只读）：
`~/.pi/agent/install/releases/1.2.0/node_modules/@earendil-works/pi-coding-agent/docs/`
关键文件：`extensions.md`、`tui.md`、`session-format.md`、`slash-commands.md`。

## 核心设计决策（已与用户确认，勿改动）

1. **单一改动登记入口**：一切进入某轮 diff 的文件必须经过 `Tracker.recordFileChange()`（edit/write 工具、bash 扫描、轮次基线扫描，三个来源同一管道）。快照索引只有一个写入点，杜绝“bash 改了但没进索引”。
2. **共享扫描函数**：`Tracker.scanWorkspace(marker)` 只有一个实现；轮次开始扫描与 bash 前后扫描只是传入不同 marker（git 后端：基线 porcelain 状态串；无 git 后端：mtime marker 临时文件）。**禁止**写第二套扫描逻辑。
3. **bash 兜底**：bash 工具执行前后各扫一次；发现的新变更文件补登记；文件已被改时 git 场景用 `git show :path` / `HEAD:path` 恢复旧侧，无 git 场景旧侧不可得 → `baselineUnknown`，UI 显示 `new (baseline unknown)`。
4. **持久化自包含**：每轮 patch 以 custom entry（`customType: "pi-diff.turn"`）写入会话 JSONL；磁盘快照（`~/.pi/agent/data/pi-diff/`，内容寻址 sha256）只是增量计算缓存。**随时可看**：reload/resume/分支切换后从 entries 重建。
5. **能力边界**：无 git 项目只支持「会话累计」「按轮次」两个范围，git 范畴在选择器中直接隐藏；有 git 则全部支持。
6. **降级**：二进制文件显示 `binary file changed`；>1MB 文件或单文件 >5000 行改动的 patch 截断提示。
7. **配色**：diff 行染色用 pi 主题语义 token（success/error/muted），跟随主题；行内字符级高亮留 v2。
8. **缓存清理**：session_start 时清理 30 天未访问的快照目录（atime LRU）。
9. Git 集成一律 spawn 系统 `git` CLI，**只读操作**，禁止任何写操作（add/commit/stash 等）。

## 目录结构

```
index.ts            扩展入口：注册命令、接线事件
src/
  tracker.ts        改动追踪核心（recordFileChange / scanWorkspace / finalizeTurn）
  snapshot.ts       内容寻址快照缓存 + 清理
  diff-engine.ts    patch 计算（diff 包，PATCH_CONTEXT_LINES=3，降级规则）
  git.ts            git CLI 只读封装
  store.ts          custom entry 持久化与重建
  tui/
    scope-selector.ts   范围选择器（首屏）
    diff-screen.ts      主界面（文件树 + unified/split diff）
```

## 代码规范

- TypeScript strict；`npm run typecheck` 必须零错误后才算完成
- 标识符与注释用英文；文档/AGENTS.md 用中文
- 遵循“第一性原理”：先读懂 pi API 真实类型（看 `dist/` 下 `.d.ts`），不猜测签名
- 不污染系统环境：数据只写 `~/.pi/agent/data/pi-diff/`；测试进程用完即关
- 终端命令涉及国外网络（如 npm 安装）用 `/bin/zsh -ic 'proxyon && <cmd>'`

## 验收标准

- [ ] `/diff` 全屏 TUI：左侧文件树（目录折叠、A/M/D 标记），顶部文件数统计，右侧 diff
- [ ] Tab 切换 unified/split；h/l 切焦点；Esc/q 退出
- [ ] 每轮 patch 与 `git diff` 语义一致（有 git 时抽样比对）；无 git 场景 edit/write 结果准确
- [ ] bash 改动的文件一定出现在该轮 diff 中（统一入口不变量）
- [ ] 重启 pi / `/resume` / `/tree` 切换分支后 `/diff` 历史完整
- [ ] 无 git 项目不报错、只隐藏 git 范围
- [ ] 大文件/二进制降级不崩溃
