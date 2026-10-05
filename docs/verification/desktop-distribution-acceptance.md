# 桌面分发优化实施与验收记录

日期：2026-10-02。REL-0 至 REL-7 的功能已落地；REL-8 按本机最终候选、干净系统、跨机和真实服务分别验收。已有 WIP 保留，没有提交、推送或关闭用户原来的 Electron。

| 阶段 | 当前实现与本机证据 | 剩余验收 |
| --- | --- | --- |
| REL-0 | 统一包路径/版本；当前 ASAR、Worker、原生模块、运行时与签名探针；SHA-256/WIP 清单；兼容 DLL 检测 | 正式发布签名 |
| REL-1 | 5 MiB × 5 安全日志、不可写降级、冷启动历史；单实例聚焦；真实根/重叠锁和崩溃回收；Worker 退出；缺 Python/损坏 QA 数据库时笔记可写且原数据保留 | 原生锁冲突“选择其他位置”完整人工流程 |
| REL-2 | 配置与连接回执分开；取消/超时；回执绑定配置、模型、上下文和密钥；全文不被向量失败降级；PDF 批次选择、文档/hash 授权和不可变上传副本；未授权入队/重试不上传 | 真实模型、Embedding、MinerU；原生 PDF 上传交互 |
| REL-3 | 实际问答首页与设置引导、持久跳过、两篇虚构中文样例；零配置状态；重复导入保留修改；冷启动保留跳过状态 | 第二台电脑首次运行 |
| REL-4 | 先冻结并拒绝新写入，再保存草稿和排空；暂停/恢复背景写入与监听；在线 SQLite 副本；流式 ZIP64、根去重、空目录、hash；白名单设置；默认关闭的每日快照，保留 7 份成功自动包、手动包保留 | 实际磁盘写满、外部应用并发改库 |
| REL-5A | 有界预检、非法路径/重复/链接/加密/压缩限制；独立暂存、展开 hash、持久日志；取消清理本操作暂存 | 外部占用/权限矩阵 |
| REL-5M | 实际 schema 9/7 迁移；最终可信 scope；原文、ID、向量身份、任务/generation、墓碑、替代链、已用快照、审计保留；其他 scope 不动；完整性/外键与持久暂停 | 跨机新身份及实际旧版数据全集 |
| REL-5B | 发布和幂等登记分开；失败暂存回执；标记改变拒绝继续；登记重试保留发布后修改；新库登记/工作区切换；无密钥连接提示，当前连接保留 | 跨机目录矩阵 |
| REL-6 | 手动正式版查询、SemVer、10 秒超时、5 分钟缓存/请求合并；未发布/限流/离线/非法 URL/过大响应；更新说明，无自动更新 | 仓库正式发布后的真实查询 |
| REL-7 | 中英文/深浅主题；真实 Electron 引导与设置截图，100/125/150% 视口模拟；路径换行、滚动、技术详情折叠；只显示一个主页面 | 实际 OS DPI 与更窄窗口 |
| REL-8 | 最终候选重建；资源、隔离 PATH 的 Python、实际 portable 运行与恢复分别记录 | 干净 Windows 10/11、第二台电脑、真实服务、旧版升级；正式分发门未通过 |

## 可重复检查

```powershell
pnpm exec tsc -b
pnpm lint
node scripts/verify-desktop-diagnostics.mjs
node scripts/verify-desktop-capabilities.mjs
node scripts/verify-desktop-cloud-queue.mjs
node scripts/verify-desktop-memory-restore.mjs
node scripts/verify-workspace-backup.mjs
node scripts/verify-release-check.mjs
node scripts/run-electron-node.mjs scripts/verify-material-embedding-profile.cjs
node scripts/run-electron-node.mjs scripts/verify-memory-schema-and-scope.mjs
node scripts/run-electron-node.mjs scripts/verify-wk-m8-lifecycle.mjs
node scripts/run-electron-node.mjs scripts/verify-memory-migration-and-cutover.mjs
$env:PYTHONPATH='pipeline-python;pipeline-python/.deps'
py -3 -m unittest discover -s pipeline-python/tests -v
pnpm run build:pipeline-runtime
pnpm run build:electron
pnpm exec vite build
pnpm exec electron-builder --win portable --x64
node scripts/verify-portable-package.mjs
node scripts/verify-desktop-runtime.mjs
node scripts/verify-desktop-runtime.mjs --packaged
node scripts/verify-desktop-faults.mjs
node scripts/verify-desktop-ui.mjs
node scripts/write-release-manifest.mjs
```

定向行为检查及仓库 `tsc -b`、lint 已通过。Python 执行 91 项：90 项通过、1 项因可选 `igraph/leidenalg` 未安装而跳过；未禁用断言或新增该依赖。`test_chunking_llm.py` 修正一个过时断言：噪声过滤后的完整句实际属于 HIGH，严格检查跳过 5 个噪声块及 `QUALITY_NOT_READY`，没有改动算法。

实际 Electron 保存检查覆盖输入、切篇/切库保存、标签/近期备份版本队列、外部删除/冲突草稿、另存副本、关闭握手、1 MiB 索引与冷启动检索，见 [开发实例](desktop-note-save-electron.json) 和 [独立 ASAR 包](desktop-note-save-packaged.json)。独立 ASAR 与最终 portable 是不同验收门。

[界面报告](desktop-ui.json) 包含中英文、深浅主题、12 次引导与 4 次设置检查及 16 张截图，位于 `desktop-ui/`。这是实际 Electron 的视口模拟，没有改变操作系统 DPI。检查发现并修正 `display:flex` 覆盖 `hidden` 导致两页并排的问题，并增加主页面唯一性检查。

