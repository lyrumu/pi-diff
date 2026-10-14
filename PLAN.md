# pi-diff 项目计划书（源文件对照版）

> 状态：初始化已完成（骨架 + AGENTS.md + 本计划），功能未实现。
> 新对话按本文档执行；已确认的设计决策见 `AGENTS.md`（勿改动）。

## 移植原则（用户已确认，勿改动）

1. **默认逐行照搬 opencode 源码**：opencode 维护得更好，凡可复制即复制（MIT 许可，`NOTICE.md` 已声明）。只有 pi 生态不兼容处才替换实现，明显更优/更适合 pi 才自写；其余一对一参考。
2. **对齐优先级：功能语义 > 界面布局与视觉 > 快捷键**。
3. 每个偏离 opencode 的实现必须在本文档「偏离登记」处记录原因；无登记即视为 bug。
4. 源码基线（只读，勿改动、勿入库）：
   - 本地路径 `reference/opencode/`（sparse clone，仅 core/src 与 tui/src + LICENSE）
   - commit `3a69bae8459b1aa9b122456a55d9535b23125f33`（dev），基线 hash 另存于 `reference/opencode.pin`
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

来自基线 commit 的实测（阶段 0 已完成的通读）：

| 主题 | opencode 行为 |
|---|---|
| 会话 diff 上下文 | `vcs/patch.ts`：`PATCH_CONTEXT_LINES = 2_147_483_647`（**全文件 patch**）；`MAX_PATCH_BYTES = MAX_TOTAL_PATCH_BYTES = 10_000_000` |
| VCS diff 上下文 | TUI `diff-viewer.tsx`：`VCS_DIFF_CONTEXT_LINES = 12`；`Vcs.diff()` 内对总量超 `MAX_TOTAL_PATCH_BYTES` 的文件降级为 `emptyPatch`（0 上下文空 patch） |
| patch 原语 | `vcs/patch.ts`：`structuredPatch`/`addPatch`/`deletePatch`/`emptyPatch`/`countPatch`（±行数统计）/`splitGitPatch`/`chunksByFile`/`fileFromPatchChunk` |
| 轮次定义 | `session/diff.ts`：turn = 相邻两个用户消息之间的区间；diff = 该区间首条消息的 `$snapshot.start` 与末条消息 `$snapshot.end`（仍在跑时 live capture）两个 snapshot 的 `Snapshot.diff(from, to, context)` |
| 快照服务 | `snapshot.ts`（core 根目录）：Snapshot.Service，capture() 记录工作副本状态，diff() 输出 per-file patch；存储走 Location 数据目录 |
| VCS 模式 | `vcs.ts` + `plugin/vcs/git.ts`：provider 化（git/hg 插件），diff/status/branches 经 Effect + schema decode，总量保护 |
| TUI 布局常量 | `diff-viewer.tsx`：`MIN_SPLIT_WIDTH=100`、`FILE_TREE_MIN_WIDTH=30`、`FILE_TREE_MAX_WIDTH=40`、`FILE_HEADER_HEIGHT=2` |
| TUI 数据源 | `DIFF_SOURCES`：session diff（按 turn）+ VCS_SOURCES（branch/committed/working）；mode 切换（unified/split，`storedView` 持久化偏好） |
| 文件树 | `diff-viewer-file-tree-utils.ts`：`buildFileTree`（目录树）/`flattenFileTree`（展开集）/`toggleFileTreeDirectory`/`movePatchFileIndex` 等纯函数，可近乎直接复制 |
| diff 渲染 | `component/patch-diff.tsx`：`VIRTUAL_MIN_LINES=3000`、`VIRTUAL_CHUNK_LINES=128`（虚拟滚动）；solid-js → pi-tui 重写 |
| 状态管理 | `diff-viewer.tsx`：selectedFileIndex / expandedFileNodes / reviewedFileNames / selectedHunk 等 signal 集合 |

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
| `core/src/session/diff.ts` (138) | **[pi 替代]** | `src/tracker.ts` | turn 边界：消息 $snapshot 元数据 → pi 的 before_agent_start/turn_end 事件；SQL 查询 → custom entries 遍历 |
| `core/src/vcs.ts` (260) | **[替换底座]** | `src/git.ts` | provider 抽象（hg 支持砍掉，登记偏离：pi 只需 git）；diff/status 语义与总量保护逻辑照搬 |
| `core/src/plugin/vcs/git.ts` (752) | **[复制]**（主体） | `src/git.ts` | spawn git CLI 的参数/refspec/输出解析逐行对齐；只读不变量加严 |
| `tui/.../diff-viewer-file-tree-utils.ts` (174) | **[复制]** | `src/tui/file-tree-utils.ts` | 纯函数，直接搬 |
| `tui/.../diff-viewer.tsx` (1242) | **[替换底座]** | `src/tui/diff-screen.ts` + `scope-selector.ts` | solid-js signal → class 字段；布局常量、mode 切换、焦点管理、选中态行为照搬 |
| `tui/.../diff-viewer-file-tree.tsx` (271) | **[替换底座]** | `src/tui/file-tree.ts` | 渲染换 pi-tui；折叠/选中/标记行为照搬 |
| `tui/src/component/patch-diff.tsx` (228) | **[替换底座]** | `src/tui/patch-diff.ts` | 虚拟滚动参数照搬（3000/128）；unified/split 双渲染对齐 |
| `tui/.../diff-viewer-file-menu.tsx` (87) | **[替换底座]** | v3 可选 | 文件右键菜单（reviewed 标记等），一期可缓，登记 |
| `tui/.../diff-viewer-image.tsx` (96) | **[pi 替代]** | 一期占位 | 二进制/图片显示 `binary file changed` |

