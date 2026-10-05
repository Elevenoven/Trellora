import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { releasePaths } from './release-paths.mjs';

const root = process.cwd();
const { manifest, output, artifactName } = releasePaths(root);
const artifact = path.join(output, artifactName);
if (!existsSync(artifact)) throw new Error(`当前版本分发包不存在：${artifact}`);
const digest = createHash('sha256');
for await (const chunk of createReadStream(artifact)) digest.update(chunk);
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
const signature = JSON.parse(execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(root, 'scripts/read-release-signature.ps1'), artifact], { encoding: 'utf8', windowsHide: true }));
const runtime = JSON.parse(readFileSync(path.join(output, 'win-unpacked/resources/pipeline-runtime/runtime-manifest.json'), 'utf8'));
const report = { schemaVersion: 1, appVersion: manifest.version, productName: manifest.build.productName,
  sourceSha: git('rev-parse', 'HEAD'), branch: git('branch', '--show-current'), worktree: git('status', '--short').split(/\r?\n/).filter(Boolean),
  createdAt: new Date().toISOString(), nodeVersion: process.version, runtime,
  artifacts: [{ name: artifactName, byteLength: statSync(artifact).size, sha256: digest.digest('hex'), signature }] };
writeFileSync(path.join(output, 'release-manifest.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`release manifest: ${path.join(output, 'release-manifest.json')}; ${signature.status}`);
