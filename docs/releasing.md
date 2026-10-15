# 发布

npm 包名为 `@lyrumu/pi-diff`，GitHub 仓库名保持 `lyrumu/pi-diff`。无命名空间的 `pi-diff` 已属于其他项目，不要使用它作为本项目的 npm 安装命令。

## 发布前

- 确认 npm 账号拥有 `lyrumu` 命名空间的发布权限。
- 核对 `package.json` 版本和 `package-lock.json`，避免重复发布已存在的版本。
- 确认 `LICENSE`、`NOTICE.md` 和 `THIRD_PARTY_LICENSES.md` 都在包内。保留 opencode 的版权及 MIT 全文。

在仓库根目录执行：

```bash
# 检查类型与现有回归
npm run typecheck
npm test

# 检查实际发布文件；应仅包含 package.json、中英文 README、入口、src 和许可文件
npm pack --dry-run
```

发布前还应将实际 tarball 解包到临时目录，只安装运行依赖，再用 pi 的包资源加载器确认 `/diff` 注册成功。验证不能依赖仓库内的开发依赖；所有临时配置和进程用后清理。

## 发布与验收

提交并推送发布内容后，由有发布权限的维护者执行：

```bash
# 通过代理发布公开 npm 包；需要有效的 npm 身份认证
/bin/zsh -ic 'proxyon && npm publish --access public'

# 通过官方安装方式验证 npm 发布结果
/bin/zsh -ic 'proxyon && pi install npm:@lyrumu/pi-diff'
```

重新加载 pi，确认 `/diff` 可打开，再检查 [官方 Packages 目录](https://pi.dev/packages) 是否展示本包。`pi-package` 关键词提供被发现的资格，不保证发布后立即展示。

npm 首次发布并验收后，将 `README.md` 和 `README.zh-CN.md` 的主安装命令改为 `pi install npm:@lyrumu/pi-diff`，更新和卸载命令同步改为该 npm 来源；Git 安装可保留为替代方式。发布前 README 使用 Git 来源，避免访客误装同名的其他项目。默认 README 使用英文，两份文档的操作说明应保持一致。

pi 包声明与宿主依赖规则见 [官方文档](https://pi.dev/docs/latest/packages)。
