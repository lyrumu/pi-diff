# pi-diff

[![English](https://img.shields.io/badge/README-English-lightgrey)](README.md) [![简体中文](https://img.shields.io/badge/README-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-blue)](README.zh-CN.md)

在 [pi](https://github.com/earendil-works/pi) 中用 `/diff` 全屏查看每轮、会话累计和 Git 改动。左侧选文件，右侧看差异，支持鼠标、自动换行和合并／拆分视图。

## 功能特性

- **按需查看改动**：查看最近一次任务、整个会话或 Git 改动，同时了解文件数和增删行数。
- **随时接着看**：已记录的任务改动随会话保存，重载 pi、恢复会话或切换会话分支后仍可查看。
- **中英双语**：按 `l`／`L` 切换英语与简体中文，记住你的语言选择。
- **只读审阅**：查看差异不会暂存、提交或回退文件；没有 Git 仓库也能看任务与会话改动。

### 合并与拆分视图

在同一列中阅读改动，或左右对照修改前后的内容。按 `v`／`V` 或点击顶部按钮切换。长行自动换行，配色跟随 pi 主题；新增／删除文件和较窄的窗口使用合并视图。

<table>
  <tr>
    <th align="center">合并视图</th>
    <th align="center">拆分视图</th>
  </tr>
  <tr>
    <td align="center"><a href="https://github.com/lyrumu/pi-diff/blob/main/docs/images/diff-unified.png"><img src="https://raw.githubusercontent.com/lyrumu/pi-diff/main/docs/images/diff-unified.png" width="360" alt="合并视图：改动文件树与高亮显示的增删内容"></a></td>
    <td align="center"><a href="https://github.com/lyrumu/pi-diff/blob/main/docs/images/diff-split.png"><img src="https://raw.githubusercontent.com/lyrumu/pi-diff/main/docs/images/diff-split.png" width="360" alt="拆分视图：左右对照修改前后的内容"></a></td>
  </tr>
</table>

点击图片可查看完整尺寸截图。

### 文件树与可拖动分隔线

<table>
  <tr>
    <td valign="top"><a href="https://github.com/lyrumu/pi-diff/blob/main/docs/images/file-tree-resize.png"><img src="https://raw.githubusercontent.com/lyrumu/pi-diff/main/docs/images/file-tree-resize.png" width="220" alt="文件树、A/M/D 状态标记与高亮的可拖动分隔线"></a></td>
    <td valign="top">
      <p>通过可折叠目录快速找到改动文件。<code>A</code>、<code>M</code>、<code>D</code> 分别表示新增、修改和删除。</p>
      <p>左右拖动分隔线，为文件树或差异内容腾出空间，双击恢复默认宽度。拖到最左边缘可收起文件树，按 <code>[</code> 或点击 <code>[展开文件树]</code> 即可恢复。</p>
    </td>
  </tr>
</table>

### 灵感来自 opencode

参照 [opencode](https://github.com/anomalyco/opencode) 的终端差异审阅体验，通过 `/diff` 在 pi 中直接查看改动。

## 安装

项目开发环境：pi **1.2.0 及以上**、Node.js ≥ 22.19.0、npm 和系统 Git。

```bash
# 安装扩展
pi install npm:@lyrumu/pi-diff
```

也可以从 GitHub 安装：

```bash
# 从 GitHub 安装
pi install git:github.com/lyrumu/pi-diff
```

安装后重启 pi，或在运行中的 pi 输入 `/reload`。

更新或卸载：

```bash
# 更新扩展
pi update npm:@lyrumu/pi-diff

# 卸载扩展
pi remove npm:@lyrumu/pi-diff
```

若从 GitHub 安装，更新和卸载时均将来源替换为 `git:github.com/lyrumu/pi-diff`。

## 使用

在项目目录启动 pi，输入 `/diff`。Git 仓库默认显示 **Unstaged（未暂存）**，其他项目默认显示 **Last turn（最近一轮）**。按 `[` 进入文件树，用 `j`／`k` 选文件，再按 `]` 阅读和滚动差异。界面首次使用英语，按 `l`／`L` 可切换为简体中文。

按 `Tab`／`Shift+Tab` 向后／向前循环：

| 范围（英文／中文） | 含义 |
|---|---|
| Last turn／最近一轮 | 最近一次任务的改动 |
| Session total／会话累计 | 当前会话分支中已记录的累计改动 |
| Unstaged／未暂存 | 尚未暂存的改动 |
| Uncommitted／未提交 | 已暂存和未暂存的改动 |
| All branch changes／分支全部改动 | 相对基准分支的全部改动，包含已提交和未提交部分 |

Git 范围也包含未跟踪文件；没有 Git 仓库时只显示前两项。

### 快捷键与鼠标

<a href="https://github.com/lyrumu/pi-diff/blob/main/docs/images/keyboard-shortcuts.zh-CN.png"><img src="https://raw.githubusercontent.com/lyrumu/pi-diff/main/docs/images/keyboard-shortcuts.zh-CN.png" width="100%" alt="中文快捷键栏：l/L 切换语言，方括号切换焦点，Tab/Shift+Tab 切换范围，v/V 切换视图，方向键或滚轮及 j/k 滚动，Esc/q 关闭"></a>

底部快捷键提示随焦点变化：文件树聚焦时，`j`／`k` 选择文件；内容区聚焦时，`j`／`k` 滚动内容。

| 操作 | 按键／鼠标 |
|---|---|
| 选择文件、折叠目录 | 鼠标点击；文件树中用 `↑↓`，`Enter`／空格展开或折叠目录 |
| 下一个／上一个文件 | 文件树聚焦时按 `j`／`k` |
| 操作文件树／差异内容 | `[`／`]`，或点击对应区域 |
| 调整／收起文件树 | 拖动分隔线；拖到最左边缘收起，双击恢复默认宽度 |
| 展开已收起的文件树 | `[` 或点击顶部 `[展开文件树]` |
| 滚动内容 | 滚轮、`↑↓`、`j`／`k`、`PageUp`／`PageDown`；`Home`／`End` 到首尾 |
| 切换合并／拆分视图 | `v`／`V`，或点击顶部“切换视图” |
| 切换英语／简体中文 | `l`／`L` |
| 退出 | `Esc`／`q` |

窗口较窄时，用 `[`／`]` 在文件树和内容页之间切换。

## 数据与限制

- 任务和会话历史仅包含扩展启用后记录的项目目录内改动；Git 范围可以查看已有改动。
- 没有 Git 时，shell 改动可能提示“修改前内容未知”；无法完整恢复会话累计时，界面会明确提示。
- 二进制文件和超过 10 MB 的差异仅显示提示，不展示内容。

## 许可

[MIT](LICENSE)。部分实现移植自 [opencode](https://github.com/anomalyco/opencode)，来源与版权说明见 [NOTICE.md](NOTICE.md) 和 [第三方许可](THIRD_PARTY_LICENSES.md)。
