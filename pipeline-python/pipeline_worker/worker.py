from __future__ import annotations

import os
import sys
import threading
import traceback
from pathlib import Path
from typing import Any

from . import PROTOCOL_VERSION, WORKER_VERSION
from .stage_errors import StageError
from .entities_stage import run_entities_finalize_stage, run_entities_prepare_stage
from .graph_stage import run_graph_stage
from .lines_stage import run_lines_stage
from .keyword_stage import run_keywords_stage
from .signals_stage import run_signals_stage
from .structure_stage import run_structure_chunks_stage, run_structure_tree_stage
from .chunking_stage import finalize_chunking_llm_stage, prepare_chunking_llm_stage, run_chunking_stage
from .protocol import ProtocolWriter, configure_stdio_utf8, read_requests
from .search_tokenizer import tokenize_search_query


class Worker:
    def __init__(self) -> None:
        self.writer = ProtocolWriter()
        self.shutdown_event = threading.Event()
        self.active: dict[str, tuple[threading.Event, threading.Thread]] = {}
        self.active_lock = threading.Lock()

    def handle(self, request: dict[str, Any]) -> None:
        request_id = str(request.get('id', ''))
        method = request.get('method')
        params = request.get('params') if isinstance(request.get('params'), dict) else {}
        if method == 'hello':
            self.writer.send({
                'id': request_id,
                'type': 'result',
                'ok': True,
                'protocolVersion': PROTOCOL_VERSION,
                'workerVersion': WORKER_VERSION,
                'engineVersion': 'p5',
                'capabilities': ['hello', 'runStage:lines', 'runStage:signals', 'runStage:tree', 'runStage:chunks', 'runStage:chunks-v2', 'runStage:chunks-llm-v1', 'runStage:keywords', 'runStage:entities-v1', 'runStage:graph-v1', 'tokenizeSearch:jieba-v1', 'cancel', 'shutdown'],
            })
            return
        if method == 'tokenizeSearch':
            self.tokenize_search(request_id, params)
            return
        if method == 'runStage':
            self.start_stage(request_id, params)
            return
        if method == 'cancel':
            self.cancel(request_id, str(params.get('jobId', '')))
            return
        if method == 'shutdown':
            self.shutdown(request_id)
            return
        self.error(request_id, 'UNKNOWN_METHOD', f'不支持的 Worker 方法：{method}', False)

    def tokenize_search(self, request_id: str, params: dict[str, Any]) -> None:
        try:
            dictionary_terms = params.get('dictionaryTerms', [])
            stopwords = params.get('stopwords', [])
            if not isinstance(dictionary_terms, list) or not isinstance(stopwords, list):
                raise ValueError('检索分词资源必须是字符串数组。')
            result = tokenize_search_query(params.get('query', ''), dictionary_terms, stopwords)
            self.writer.send({
                'id': request_id,
                'type': 'result',
                'ok': True,
                **result,
            })
        except Exception as exc:
            code = str(getattr(exc, 'code', 'SEARCH_TOKENIZE_FAILED'))
            self.error(request_id, code, f'Jieba 检索分词失败：{exc}', False)

    def start_stage(self, request_id: str, params: dict[str, Any]) -> None:
        job_id = str(params.get('jobId', ''))
        if not job_id:
            self.error(request_id, 'INVALID_REQUEST', '缺少 jobId。', False)
            return
        with self.active_lock:
            if self.active:
                self.error(request_id, 'WORKER_BUSY', '当前 Worker 正在处理其他任务。', True)
                return
            cancel_event = threading.Event()
            thread = threading.Thread(target=self.run_stage, args=(request_id, job_id, params, cancel_event), daemon=True)
            self.active[job_id] = (cancel_event, thread)
            thread.start()

    def run_stage(self, request_id: str, job_id: str, params: dict[str, Any], cancel_event: threading.Event) -> None:
        try:
            stage = str(params.get('stage', ''))
            options = params.get('options') if isinstance(params.get('options'), dict) else {}
            input_path = normalize_worker_path(params.get('inputPath', ''))
            output_dir = normalize_worker_path(params.get('outputDir', ''))
            progress = lambda completed, total, unit, message: self.progress(job_id, stage, completed, total, unit, message)
            if stage == 'lines':
                counts = run_lines_stage(input_path, output_dir, cancel_event, progress, str(options.get('stageKey', '')))
                artifact_manifest = str(Path(output_dir) / 'stage-manifest.json')
            elif stage == 'signals':
                counts = run_signals_stage(input_path, output_dir, str(options.get('documentId', '')), str(options.get('contentHash', '')), cancel_event, progress, str(options.get('stageKey', '')))
                artifact_manifest = str(Path(output_dir) / 'stage-manifest.json')
            elif stage == 'tree':
                counts = run_structure_tree_stage(input_path, output_dir, str(options.get('documentId', '')), str(options.get('contentHash', '')), cancel_event, progress, str(options.get('stageKey', '')))
                artifact_manifest = str(Path(output_dir) / 'stage-manifest.json')
            elif stage == 'chunks':
                config = options.get('config') if isinstance(options.get('config'), dict) else {}
                if options.get('chunkingV2') is True or config.get('schemaVersion') == 2:
                    source_blocks_path = normalize_worker_path(options.get('sourceBlocksPath', ''))
                    llm_phase = str(options.get('llmPhase') or '')
                    if llm_phase == 'prepare':
                        counts = prepare_chunking_llm_stage(input_path, source_blocks_path, output_dir, str(options.get('documentId', '')), str(options.get('contentHash', '')), config, cancel_event, progress, str(options.get('stageKey', '')))
                    elif llm_phase == 'finalize':
                        counts = finalize_chunking_llm_stage(input_path, source_blocks_path, output_dir, str(options.get('documentId', '')), str(options.get('contentHash', '')), config, options.get('llmResponses'), cancel_event, progress, str(options.get('stageKey', '')))
                    else:
                        counts = run_chunking_stage(input_path, source_blocks_path, output_dir, str(options.get('documentId', '')), str(options.get('contentHash', '')), config, cancel_event, progress, str(options.get('stageKey', '')), bool(options.get('llmAvailable')))
                else:
                    counts = run_structure_chunks_stage(input_path, output_dir, str(options.get('documentId', '')), str(options.get('contentHash', '')), config, cancel_event, progress, str(options.get('stageKey', '')))
                artifact_manifest = str(Path(output_dir) / 'stage-manifest.json')
            elif stage == 'keywords':
                counts = run_keywords_stage(input_path, output_dir, options, cancel_event, progress, str(options.get('stageKey', '')))
                artifact_manifest = str(Path(output_dir) / 'stage-manifest.json')
            elif stage == 'entities':
                config = options.get('config') if isinstance(options.get('config'), dict) else {}
                llm_phase = str(options.get('llmPhase') or '')
                if llm_phase == 'prepare':
                    counts = run_entities_prepare_stage(input_path, output_dir, str(options.get('documentId', '')), str(options.get('contentHash', '')), config, cancel_event, progress, str(options.get('stageKey', '')))
                elif llm_phase == 'finalize':
                    counts = run_entities_finalize_stage(input_path, output_dir, str(options.get('documentId', '')), str(options.get('contentHash', '')), config, options.get('llmResponses'), cancel_event, progress, str(options.get('stageKey', '')))
                else:
                    raise StageError('UNSUPPORTED_STAGE', 'entities 阶段必须通过 prepare/finalize 两相执行。', False)
                artifact_manifest = str(Path(output_dir) / 'stage-manifest.json')
            elif stage == 'graph':
                config = options.get('config') if isinstance(options.get('config'), dict) else {}
                # entitiesDirs 走 options 而非 inputPath，必须同样启用长路径前缀，否则超过 MAX_PATH 的资料库路径会被判为不存在。
                entities_dirs = [normalize_worker_path(value) for value in options.get('entitiesDirs', []) if isinstance(value, (str, Path))]
                counts = run_graph_stage(entities_dirs, output_dir, str(options.get('graphKey', '')), config, cancel_event, progress, str(options.get('stageKey', '')))
                artifact_manifest = str(Path(output_dir) / 'stage-manifest.json')
            else:
                raise StageError('UNSUPPORTED_STAGE', f'不支持的 Worker 阶段：{stage}', False)
            self.writer.send({
                'id': request_id,
                'type': 'result',
                'jobId': job_id,
                'ok': True,
                'stage': stage,
                'artifactManifest': artifact_manifest,
                'counts': counts,
            })
        except StageError as exc:
            self.error(request_id, exc.code, exc.message, exc.retryable, exc.diagnostic, job_id)
        except Exception as exc:
            print(traceback.format_exc(), file=sys.stderr, flush=True)
            self.error(request_id, 'WORKER_STAGE_FAILED', f'Worker 阶段执行失败：{exc}', True, traceback.format_exc(limit=4), job_id)
        finally:
            with self.active_lock:
                self.active.pop(job_id, None)

    def cancel(self, request_id: str, job_id: str) -> None:
        with self.active_lock:
            active = self.active.get(job_id)
        if active:
            active[0].set()
        self.writer.send({'id': request_id, 'type': 'result', 'ok': True, 'jobId': job_id, 'cancelRequested': bool(active)})

    def shutdown(self, request_id: str) -> None:
        self.shutdown_event.set()
        with self.active_lock:
            threads = [thread for _event, thread in self.active.values()]
        for thread in threads:
            thread.join(timeout=2)
        self.writer.send({'id': request_id, 'type': 'result', 'ok': True})

    def progress(self, job_id: str, stage: str, completed: int, total: int | None, unit: str, message: str) -> None:
        self.writer.send({
            'id': f'evt-{job_id}-{completed}',
            'type': 'progress',
            'jobId': job_id,
            'stage': stage,
            'completed': completed,
            **({'total': total} if total is not None else {}),
            'unit': unit,
            'message': message,
        })

    def error(self, request_id: str, code: str, message: str, retryable: bool, diagnostic: str | None = None, job_id: str | None = None) -> None:
        self.writer.send({
            'id': request_id,
            'type': 'result',
            **({'jobId': job_id} if job_id else {}),
            'ok': False,
            'code': code,
            'message': message,
            'retryable': retryable,
            **({'diagnostic': diagnostic} if diagnostic else {}),
        })


def main() -> None:
    configure_stdio_utf8()
    worker = Worker()
    for request in read_requests():
        worker.handle(request)
        if worker.shutdown_event.is_set():
            break


def normalize_worker_path(value: Any) -> str:
    """Enable Win32 extended-length paths before stages append artifact names."""
    raw_path = str(value or '')
    if os.name != 'nt' or not raw_path:
        return raw_path
    if raw_path.startswith(('\\\\?\\', '\\\\.\\')):
        return raw_path
    absolute_path = os.path.abspath(raw_path)
    if len(absolute_path) < 240:
        return absolute_path
    if absolute_path.startswith('\\\\'):
        return '\\\\?\\UNC\\' + absolute_path[2:]
    return '\\\\?\\' + absolute_path
