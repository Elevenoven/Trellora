import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDirectory = path.join(rootDir, 'pipeline-python');
const dependenciesDirectory = path.join(sourceDirectory, '.deps');
const workerPackageDirectory = path.join(sourceDirectory, 'pipeline_worker');
const runtimeDirectory = path.join(rootDir, 'build', 'pipeline-runtime');

assertDirectory(sourceDirectory, 'Python Worker 源码目录');
assertDirectory(dependenciesDirectory, 'Python Worker 依赖目录');
assertDirectory(workerPackageDirectory, 'Python Worker 包目录');
assertDirectory(path.join(dependenciesDirectory, 'jieba'), 'Jieba 依赖');

const pythonExecutable = resolvePythonExecutable();
const pythonHome = path.dirname(pythonExecutable);
assertDirectory(pythonHome, 'Python 运行时目录');
const probe = probePythonRuntime(pythonExecutable);
const pythonDllName = `python${probe.version.major}${probe.version.minor}.dll`;
assertFile(path.join(pythonHome, pythonDllName), 'Python 动态库');

resetRuntimeDirectory(runtimeDirectory);
copyPythonRuntime(pythonHome, runtimeDirectory, pythonDllName);
cpSync(workerPackageDirectory, path.join(runtimeDirectory, 'pipeline_worker'), {
  recursive: true,
  filter: (source) => !path.relative(workerPackageDirectory, source).split(path.sep).includes('__pycache__') && !source.endsWith('.pyc'),
});
copyWorkerDependencies(dependenciesDirectory, path.join(runtimeDirectory, '.deps'));
writeRuntimePathFile(runtimeDirectory, pythonDllName);

const hello = verifyWorkerHandshake(runtimeDirectory);
writeJsonAtomically(path.join(runtimeDirectory, 'runtime-manifest.json'), {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  python: {
    implementation: probe.implementation,
    version: probe.version.text,
    executableName: 'python-worker.exe',
    standardLibrary: 'Lib',
    dependencyDirectory: '.deps',
  },
  worker: {
    protocolVersion: hello.protocolVersion,
    engineVersion: hello.engineVersion,
    version: hello.workerVersion,
    jiebaVersion: probe.jiebaVersion,
    capabilities: hello.capabilities,
  },
});

console.log(`pipeline runtime prepared: ${runtimeDirectory}`);

function resolvePythonExecutable() {
  const configured = process.env.MENGHAN_PIPELINE_PYTHON?.trim();
  if (configured) {
    const resolved = path.resolve(configured);
    assertFile(resolved, 'MENGHAN_PIPELINE_PYTHON');
    return resolved;
  }
  // The Windows launcher selects standalone CPython even when Conda comes first in PATH.
  for (const [command, args] of [['py', ['-3', '-c', 'import sys; print(sys.executable)']], ['python', ['-c', 'import sys; print(sys.executable)']]]) {
    try {
      const executable = execFileSync(command, args, { encoding: 'utf8', windowsHide: true }).trim();
      const resolved = path.resolve(executable); assertFile(resolved, '当前 Python 解释器'); return resolved;
    } catch { /* Try the next local interpreter; isolated release verification remains mandatory. */ }
  }
  throw new Error('无法定位用于发布的 CPython x64。请设置 MENGHAN_PIPELINE_PYTHON 指向独立 CPython 的完整 python.exe。');
}

function probePythonRuntime(executable) {
  const program = [
    'import importlib.metadata as metadata, json, platform, sys',
    `sys.path.insert(0, ${JSON.stringify(dependenciesDirectory)})`,
    "import jieba",
    "print(json.dumps({'implementation': platform.python_implementation(), 'version': list(sys.version_info[:3]), 'jiebaVersion': metadata.version('jieba')}))",
  ].join('; ');
  const output = run(executable, ['-E', '-c', program], { cwd: sourceDirectory, timeout: 60_000 });
  let value;
  try {
    value = JSON.parse(output.stdout.trim());
  } catch {
    throw new Error(`Python Worker 依赖探测没有返回有效 JSON：${output.stdout}`);
  }
  if (value.implementation !== 'CPython' || !Array.isArray(value.version) || value.version.length < 2) {
    throw new Error('发布 Worker 必须使用可识别的 CPython 运行时。');
  }
  return {
    implementation: value.implementation,
    version: { major: Number(value.version[0]), minor: Number(value.version[1]), text: value.version.join('.') },
    jiebaVersion: String(value.jiebaVersion),
  };
}

