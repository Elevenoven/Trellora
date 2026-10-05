import { app } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { PIPELINE_ENGINE_VERSION, PIPELINE_PROTOCOL_VERSION, type PipelineProgressEvent, type PipelineStageId, type WorkerRunStageResult } from './types';

interface WorkerMessage {
  id?: string;
  type?: string;
  ok?: boolean;
  code?: string;
  message?: string;
  diagnostic?: string;
  retryable?: boolean;
  [key: string]: unknown;
}

interface PendingRequest {
  resolve: (message: WorkerMessage) => void;
  reject: (error: WorkerClientError) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface WorkerCommand {
  executable: string;
  args: string[];
  cwd: string;
  packaged: boolean;
}

export class WorkerClientError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly diagnostic?: string;

  constructor(code: string, message: string, retryable = true, diagnostic?: string) {
    super(message);
    this.name = 'WorkerClientError';
    this.code = code;
    this.retryable = retryable;
    this.diagnostic = diagnostic;
  }
}

export interface WorkerClientOptions {
  onProgress?: (event: Omit<PipelineProgressEvent, 'libraryPath' | 'documentId'>) => void;
  onLog?: (message: string) => void;
}

export interface WorkerSearchTokenizationResult {
  tokens: string[];
  tokenizer: string;
  tokenizerVersion: string;
  dictionaryHash: string;
}

