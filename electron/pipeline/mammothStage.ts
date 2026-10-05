import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { PipelineStageError } from './stageErrors';

const MAMMOTH_TIMEOUT_MS = 5 * 60 * 1000;

interface MammothWorkerMessage {
  ok: boolean;
  counts?: Record<string, number>;
  code?: string;
  message?: string;
  diagnostic?: string;
  retryable?: boolean;
}

export interface MammothStageProgress {
  completed: number;
  total: number;
  message: string;
}

export interface MammothStageResult {
  counts: Record<string, number>;
}

/**
 * Mammoth runs in an isolated Node worker so a large DOCX cannot block the
 * Electron main process. The worker writes only into the orchestrator's stage
 * temp directory; the original document remains read-only.
 */
export function runMammothDocxParse(params: {
  inputPath: string;
  outputDir: string;
  sourceName?: string;
  signal: AbortSignal;
  onProgress?: (progress: MammothStageProgress) => void;
  workerScriptPath?: string;
}): Promise<MammothStageResult> {
  if (!fs.existsSync(params.inputPath) || !fs.statSync(params.inputPath).isFile()) {
    throw new PipelineStageError('SOURCE_NOT_FOUND', '原始 DOCX 不存在或不可读。', false);
  }
  if (path.extname(params.inputPath).toLowerCase() !== '.docx') {
    throw new PipelineStageError('UNSUPPORTED_FORMAT', 'Mammoth 仅支持 DOCX 文档。', false);
  }
  if (params.signal.aborted) {
    throw new PipelineStageError('STAGE_CANCELLED', 'DOCX 解析任务已取消。', true);
  }

  const workerPath = params.workerScriptPath ?? resolveMammothWorkerPath();
  if (!fs.existsSync(workerPath)) {
    throw new PipelineStageError('MAMMOTH_WORKER_MISSING', 'Mammoth 解析组件缺失，请重新构建或安装应用。', false, workerPath);
  }
  fs.mkdirSync(params.outputDir, { recursive: true });
  params.onProgress?.({ completed: 0, total: 1, message: '正在使用 Mammoth 解析 DOCX。' });

  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, {
      workerData: {
        inputPath: params.inputPath,
        outputDir: params.outputDir,
        sourceName: params.sourceName ?? path.basename(params.inputPath),
      },
    });
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      params.signal.removeEventListener('abort', abort);
      callback();
    };
    const abort = (): void => {
      void worker.terminate();
      finish(() => reject(new PipelineStageError('STAGE_CANCELLED', 'DOCX 解析任务已取消。', true)));
    };
    const timeout = setTimeout(() => {
      void worker.terminate();
      finish(() => reject(new PipelineStageError('MAMMOTH_TIMEOUT', 'Mammoth 解析 DOCX 超时，可以重试。', true)));
    }, MAMMOTH_TIMEOUT_MS);

    params.signal.addEventListener('abort', abort, { once: true });
    worker.once('message', (message: MammothWorkerMessage) => {
      if (!message?.ok) {
        finish(() => reject(new PipelineStageError(
          message?.code ?? 'MAMMOTH_PARSE_FAILED',
          message?.message ?? 'Mammoth 解析 DOCX 失败。',
          message?.retryable !== false,
          message?.diagnostic,
        )));
        return;
      }
      const counts = message.counts ?? {};
      finish(() => {
        params.onProgress?.({ completed: 1, total: 1, message: `DOCX 解析完成，共生成 ${counts.blocks ?? 0} 个文档块。` });
        resolve({ counts });
      });
    });
    worker.once('error', (error) => {
      finish(() => reject(new PipelineStageError('MAMMOTH_WORKER_FAILED', `Mammoth 解析组件启动失败：${error.message}`, true, error.stack)));
    });
    worker.once('exit', (code) => {
      if (settled) return;
      finish(() => reject(new PipelineStageError('MAMMOTH_WORKER_EXITED', `Mammoth 解析组件异常退出（代码 ${code}）。`, true)));
    });
  });
}

function resolveMammothWorkerPath(): string {
  if (__dirname.includes(`${path.sep}app.asar${path.sep}`)) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'dist-electron', 'mammothWorker.js');
  }
  return path.join(__dirname, 'mammothWorker.js');
}
