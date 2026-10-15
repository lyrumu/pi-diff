# pi-diff

在 [pi](https://github.com/earendil-works/pi) 中用 `/diff` 全屏查看每轮、会话累计和 Git 改动。左侧选文件，右侧看差异，支持鼠标、自动换行和合并／拆分视图。

## 安装

需要已安装 pi，以及 Node.js ≥ 22.19.0、npm。当前验证版本为 pi **1.2.0**；Git 范围还需要系统 Git。

```bash
# 获取源码并进入目录；已有本地源码时跳过这两行
git clone https://github.com/lyrumu/pi-diff.git
cd pi-diff

# 安装项目依赖
npm install

# 将本地扩展入口注册到 pi
pi install "$PWD/index.ts"
```

安装后重启 pi，或在运行中的 pi 输入 `/reload`。扩展直接读取此目录，请保留它；已通过软链接等方式加载的用户无需重复安装。

也可以仅在一次启动中试用，在本仓库目录运行：

```bash
# 仅本次启动加载，不写入 pi 安装设置
pi --extension ./index.ts
```

## 使用

在要工作的项目目录启动 pi，让它完成一次修改，然后输入 `/diff`。默认直接显示 **Last turn**，没有选择器。

按 `Tab`／`Shift+Tab` 向后／向前循环：

| 范围 | 含义 |
|---|---|
| Last turn | 最近一轮任务的改动；该轮没有改动时显示为空 |
| Session total | 当前会话分支中已记录的累计改动 |
| Unstaged | 暂存区 → 当前文件，即未暂存的改动 |
| Uncommitted | HEAD → 当前文件，包含已暂存和未暂存的改动 |
| All branch changes | 与默认基准分支共同祖先相比的全部改动，含已提交及未提交部分 |

Git 范围也包含未跟踪文件；无 Git 仓库时只显示前两项。插件仅查询 Git，不执行暂存、提交或回退。

| 操作 | 按键／鼠标 |
|---|---|
| 选择文件、折叠目录 | 鼠标点击；文件树中用 `↑↓`，`Enter`／空格展开或折叠目录 |
| 上一个／下一个文件 | `p`／`n` |
| 操作文件树／差异内容 | `h`／`l`；鼠标操作自动选择区域 |
| 滚动内容 | 滚轮、`↑↓`、`PageUp`／`PageDown`；内容区用 `Home`／`End` 到首尾 |
| 切换合并／拆分视图 | `v`／`V`，或点击顶部“切换视图” |
| 退出 | `Esc`／`q` |

文件树中的 `M` 表示修改、`A` 表示新增、`D` 表示删除。新增／删除文件固定为合并视图，不能切换；右侧不足 100 列时也使用合并视图。窗口较窄时用 `h`／`l` 在文件树和内容页之间切换。

长行自动换行，源行号只显示一次，续行标记为 `↳`；拆分两侧保持对齐。增删行带主题红绿背景，布局偏好会保存。

仅记录插件启用后的轮次，不自动恢复旧的缺失历史；目前不追踪项目目录外文件。无 Git 时，shell 改动可能缺少修改前内容；二进制、超限差异和累计缓存缺失会显示降级提示。

当前进展与验证边界见 [STATUS.md](STATUS.md)。历史计划保留在 [PLAN.md](PLAN.md)，暂缓功能见 [docs/deferred-features.md](docs/deferred-features.md)。功能设计参考 opencode，来源见 [NOTICE.md](NOTICE.md)。