## 偏离登记

| # | 偏离 | 原因 |
|---|---|---|
| D1 | 不支持 hg provider，只支持 git | pi 场景只需 git；`plugin/vcs/hg.ts` 不移植 |
| D2 | turn 边界用 pi 事件（before_agent_start/turn_end），非消息 $snapshot 元数据 | pi 会话格式无内建 snapshot 挂点 |
| D3 | 持久化用 custom entries 而非数据库 | pi 唯一的扩展持久化通道 |
| D4 | 扫描捕获时机：opencode 全量 snapshot 捕获 → 我方轮次基线 + bash 前后扫描 + 工具事件（单入口统一） | pi 无消息生命周期快照挂点；不变量见 AGENTS.md |
| D5 | TUI 渲染层 solid-js → pi-tui | 框架不同；行为对齐优先级：功能>界面>快捷键 |
| D6 | `diff-viewer-file-menu` / `diff-viewer-image` 一期不移植 | 交互锦上添花；阶段 4 后视情况补 |
| D7 | finalize 挂 `agent_settled` 而非 `turn_end`（用户已确认） | 实测 pi `turn_end` 每 LLM 迭代发一次；`agent_settled` 每 run 一次才对齐 opencode 轮次定义 |
| D8 | git 后端 marker = porcelain + 脏文件内容哈希签名（非纯 porcelain 串） | 纯状态码无法感知脏文件内容再次变化（" M"→sed→仍 " M"，自测实证漏检）；不变量「bash 改动必入 diff」需要内容级比对 |
| D9 | 干净文件旧侧用钉定的轮次起始 HEAD（`git show <startHead>:path`），非 `:path`/实时 `HEAD:path` | AGENTS.md 原定方案会被 bash 内 `git add`/`git commit` 竞态破坏；钉定 commit 不受影响（自测覆盖） |
| D10 | 净零轮次（无任何变更）不写 entry | 避免 JSONL 噪声；turn 序号存在 entry 内，跳过不断号 |
| D11 | session 累计视图依赖快照缓存重算；缓存 miss（被清理/旧会话）时降级为该文件最后一轮 patch | 自包含性仅保证每轮 patch；首次旧侧→最新新侧的完整重算需要内容（opencode 用 git tree 快照，我方用内容寻址缓存） |
| D12 | `src/git.ts` 用 `const Git = {...}` 对象而非 `namespace`；Tracker 无参数属性 | Node 原生 TS strip 模式不支持 namespace/parameter property（自测直跑 .ts 需要） |

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

- [ ] 2.1 `src/git.ts`：移植 git provider 主体（branch/committed/working 三 mode，context=12，MAX_TOTAL_PATCH_BYTES 保护）
- [ ] 2.2 无 git 降级（静默空结果）；`git show :path`/`HEAD:path` 基线内容
- [ ] 2.3 验收：三 mode 与裸 `git diff` 一致；无 git 项目不报错

## 阶段 3：TUI

步骤 0：跑 `./scripts/sync-opencode.sh`；通读 `diff-viewer*.tsx` + `patch-diff.tsx`，列 signal/键位/布局规格表；先读 pi-tui `.d.ts`（`~/.pi/agent/install/releases/1.2.0/node_modules/@earendil-works/pi-tui/`）确认可用组件，**不猜签名**。

- [ ] 3.1 `src/tui/file-tree-utils.ts`：直接复制
- [ ] 3.2 `src/tui/scope-selector.ts`：范围选择（最近一轮/轮次列表/会话累计/git×3，无 git 隐藏）
- [ ] 3.3 `src/tui/file-tree.ts` + `diff-screen.ts` + `patch-diff.ts`：布局常量照搬；Tab unified/split；h/l 焦点；虚拟滚动 3000/128；主题 token 染色（+/−/context）；binary/tooLarge 占位
- [ ] 3.4 验收：AGENTS.md TUI 各项 + 窄终端/CJK/resize/主题切换 + 500 行滚动流畅

## 阶段 4：收尾与对抗性审查

- [ ] index.ts TUI 接线补全（当前为骨架）
- [ ] 错误路径：git CLI 失败/文件读取失败/旧版 entry 损坏 → 降级不崩
- [ ] `/tree` 分支切换后 turn 序号与 patches 正确
- [ ] 对抗性审查：codemode 子代理 spawn 写文件能否被轮次基线扫描捕获
- [ ] 全量对照偏离登记表复查；AGENTS.md 验收清单逐项打勾

---

## 执行约定

- 每阶段：步骤 0 研读 → 实现 → `npm run typecheck` 零错误 → 验收 → 在本文件勾选
- 修改 `reference/opencode/` 内容 = 违规（只读基线）
- 测试临时进程/目录用完即关/删；网络命令 `/bin/zsh -ic 'proxyon && <cmd>'`
- 新对话开场白建议：「按 PLAN.md 执行阶段 N」
