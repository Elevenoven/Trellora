import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { releasePaths } from './release-paths.mjs';

const rootDir = process.cwd();
const { manifest: application, artifactName, unpacked: packageDirectory } = releasePaths(rootDir, process.argv[2] || process.env.MENGHAN_PORTABLE_UNPACKED);
const resourcesDirectory = path.join(packageDirectory, 'resources');
const runtimeDirectory = path.join(resourcesDirectory, 'pipeline-runtime');

assert.ok(existsSync(packageDirectory), `portable 解包目录不存在：${packageDirectory}`);
assert.ok(existsSync(path.join(resourcesDirectory, 'app.asar')), 'portable 包缺少 resources/app.asar');
assert.ok(statSync(path.join(resourcesDirectory, 'app.asar')).size > 0, 'app.asar 为空');
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('electron-builder'));
const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib'));
const asar = appBuilderRequire('@electron/asar');
const bundled = JSON.parse(asar.extractFile(path.join(resourcesDirectory, 'app.asar'), 'package.json').toString('utf8'));
assert.equal(bundled.version, application.version, '解包产物版本过期，请重新构建');
assert.equal(bundled.name, application.name, '解包产物品牌过期');
assert.ok(existsSync(path.join(packageDirectory, `${application.build.productName}.exe`)), '缺少当前品牌主程序');
for (const worker of ['mammothWorker.js', 'noteIndexWorker.js']) {
  assert.ok(existsSync(path.join(resourcesDirectory, 'app.asar.unpacked', 'dist-electron', worker)), `缺少解包 Worker：${worker}`);
}
assert.ok(asar.extractFile(path.join(resourcesDirectory, 'app.asar'), 'dist-electron/pdf.worker.mjs').length > 0, '缺少 PDF Worker');
assert.ok(existsSync(path.join(resourcesDirectory, 'builtin-skills')), '缺少内置技能');
assert.ok(existsSync(path.join(resourcesDirectory, 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')), 'portable 包缺少 better-sqlite3 原生模块');
assert.ok(existsSync(path.join(resourcesDirectory, 'app.asar.unpacked', 'node_modules', 'sqlite-vec-windows-x64', 'vec0.dll')), 'portable 包缺少 sqlite-vec 原生模块');
assert.ok(existsSync(path.join(runtimeDirectory, 'python-worker.exe')), 'portable 包缺少嵌入式 Python Worker');
const manifest = JSON.parse(readFileSync(path.join(runtimeDirectory, 'runtime-manifest.json'), 'utf8'));
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.worker.protocolVersion, 1);
assert.ok(manifest.worker.capabilities.includes('runStage:chunks-v2'));

const worker = path.join(runtimeDirectory, 'python-worker.exe');
const handshake = spawnSync(worker, ['-E', '-m', 'pipeline_worker'], {
  cwd: runtimeDirectory,
  input: `${JSON.stringify({ id: 'portable-hello', method: 'hello', params: { protocolVersion: 1 } })}\n${JSON.stringify({ id: 'portable-shutdown', method: 'shutdown', params: {} })}\n`,
  encoding: 'utf8',
  windowsHide: true,
  timeout: 90_000,
  env: { ...process.env, PYTHONHOME: '', PYTHONPATH: '', PATH: `${process.env.SystemRoot}/System32;${process.env.SystemRoot}` },
});
if (handshake.error) throw handshake.error;
assert.equal(handshake.status, 0, `portable Worker 退出失败：${handshake.stderr}`);
const messages = handshake.stdout.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
const hello = messages.find((message) => message.id === 'portable-hello');
const shutdown = messages.find((message) => message.id === 'portable-shutdown');
assert.equal(hello?.ok, true, `portable Worker hello 失败：${handshake.stdout}${handshake.stderr}`);
assert.equal(hello.protocolVersion, 1);
assert.equal(hello.engineVersion, 'p5');
assert.equal(shutdown?.ok, true, 'portable Worker 未优雅关闭');

assert.ok(existsSync(path.join(path.dirname(packageDirectory), artifactName)), `未找到当前版本 portable：${artifactName}；当前仅完成解包目录验收`);

console.log(`verify-portable-package: ${packageDirectory} 的 app.asar、better-sqlite3、sqlite-vec、嵌入式 Worker 握手和 portable exe 结构通过`);
