import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { releasePaths } from './release-paths.mjs';

const root = process.cwd();
const { manifest, output, artifactName } = releasePaths(root);
const artifact = path.join(output, artifactName);
if (!existsSync(artifact)) throw new Error(`当前版本分发包不存在：${artifact}`);
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
const artifactNames = [artifactName, `${manifest.build.productName}-${manifest.version}-setup-x64.exe`].filter(name => existsSync(path.join(output, name)));
// 便携版与安装版共用发行清单，分别记录真实文件的大小、哈希和签名状态。
const artifacts = [];
for (const name of artifactNames) {
  const file = path.join(output, name), digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  const signature = JSON.parse(execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(root, 'scripts/read-release-signature.ps1'), file], { encoding: 'utf8', windowsHide: true }));
  artifacts.push({ name, byteLength: statSync(file).size, sha256: digest.digest('hex'), signature });
}
const runtime = JSON.parse(readFileSync(path.join(output, 'win-unpacked/resources/pipeline-runtime/runtime-manifest.json'), 'utf8'));
const report = { schemaVersion: 1, appVersion: manifest.version, productName: manifest.build.productName,
  sourceSha: git('rev-parse', 'HEAD'), repositoryUrl: manifest.homepage,
  createdAt: new Date().toISOString(), nodeVersion: process.version, runtime,
  artifacts };
writeFileSync(path.join(output, 'release-manifest.json'), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(path.join(output, 'SHA256SUMS.txt'), artifacts.map(item => `${item.sha256}  ${item.name}\n`).join(''));
console.log(`release manifest: ${path.join(output, 'release-manifest.json')}; ${artifacts.map(item => `${item.name}: ${item.signature.status}`).join(', ')}`);
