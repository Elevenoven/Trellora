# Trellora 工程 Agent 约定

本文档是后续 Agent 在本项目中实现文档流水线、桌面封装和相关后端能力时的工程约束。

## 0. 领域主合同

涉及问答历史、工作记忆、历史对话搜索、长期语义记忆及其数值合同时，以 `docs/Trellora-2.0-WeKnora记忆架构严格对齐改造方案.md` 为记忆域实施主合同。旧记忆方案只作历史材料；每次只实施一个 `WK-M` 阶段并通过该阶段完成门后再继续。

## 1. 总体架构决策

Trellora 是一个 Windows 本地优先桌面应用，采用以下进程分层：

```text
React 渲染进程
    ↓ window.electronAPI / preload IPC
Electron 主进程
    ├─ 应用生命周期与文件权限
    ├─ PipelineOrchestrator：任务队列、取消、重试、进度
    ├─ MaterialsStore：资料库元数据与阶段产物
    ├─ SQLite / sqlite-vec：索引与检索数据
    ├─ Mammoth Worker Thread：DOCX 本地解析与统一 parse 产物
    └─ Python 后续阶段 Worker
         ├─ 逻辑行与结构信号
         ├─ 结构树、父子切块与关键词
         └─ 标准化 JSONL 阶段产物
```

Python Worker 是随桌面应用一起发布的本地 Sidecar，不是要求用户单独部署的 Web 后端，也不应在第一版中默认启动 FastAPI 或占用本地端口。Python 核心逻辑应保持与传输层解耦，未来确有服务端需求时，再增加 FastAPI 适配器。

## 2. 进程职责边界

### Electron 主进程负责

- 启动、复用、重启和关闭 Python Worker。
- 校验资料库注册状态、路径边界和允许处理的文件类型。
- 管理任务队列、任务状态、取消、超时、重试和应用退出时的善后。
- 通过 preload 暴露有限的 IPC 能力，不让渲染进程直接访问 Node.js 或文件系统。
- 保存解析配置、应用配置和远程服务密钥；密钥继续使用 Electron `safeStorage`。
- 将 Python 阶段产物导入 `.menghan-meta/` 和 SQLite/sqlite-vec。
- 向渲染进程发布可读的状态、进度和错误信息。

### Electron 主进程内的 Mammoth Worker Thread 负责

- 在隔离的 Node.js Worker Thread 中解析 DOCX，避免阻塞 Electron 主进程。
- 将 DOCX 转换为统一的 `document.md`、`blocks.jsonl`、`line-layout.jsonl` 和 `parse-report.json`。
- 只读原始 DOCX，仅写入 Electron 分配的阶段临时目录。

### Python Worker 负责

- 处理逻辑行、规则信号、结构树、父子切块、关键词与 Jieba 分词。
- 消费 Electron 解析阶段生成的统一产物，不再承担 DOCX 首段解析。
- 只读原始资料文件，并将结果写入 Electron 分配的阶段输出目录。
- 输出机器可校验的协议消息和阶段结果，不直接操作 UI、Electron Store 或应用 SQLite。

### 禁止事项

- Python Worker 不得直接写入 `.menghan-meta/index.db`，避免与 Electron 的 SQLite 写入产生竞争或损坏。
- Python Worker 不得修改 Markdown、PDF、DOCX 等用户原始文件。
- 不得从渲染进程直接 `spawn` Python、读取本地文件或传递 API Key。
- 不得通过 shell 拼接命令启动 Worker，不得使用 `exec` 执行未经验证的用户输入。
- 不得把 API Key 放入命令行参数、日志、阶段产物或普通配置文件。

## 3. Electron 启动 Python Worker

推荐在 `electron/pipeline/pythonWorkerClient.ts` 中集中实现启动逻辑，其他模块不得自行创建 Python 进程。

### 可执行文件解析

- 开发环境：优先使用 `pipeline-python/.venv/Scripts/python.exe`，通过 `-m pipeline_worker` 启动。
- 发布环境：使用 `process.resourcesPath/pipeline-runtime/python-worker.exe`，或发布的嵌入式 `python.exe` 加 Worker 模块。
- 启动前执行 `hello` 握手，校验 `protocolVersion`、`engineVersion` 和能力列表。
- 找不到运行时、协议版本不兼容或启动失败时，应返回中文可操作错误，并保持笔记编辑、文件浏览等核心功能可用。

### 启动约束

```ts
spawn(executable, args, {
  cwd: workerWorkingDirectory,
  shell: false,
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
});
```

- 必须使用参数数组，禁止拼接命令字符串。
- Worker 标准输出只允许输出 NDJSON 协议消息；普通日志写入 stderr，由 Electron 统一接入应用日志。
- 一个应用实例默认复用一个 Worker；Worker 崩溃后只能由 `PipelineOrchestrator` 按退避策略重启。
- 应用退出时先发送 `shutdown`，等待有限时间后再结束进程，不能遗留后台 Python 进程。
- 对单个任务设置超时和最大输出大小；超时后先发送 `cancel`，无响应时再结束 Worker 并标记任务为可重试。

