# pi-diff

[![English](https://img.shields.io/badge/README-English-lightgrey)](README.md) [![简体中文](https://img.shields.io/badge/README-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-blue)](README.zh-CN.md)

在 [pi](https://github.com/earendil-works/pi) 中用 `/diff` 全屏查看每轮、会话累计和 Git 改动。左侧选文件，右侧看差异，支持鼠标、自动换行和合并／拆分视图。

## 安装

需要 pi **1.2.0**（已验证版本）、Node.js ≥ 22.19.0、npm 和系统 Git。

```bash
# 安装扩展
pi install git:github.com/lyrumu/pi-diff
```

安装后重启 pi，或在运行中的 pi 输入 `/reload`。

更新或卸载：

```bash
# 更新扩展
pi update git:github.com/lyrumu/pi-diff

# 卸载扩展
pi remove git:github.com/lyrumu/pi-diff
```

## 使用

在项目目录启动 pi，完成一次修改后输入 `/diff`。默认显示 **Last turn**。

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

## 数据与限制

- 仅记录扩展启用后的改动，范围限于项目目录内；不会补回旧会话中缺失的历史。
- 每轮差异随 pi 会话保存，重载、恢复会话或切换会话分支后仍可查看。内容缓存和布局偏好位于 `~/.pi/agent/data/pi-diff/`。
- 无 Git 时，shell 改动可能无法取得修改前内容，会显示 `baseline unknown`；累计缓存缺失时会提示累计不完整。
- 二进制文件和超过 10 MB 限制的差异仅显示提示；极窄窗口可能裁切内容。

## 许可

[MIT](LICENSE)。部分实现移植自 [opencode](https://github.com/anomalyco/opencode)，来源与版权说明见 [NOTICE.md](NOTICE.md) 和 [第三方许可](THIRD_PARTY_LICENSES.md)。
