import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def extended_path(path: Path) -> str:
    absolute_path = str(path.resolve())
    if sys.platform == 'win32' and not absolute_path.startswith('\\\\?\\'):
        return '\\\\?\\' + absolute_path
    return absolute_path


class WorkerProtocolTests(unittest.TestCase):
    def test_hello_and_shutdown_are_ndjson(self):
        process = subprocess.Popen(
            [sys.executable, '-m', 'pipeline_worker'],
            cwd=ROOT,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        assert process.stdin is not None
        assert process.stdout is not None
        process.stdin.write(json.dumps({'id': 'hello', 'method': 'hello', 'params': {'protocolVersion': 1}}) + '\n')
        process.stdin.flush()
        hello = json.loads(process.stdout.readline())
        self.assertTrue(hello['ok'])
        self.assertEqual(hello['protocolVersion'], 1)
        self.assertIn('runStage:chunks-llm-v1', hello['capabilities'])
        self.assertNotIn('runStage:parse', hello['capabilities'])
        self.assertNotIn('doclingVersion', hello)
        process.stdin.write(json.dumps({'id': 'shutdown', 'method': 'shutdown', 'params': {}}) + '\n')
        process.stdin.flush()
        shutdown = json.loads(process.stdout.readline())
        self.assertTrue(shutdown['ok'])
        process.wait(timeout=5)
        process.stdin.close()
        process.stdout.close()
        process.stderr.close()

    def test_chinese_error_message_survives_worker_transport(self):
        process = subprocess.Popen(
            [sys.executable, '-m', 'pipeline_worker'],
            cwd=ROOT,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        assert process.stdin is not None
        assert process.stdout is not None
        missing_parse_directory = ROOT / '.protocol-encoding-test-missing-parse'
        process.stdin.write(json.dumps({
            'id': 'lines-error',
            'method': 'runStage',
            'params': {
                'jobId': 'job-lines-error',
                'stage': 'lines',
                'inputPath': str(missing_parse_directory),
                'outputDir': str(ROOT / '.protocol-encoding-test-output'),
                'options': {},
            },
        }).encode('utf-8') + b'\n')
        process.stdin.flush()
        response = json.loads(process.stdout.readline().decode('ascii'))
        self.assertFalse(response['ok'])
        self.assertEqual(response['code'], 'LINES_INPUT_NOT_FOUND')
        self.assertEqual(response['message'], '解析阶段缺少 document.md，无法生成逻辑行。')

        process.stdin.write(json.dumps({'id': 'shutdown', 'method': 'shutdown', 'params': {}}).encode('utf-8') + b'\n')
        process.stdin.flush()
        shutdown = json.loads(process.stdout.readline().decode('ascii'))
        self.assertTrue(shutdown['ok'])
        process.wait(timeout=5)
        process.stdin.close()
        process.stdout.close()
        process.stderr.close()

    def test_unicode_input_path_survives_worker_transport(self):
        temporary_root = Path(tempfile.mkdtemp(prefix='worker-unicode-path-', dir=ROOT))
        process: subprocess.Popen[bytes] | None = None
        try:
            long_root = temporary_root / '中文资料库' / ('a' * 64) / ('b' * 64) / ('c' * 64)
            parse_directory = long_root / '01-parse'
            output_directory = long_root / '02-lines'
            parse_io_directory = Path(extended_path(parse_directory))
            output_io_directory = Path(extended_path(output_directory))
            parse_io_directory.mkdir(parents=True)
            (parse_io_directory / 'document.md').write_text('# 标题\n正文\n', encoding='utf-8')
            (parse_io_directory / 'blocks.jsonl').write_text(
                json.dumps({'blockId': 'b-1', 'text': '# 标题'}, ensure_ascii=False) + '\n',
                encoding='utf-8',
            )
            if sys.platform == 'win32':
                self.assertGreaterEqual(len(str(parse_directory / 'document.md')), 260)

            process = subprocess.Popen(
                [sys.executable, '-m', 'pipeline_worker'],
                cwd=ROOT,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            assert process.stdin is not None
            assert process.stdout is not None
            request = {
                'id': 'unicode-lines',
                'method': 'runStage',
                'params': {
                    'jobId': 'job-unicode-lines',
                    'stage': 'lines',
                    'inputPath': str(parse_directory),
                    'outputDir': str(output_directory),
                    'options': {'stageKey': 'unicode-lines-test'},
                },
            }
            process.stdin.write(json.dumps(request, ensure_ascii=True).encode('ascii') + b'\n')
            process.stdin.flush()
            while True:
                response = json.loads(process.stdout.readline().decode('ascii'))
                if response.get('id') == 'unicode-lines':
                    break
            self.assertTrue(response['ok'], response)
            self.assertTrue((output_io_directory / 'lines.jsonl').is_file())

            process.stdin.write(json.dumps({'id': 'shutdown', 'method': 'shutdown', 'params': {}}).encode('ascii') + b'\n')
            process.stdin.flush()
            shutdown = json.loads(process.stdout.readline().decode('ascii'))
            self.assertTrue(shutdown['ok'])
            process.wait(timeout=5)
            process.stdin.close()
            process.stdout.close()
            process.stderr.close()
        finally:
            if process is not None and process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            shutil.rmtree(extended_path(temporary_root), ignore_errors=True)


if __name__ == '__main__':
    unittest.main()
