# Trellora

Windows 本地优先的 Markdown 笔记与知识管理应用，支持笔记编辑、资料库检索、AI 问答和长期记忆。

## 下载

当前版本 **1.0.1**，支持 Windows x64。

- [便携版 EXE](https://github.com/Elevenoven/Trellora/releases/download/v1.0.1/Trellora-1.0.1-portable-x64.exe)
- [安装版 EXE](https://github.com/Elevenoven/Trellora/releases/download/v1.0.1/Trellora-1.0.1-setup-x64.exe)
- [GitHub Releases](https://github.com/Elevenoven/Trellora/releases)

便携版更新时，先退出应用，再替换 EXE，保留工作区、笔记库和资料库文件夹。正式包启动后会检查本仓库的最新正式 Release；下载由系统浏览器完成。

Ollama 或远程模型服务按需配置；运行发行包无需单独安装 Python。文件校验见 [SHA256SUMS.txt](downloads/SHA256SUMS.txt)。

## 从源码运行

准备 Windows x64、Node.js 22 或 24、pnpm。

```powershell
pnpm install --frozen-lockfile
pnpm run rebuild:native
pnpm dev
```

构建安装包另需 Windows x64 CPython，将发行 Worker 的依赖安装到指定目录：

```powershell
py -3 -m pip install --target pipeline-python/.deps -r pipeline-python/requirements.lock
pnpm build
pnpm run release:manifest
```

产物输出到 `trellora/`。源码包含 React、Electron、本地 Python Worker、构建脚本及内置技能资源。

## 许可证

[Apache-2.0](LICENSE)。项目与第三方署名见 [NOTICE](NOTICE)，第三方组件遵循各自许可证。