[性能报告](desktop-backup-performance.json)：1000 篇中文小笔记加 1 GiB 零填充附件，1001 文件、输入 1073804714 bytes、ZIP 1332391 bytes；捕获 14.443 秒、压缩校验 6.386 秒、恢复校验 8.249 秒，峰值 RSS 114941952 bytes，Electron 31.7.7 / Node 20.18.0。附件高度可压缩，不能把压缩大小与速度推广到真实图片/视频；展开字节与 hash 均实际流式核验。

## 成品检查中修正的问题

- 默认 portable 解压目录按构建固定，第二次启动清理后，第一个实例的运行时消失。当前 `portable.unpackDirName=true` 已按锁定的 electron-builder **24.13.3** 源码及 NSIS 模板核对，使用每次启动的 `$PLUGINSDIR/app`。[24.13.3 源码](https://github.com/electron-userland/electron-builder/blob/v24.13.3/packages/app-builder-lib/src/targets/nsis/NsisTarget.ts#L251) 支持此行为；新版本文档的布尔语义不同，升级打包器需重跑实际双启动。
- 初始脚本选中 PATH 中的 Anaconda，`python313.dll` 依赖未打包的 `zlib.dll`，开发 PATH 掩盖了问题。现在优先使用 Windows `py -3` 选择独立 CPython，构建和成品探针只保留 System32/Windows PATH。最终为 CPython 3.13.2、Worker 0.3.0、协议 1、engine p5、Jieba 0.42.1。
- 恢复和资料向量配置的原生扩展使用真实 `app.asar.unpacked` 地址，开发环境保留原加载方式，避免 Windows 加载 ASAR 虚拟路径失败。
- 发布失败后继续恢复，会同时核对迁移副本、暂停标记与无密钥连接提示；修改标记不能绕过校验。

## 检查边界和未通过项

1. `verify-packaged-workspace.mjs` 已修正包路径和数据隔离，其第 77 行仍期待当前界面没有的“近期索引状态”，实际为空态“知识库概览…选择一篇笔记…”。旧整套 UI 脚本没有通过，没有删掉断言；布局和保存由新检查独立证明，旧用例仍需维护。
2. 额外主进程全入口严格类型审计仍有 Agent、上下文、工具事件及证据类型错误，见 [原始输出](desktop-main-type-audit.txt)。命令是 `pnpm exec tsc --noEmit --strict --resolveJsonModule --esModuleInterop --skipLibCheck --target ES2022 --module commonjs --moduleResolution node electron/main.ts`。它超出仓库 `tsc -b` 范围，本轮未改变这些领域合同来消除错误；不宣称全后端严格类型通过。
3. 项目 E: 目录内恢复测试曾真实遭遇 `EPERM/WinError 5`，关闭 SQLite 句柄和有界重试后仍失败，原因未证实。项目外 C: 临时目录的相同实现通过，文件占用注入的失败保留和继续恢复也通过。不能归因于某个杀毒程序，跨卷/同步/占用仍待验收。
4. 缺运行时/损坏 QA 数据库检查使用解包版独立副本，不改候选资源或用户数据。SQLite 只读连接可能生成空 WAL/SHM，允许这种无提交记录的副作用；非空 WAL 或源数据改变仍令捕获失败。数据库用在线备份，不丢弃 WAL 后直接复制。
5. 上限为 50000 数据文件、50000 目录、1000 物理根与库登记、展开后 256 GiB、清单 16 MiB、设置 1 MiB。新增依赖是 MIT 的 `yazl 3.3.1`、`yauzl 3.4.0`，参考 [yazl](https://github.com/thejoshwolfe/yazl)、[yauzl](https://github.com/thejoshwolfe/yauzl) 原始说明。

Electron 验证隔离 userData、工作区和注册库，只控制自身窗口和对话框；临时语料在检查后清理。原有 `note-save-electron.json` 未由本轮覆盖。近期备份保持 3 份，普通保存间隔与增量索引不变，维护使用独立冻结原因。REL-5M 只补充 WK-M8 物理恢复，不改记忆 schema、枚举、算法和数值。

候选 SHA-256、大小和实际签名以 `trellora/release-manifest.json` 为准。目前 `NotSigned`；配置签名开关不能代替签名证据。干净系统、跨机、真实服务和旧版升级未取得证据前，正式分发门保持未通过。

## 最终候选的本机结果

实际运行 `trellora/Trellora-1.0.0-portable-x64.exe`，应用 PATH 不含 Python/Conda，使用隔离配置、工作区和外部库：[portable 报告](desktop-runtime-portable.json) 通过重复启动恢复并聚焦、启动记录唯一、双启动后 Worker 握手/退出、不可达模型、样例幂等、真实备份与恢复文件/文件夹选择、恢复到新目录、原库和新库登记、切换恢复工作区、任务保持暂停、无密钥连接提示、跳过状态、正常关闭与冷启动。该报告记录的 exe hash 与最终清单一致。

- 文件：`Trellora-1.0.0-portable-x64.exe`，93088908 bytes。
- SHA-256：`a0e783d83bf71c562233e1e9bf6426d5c3efd913e5f254a31ccf0087fa758510`。
- 签名：`NotSigned`。
- 资源检查已通过；ASAR main/preload/index HTML 及构建输出字节比对一致。

实际首页引导接入 `src/App.tsx` 的问答工作区；旧 `HomeView.tsx` 当前没有被 App 使用，其阶段文案同步清理，不以修改未使用组件替代真正的首页开发。
