from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def chunk_record(ordinal: int) -> dict[str, object]:
    return {
        'schemaVersion': 2,
        'documentId': 'doc-worker',
        'chunkId': f'chunk-{ordinal}',
        'parentChunkId': f'parent-{ordinal}',
        'ordinal': ordinal,
        'text': f'权限管理第 {ordinal} 项文档处理需要审计留痕。',
        'sectionPath': [],
        'nodeIds': [],
        'sourceRefs': [],
        'overlapFromChunkId': None,
        'overlapChars': 0,
    }


class KeywordWorkerTests(unittest.TestCase):
    def test_hello_and_run_stage_keywords_are_ndjson(self):
        with tempfile.TemporaryDirectory(prefix='keywords-worker-') as temporary:
            root = Path(temporary)
            chunks_path = root / 'chunks.jsonl'
            output_path = root / '07-keywords'
            chunks_path.write_text(
                '\n'.join(json.dumps(chunk_record(index), ensure_ascii=False) for index in range(3)) + '\n',
                encoding='utf-8',
            )
            process = subprocess.Popen(
                [sys.executable, '-m', 'pipeline_worker'],
                cwd=ROOT,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            try:
                assert process.stdin is not None
                assert process.stdout is not None
                self._send(process, {
                    'id': 'hello',
                    'method': 'hello',
                    'params': {'protocolVersion': 1},
                })
                hello = self._read_until(process, 'hello')
                self.assertTrue(hello['ok'], hello)
                self.assertEqual(hello['workerVersion'], '0.3.0')
                self.assertIn('runStage:keywords', hello['capabilities'])
                self.assertIn('tokenizeSearch:jieba-v1', hello['capabilities'])
                self.assertNotIn('runStage:parse', hello['capabilities'])
                self.assertNotIn('doclingVersion', hello)

                self._send(process, {
                    'id': 'tokenize-search',
                    'method': 'tokenizeSearch',
                    'params': {
                        'query': '投标保证金应在开标前缴纳',
                        'dictionaryTerms': ['投标保证金'],
                        'stopwords': [],
                    },
                })
                tokenized = self._read_until(process, 'tokenize-search')
                self.assertTrue(tokenized['ok'], tokenized)
                self.assertIn('投标保证金', tokenized['tokens'])
                self.assertIn('开标', tokenized['tokens'])
                self.assertIn('缴纳', tokenized['tokens'])

                self._send(process, {
                    'id': 'keywords',
                    'method': 'runStage',
                    'params': {
                        'jobId': 'job-keywords',
                        'stage': 'keywords',
                        'inputPath': str(chunks_path),
                        'outputDir': str(output_path),
                        'options': {
                            'stageKey': 'worker-keywords-v1',
                            'documentId': 'doc-worker',
                            'tokenizer': 'rule-explicit',
                            'dictionaryTerms': ['权限管理', '文档处理', '审计留痕'],
                            'config': {'maxCandidatesPerChunk': 32, 'maxKeywords': 5, 'minScore': 0},
                        },
                    },
                })
                result = self._read_until(process, 'keywords')
                self.assertTrue(result['ok'], result)
                self.assertEqual(result['stage'], 'keywords')
                self.assertTrue(Path(result['artifactManifest']).is_file())
                self.assertEqual(result['counts']['chunks'], 3)
                self.assertTrue((output_path / 'keywords.jsonl').is_file())

                self._send(process, {'id': 'shutdown', 'method': 'shutdown', 'params': {}})
                shutdown = self._read_until(process, 'shutdown')
                self.assertTrue(shutdown['ok'])
                process.wait(timeout=5)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)
                if process.stdin is not None:
                    process.stdin.close()
                if process.stdout is not None:
                    process.stdout.close()
                if process.stderr is not None:
                    process.stderr.close()

    @staticmethod
    def _send(process: subprocess.Popen[bytes], request: dict[str, object]) -> None:
        assert process.stdin is not None
        process.stdin.write((json.dumps(request, ensure_ascii=True) + '\n').encode('ascii'))
        process.stdin.flush()

    @staticmethod
    def _read_until(process: subprocess.Popen[bytes], request_id: str) -> dict[str, object]:
        assert process.stdout is not None
        while True:
            raw_line = process.stdout.readline()
            if not raw_line:
                raise AssertionError(f'Worker 在收到 {request_id} 响应前退出，returncode={process.poll()}')
            value = json.loads(raw_line.decode('ascii'))
            if value.get('id') == request_id:
                return value


if __name__ == '__main__':
    unittest.main()