## 4. Worker NDJSON 协议

请求、事件和响应均为一行 JSON，禁止把多行日志混入 stdout。

```json
{"id":"req-1","method":"hello","params":{"protocolVersion":1}}
{"id":"req-2","method":"runStage","params":{"jobId":"job-1","stage":"parse","inputPath":"...","outputDir":"...","options":{}}}
{"id":"evt-1","type":"progress","jobId":"job-1","stage":"parse","completed":3,"total":10,"message":"正在解析第 3 页"}
{"id":"req-2","type":"result","jobId":"job-1","ok":true,"manifestPath":"..."}
```

协议至少支持：

- `hello`：返回协议版本、引擎版本和能力列表。
- `runStage`：执行一个阶段，不隐式执行未请求的下游阶段。
- `cancel`：按 `jobId` 取消任务。
- `shutdown`：优雅退出。

每条响应必须带对应请求 `id`；每个事件必须带 `jobId` 和阶段名。错误必须包含稳定的 `code`、面向用户的 `message` 和可选的 `diagnostic`，不要只返回 Python traceback。

## 5. 阶段产物、缓存与恢复

资料库原始文件仍是唯一真实来源，解析结果放在资料库的 `.menghan-meta/` 下。建议使用类似结构：

```text
.menghan-meta/
└─ pipeline/
   └─ <documentId>/
      └─ <sourceContentHash>/
         ├─ 01-parse/
         ├─ 02-clean/
         ├─ 03-chunks/
         ├─ 04-vectors/
         └─ manifest.json
```

每个阶段的缓存键至少包含：

- 原始文档 `contentHash`。
- 阶段配置 `configHash`。
- 引擎版本和协议版本。
- 阶段名称及其输入阶段版本。

阶段输出必须先写入临时目录，校验通过后再原子改名为正式目录。任务中断时保留已完成阶段；配置、源文件或引擎版本变化时，只使当前阶段及其下游失效。SQLite 只保存可检索的元数据、块索引和向量，不把大体积原始阶段文件全部塞入数据库。

## 6. IPC 与 UI 约定

所有渲染进程调用都必须经过 `preload.ts` 和 `src/electron.d.ts` 类型声明。建议的最小 IPC 面如下：

- `pipeline:get-capabilities`
- `pipeline:get-status`
- `pipeline:start`
- `pipeline:cancel`
- `pipeline:retry-stage`
- `pipeline:get-artifacts`

主进程向渲染进程发送：

- `pipeline-status`
- `pipeline-progress`
- `pipeline-log`

`MaterialsPipelineView` 只负责展示状态、配置和用户操作，不负责推断阶段是否完成。按钮状态、阶段状态和错误信息必须来自主进程的真实状态；前端隐藏按钮不能替代主进程的路径校验和任务权限校验。

第一阶段优先打通 `parse`：上传文档 → 启动 Worker → 显示进度 → 生成解析产物 → 可取消 → 可重试。清洗、切块、向量化和索引应在协议稳定后逐阶段接入。

## 7. 发布与打包

- 轻量 Python 运行时和 Worker 放到 electron-builder 的 `extraResources`，不要放在渲染进程 bundle 中。
- 优先使用 PyInstaller `onedir` 或嵌入式 Python；第一版不优先使用 PyInstaller `onefile`，避免启动解压、杀毒软件和原生依赖问题。
- 发布包只包含后续结构化阶段需要的 Python runtime、Jieba 与版本清单；Mammoth 随独立 Node Worker bundle 发布。
- 开发环境与发布环境使用同一套 Worker 协议，不能因为打包而更换接口行为。
- portable 包必须在没有安装 Python、没有项目虚拟环境、没有开发依赖的干净 Windows x64 环境中验证。

远程 MinerU 等云端能力应由 Electron 侧维护同意状态和密钥边界；如果确实由 Python 发起请求，也只能通过受控的短生命周期输入传递凭据，不能落盘或出现在命令行中。

## 8. 实现验收标准

实现完成后至少验证：

1. 干净 Windows 环境无需安装 Python 即可启动应用。
2. PDF/DOCX 上传后能够完成解析，界面显示真实进度和阶段结果。
3. 取消、失败重试、Worker 崩溃恢复和应用重启续跑符合预期。
4. 原始文档内容不被修改，阶段产物和索引写入 `.menghan-meta/`。
5. Python 缺失或引擎不可用时，错误可理解，笔记编辑和文件浏览仍可用。
6. 同一文档、同一配置和同一引擎版本能够命中缓存，不重复处理。
7. `pnpm exec tsc -b`、`pnpm lint`、Python 单元测试和发布包运行验证分别通过。

静态 TypeScript 构建只能证明 IPC 类型和打包入口基本正确，不能证明 Mammoth 真实 DOCX 解析、Python runtime、Windows 进程生命周期或发布包运行可用；这些必须作为独立运行时验收门槛。