function resetRuntimeDirectory(target) {
  const buildDirectory = path.join(rootDir, 'build');
  const resolvedTarget = path.resolve(target);
  if (!resolvedTarget.startsWith(`${path.resolve(buildDirectory)}${path.sep}`)) throw new Error('拒绝清理 build 目录之外的路径。');
  rmSync(resolvedTarget, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  mkdirSync(resolvedTarget, { recursive: true });
}

function copyPythonRuntime(pythonHome, target, pythonDllName) {
  cpSync(path.join(pythonHome, 'python.exe'), path.join(target, 'python-worker.exe'));
  for (const fileName of [pythonDllName, 'python3.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'LICENSE.txt']) {
    const source = path.join(pythonHome, fileName);
    if (existsSync(source)) cpSync(source, path.join(target, fileName));
  }
  const standardLibrary = path.join(pythonHome, 'Lib');
  assertDirectory(standardLibrary, 'Python Lib 目录');
  // 应用依赖只来自经过验证的 .deps；不复制构建机的 site-packages，避免把
  // 无关的本地包或用户路径带入 portable 包。
  cpSync(standardLibrary, path.join(target, 'Lib'), {
    recursive: true,
    filter: (source) => {
      const parts = path.relative(standardLibrary, source).split(path.sep);
      return !parts.some((part) => ['site-packages', '__pycache__', 'test', 'idlelib', 'tkinter', 'turtledemo', 'ensurepip', 'pydoc_data', 'unittest', 'venv'].includes(part))
        && !source.endsWith('.pyc');
    },
  });
  const dllDirectory = path.join(pythonHome, 'DLLs');
  assertDirectory(dllDirectory, 'Python DLLs 目录');
  cpSync(dllDirectory, path.join(target, 'DLLs'), { recursive: true });
}

function copyWorkerDependencies(source, target) {
  mkdirSync(target, { recursive: true });
  const jiebaSource = path.join(source, 'jieba');
  cpSync(jiebaSource, path.join(target, 'jieba'), {
    recursive: true,
    // The application uses only jieba.Tokenizer. These optional POS/TF-IDF/
    // paddle resources account for most of the package but are never imported.
    filter: (entry) => {
      const parts = path.relative(jiebaSource, entry).split(path.sep);
      return !parts.some((part) => ['__pycache__', 'posseg', 'analyse', 'lac_small'].includes(part))
        && !entry.endsWith('.pyc');
    },
  });
  const metadataDirectory = readdirSync(source).find((name) => /^jieba-[\d.]+\.dist-info$/iu.test(name));
  if (!metadataDirectory) throw new Error('Jieba 版本元数据不存在，请重新安装 pipeline-python/requirements.lock。');
  cpSync(path.join(source, metadataDirectory), path.join(target, metadataDirectory), { recursive: true });
}

function writeRuntimePathFile(target, pythonDllName) {
  const pthName = `${path.basename(pythonDllName, '.dll') }._pth`;
  writeFileSync(path.join(target, pthName), ['.', 'Lib', 'DLLs', '.deps', 'import site', ''].join('\r\n'), 'utf8');
}

function verifyWorkerHandshake(target) {
  const executable = path.join(target, 'python-worker.exe');
  const request = [
    JSON.stringify({ id: 'runtime-hello', method: 'hello', params: { protocolVersion: 1 } }),
    JSON.stringify({ id: 'runtime-shutdown', method: 'shutdown', params: {} }),
    '',
  ].join('\n');
  const result = run(executable, ['-E', '-m', 'pipeline_worker'], { cwd: target, input: request, timeout: 60_000, isolatedRuntime: true });
  const messages = result.stdout.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  const hello = messages.find((message) => message.id === 'runtime-hello');
  const shutdown = messages.find((message) => message.id === 'runtime-shutdown');
  if (!hello?.ok || hello.protocolVersion !== 1 || !Array.isArray(hello.capabilities) || !hello.capabilities.includes('runStage:chunks-v2')) {
    throw new Error('发布 Worker 握手失败，缺少 Parent/Child chunks-v2 能力。');
  }
  if (!shutdown?.ok) throw new Error('发布 Worker 无法优雅关闭。');
  if (hello.capabilities.includes('runStage:parse') || Object.hasOwn(hello, 'doclingVersion')) throw new Error('瘦身后的 Worker 不得再暴露 Docling 解析能力。');
  return hello;
}

function run(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    input: options.input,
    encoding: 'utf8',
    timeout: options.timeout,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, PYTHONHOME: '', PYTHONPATH: '', ...(options.isolatedRuntime ? { PATH: `${process.env.SystemRoot}/System32;${process.env.SystemRoot}` } : {}) },
  });
  if (result.error) throw new Error(`无法启动 ${path.basename(command)}：${result.error.message}`);
  if (result.status !== 0) throw new Error(`${path.basename(command)} 运行失败（${result.status ?? '未知'}）：${result.stderr || result.stdout}`);
  return result;
}

function writeJsonAtomically(target, value) {
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, target);
}

function assertDirectory(target, label) {
  if (!existsSync(target)) throw new Error(`${label}不存在：${target}`);
}

function assertFile(target, label) {
  if (!existsSync(target)) throw new Error(`${label}不存在：${target}`);
}