export class PythonWorkerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private sequence = 0;
  private helloPromise: Promise<void> | null = null;
  private capabilities = new Set<string>();
  private readonly options: WorkerClientOptions;

  constructor(options: WorkerClientOptions = {}) {
    this.options = options;
  }

  async probe(): Promise<string[]> {
    await this.ensureStarted();
    return [...this.capabilities];
  }

  /** stage 支持文档级阶段与库级 'graph'（图装配，不属于文档流水线顺序）。 */
  async runStage(params: { jobId: string; stage: PipelineStageId | 'graph'; inputPath: string; outputDir: string; options?: Record<string, unknown> }): Promise<WorkerRunStageResult> {
    const response = await this.request('runStage', {
      jobId: params.jobId,
      stage: params.stage,
      inputPath: params.inputPath,
      outputDir: params.outputDir,
      options: params.options ?? {},
    }, 6 * 60 * 60 * 1000);
    return {
      artifactManifest: String(response.artifactManifest ?? ''),
      counts: isRecord(response.counts) ? Object.fromEntries(Object.entries(response.counts).flatMap(([key, value]) => typeof value === 'number' ? [[key, value]] : [])) : {},
    };
  }

  async tokenizeSearch(params: { query: string; dictionaryTerms: string[]; stopwords: string[] }): Promise<WorkerSearchTokenizationResult> {
    const response = await this.request('tokenizeSearch', params, 15_000);
    if (!Array.isArray(response.tokens)
      || response.tokens.length > 64
      || response.tokens.some((token) => typeof token !== 'string' || !token || token.length > 128)) {
      throw new WorkerClientError('SEARCH_TOKENIZE_RESPONSE_INVALID', 'Jieba 检索分词返回了无效词元。', false);
    }
    return {
      tokens: response.tokens as string[],
      tokenizer: String(response.tokenizer ?? ''),
      tokenizerVersion: String(response.tokenizerVersion ?? ''),
      dictionaryHash: String(response.dictionaryHash ?? ''),
    };
  }

  async cancel(jobId: string): Promise<void> {
    if (!this.child) return;
    await this.request('cancel', { jobId }, 10_000);
  }

  async shutdown(): Promise<void> {
    if (!this.child) return;
    const child = this.child;
    let exited = child.exitCode !== null || child.signalCode !== null;
    const exit = new Promise<void>(resolve => child.once('exit', () => { exited = true; resolve(); }));
    try {
      await this.request('shutdown', {}, 2_000);
    } catch {
      child.kill();
    } finally {
      await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 2_000))]);
      if (!exited) { child.kill(); await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 1_000))]); }
      this.handleProcessFailure(new WorkerClientError('WORKER_STOPPED', '文档处理 Worker 已关闭。', true));
      this.child = null;
      this.helloPromise = null;
      this.capabilities.clear();
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.child && this.helloPromise) return this.helloPromise;
    const { executable, args, cwd, packaged } = resolveWorkerCommand();
    if (!fs.existsSync(cwd)) throw new WorkerClientError('WORKER_NOT_FOUND', '文档处理 Worker 目录不存在，请重新安装应用或配置开发环境。', false);
    if (packaged && !fs.existsSync(executable)) {
      throw new WorkerClientError(
        'WORKER_RUNTIME_MISSING',
        packaged ? '文档处理运行时缺失或安装不完整，请重新安装Trellora；笔记编辑和文件浏览仍可正常使用。' : '开发环境缺少 Python Worker，请创建 pipeline-python/.venv 或安装 Python 后重试。',
        false,
      );
    }
    if (packaged && !fs.existsSync(path.join(cwd, 'runtime-manifest.json'))) {
      throw new WorkerClientError('WORKER_RUNTIME_MISSING', '文档处理运行时清单缺失，请重新安装Trellora；笔记编辑和文件浏览仍可正常使用。', false);
    }

    const child = spawn(executable, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    const output = readline.createInterface({ input: child.stdout });
    output.on('line', (line) => this.handleLine(line));
    child.stdin.setDefaultEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (data: string) => this.options.onLog?.(`[PIPELINE] ${data.trim()}`));
    child.on('error', (error) => this.handleProcessFailure(new WorkerClientError('WORKER_START_FAILED', `文档处理 Worker 启动失败：${error.message}`, true, error.stack)));
    child.on('exit', (code, signal) => {
      if (this.child === child) { this.child = null; this.helloPromise = null; this.capabilities.clear(); }
      if (code !== 0 && code !== null) this.handleProcessFailure(new WorkerClientError('WORKER_CRASHED', `文档处理 Worker 已退出（代码 ${code}）。`, true));
      else if (signal) this.handleProcessFailure(new WorkerClientError('WORKER_CRASHED', `文档处理 Worker 被终止（${signal}）。`, true));
      else this.handleProcessFailure(new WorkerClientError('WORKER_STOPPED', '文档处理 Worker 已关闭。', true));
    });

    this.helloPromise = this.request('hello', { protocolVersion: PIPELINE_PROTOCOL_VERSION }, 15_000).then((response) => {
      if (response.protocolVersion !== PIPELINE_PROTOCOL_VERSION) {
        throw new WorkerClientError('PROTOCOL_MISMATCH', '文档处理 Worker 协议版本不兼容，请更新应用。', false);
      }
      if (response.engineVersion !== PIPELINE_ENGINE_VERSION) throw new WorkerClientError('ENGINE_MISMATCH', '文档处理引擎版本不兼容，请更新应用。', false);
      this.capabilities = new Set(Array.isArray(response.capabilities)
        ? response.capabilities.filter((value): value is string => typeof value === 'string')
        : []);
    }).catch((error) => {
      this.helloPromise = null;
      this.capabilities.clear();
      this.child?.kill();
      this.child = null;
      throw error;
    });
    return this.helloPromise;
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<WorkerMessage> {
    return new Promise((resolve, reject) => {
      void this.ensureChildForRequest(method, params, timeoutMs, resolve, reject);
    });
  }

  private async ensureChildForRequest(method: string, params: Record<string, unknown>, timeoutMs: number, resolve: PendingRequest['resolve'], reject: PendingRequest['reject']): Promise<void> {
    try {
      if (method !== 'hello') await this.ensureStarted();
      if (method === 'runStage' && isRecord(params.options) && typeof params.options.llmPhase === 'string' && !this.capabilities.has('runStage:chunks-llm-v1')) {
        throw new WorkerClientError('WORKER_CAPABILITY_MISSING', '当前文档处理 Worker 不支持智能切块 continuation，请更新应用与 Worker runtime。', false);
      }
      if (method === 'tokenizeSearch' && !this.capabilities.has('tokenizeSearch:jieba-v1')) {
        throw new WorkerClientError('WORKER_CAPABILITY_MISSING', '当前文档 Worker 不支持 Jieba 检索分词，请更新应用与 Worker runtime。', false);
      }
      const child = this.child;
      if (!child?.stdin.writable) throw new WorkerClientError('WORKER_NOT_RUNNING', '文档处理 Worker 尚未运行。', true);
      const id = `req-${++this.sequence}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new WorkerClientError('WORKER_TIMEOUT', `文档处理 Worker 在 ${Math.round(timeoutMs / 1000)} 秒内未响应。`, true));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      // Keep request JSON ASCII-safe as well. This protects Windows packaged
      // runtimes whose stdin still uses a legacy code page before reconfigure.
      child.stdin.write(`${stringifyWorkerRequest({ id, method, params })}\n`);
    } catch (error) {
      reject(error instanceof WorkerClientError ? error : new WorkerClientError('WORKER_REQUEST_FAILED', String(error), true));
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: WorkerMessage;
    try {
      message = JSON.parse(line) as WorkerMessage;
    } catch {
      this.options.onLog?.('[PIPELINE] Worker 输出了无法识别的协议消息。');
      return;
    }
    if (message.type === 'progress') {
      this.options.onProgress?.({
        jobId: String(message.jobId ?? ''),
        stage: isPipelineStage(String(message.stage ?? '')) ? String(message.stage) as PipelineStageId : 'parse',
        completed: Number(message.completed ?? 0),
        ...(typeof message.total === 'number' ? { total: message.total } : {}),
        ...(typeof message.unit === 'string' ? { unit: message.unit } : {}),
        message: String(message.message ?? ''),
      });
      return;
    }
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok === false) {
      pending.reject(new WorkerClientError(
        String(message.code ?? 'WORKER_FAILED'),
        String(message.message ?? '文档处理 Worker 执行失败。'),
        message.retryable !== false,
        typeof message.diagnostic === 'string' ? message.diagnostic : undefined,
      ));
      return;
    }
    pending.resolve(message);
  }

  private handleProcessFailure(error: WorkerClientError): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    this.options.onLog?.(`[PIPELINE] ${error.message}`);
  }
}

function isPipelineStage(value: string): value is PipelineStageId {
  return value === 'parse' || value === 'lines' || value === 'signals' || value === 'ambiguity' || value === 'tree' || value === 'chunks' || value === 'keywords' || value === 'entities';
}

function resolveWorkerCommand(): WorkerCommand {
  const developmentDirectory = path.resolve(__dirname, '../pipeline-python');
  if (!app.isPackaged) {
    const venvPython = path.join(developmentDirectory, '.venv', 'Scripts', 'python.exe');
    if (fs.existsSync(venvPython)) return { executable: venvPython, args: ['-m', 'pipeline_worker'], cwd: developmentDirectory, packaged: false };
    return { executable: 'python', args: ['-m', 'pipeline_worker'], cwd: developmentDirectory, packaged: false };
  }
  const runtimeDirectory = path.join(process.resourcesPath, 'pipeline-runtime');
  return { executable: path.join(runtimeDirectory, 'python-worker.exe'), args: ['-E', '-m', 'pipeline_worker'], cwd: runtimeDirectory, packaged: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringifyWorkerRequest(value: Record<string, unknown>): string {
  return JSON.stringify(value).replace(/[^\p{ASCII}]/gu, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
