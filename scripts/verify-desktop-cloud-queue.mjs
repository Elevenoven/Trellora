import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
const staging = path.resolve('.package-staging'); mkdirSync(staging, { recursive: true });
const root = mkdtempSync(path.join(staging, 'desktop-cloud-'));
try {
  const bundle = path.join(root, 'queue.cjs');
  await build({ stdin: { contents: `
    import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path';
    import { PipelineOrchestrator } from './electron/pipeline/pipelineOrchestrator';
    import { CloudAuthorization } from './electron/pipeline/cloudAuthorization';
    import { importMaterialsDocuments, listMaterialsDocuments } from './electron/materialsLibrary';
    (async()=>{
    const root=process.argv[2], library=path.join(root,'资料库'), source=path.join(root,'本地导入.pdf');
    fs.mkdirSync(library);fs.writeFileSync(source,'%PDF-1.7\\nPDF_BODY_SENTINEL');
    importMaterialsDocuments(library,[source]);let document=listMaterialsDocuments(library)[0];
    let requests=0;globalThis.fetch=async()=>{requests++;throw new Error('Unconsented request');};
    const queue=new PipelineOrchestrator({getMineruConfig:()=>({endpoint:'https://mineru.test/api/v4',apiKey:'KEY_SENTINEL',cloudParsingConsent:true})});
    await queue.enqueuePending(library);assert.equal(queue.getStatus(library,document).error.code,'CLOUD_AUTHORIZATION_REQUIRED');
    await queue.startParse(library,document.id);assert.equal(requests,0);
    new CloudAuthorization().authorize(library,[document]);
    fs.appendFileSync(document.absolutePath,'changed');document=listMaterialsDocuments(library)[0];
    await queue.enqueuePending(library);assert.equal(queue.getStatus(library,document).error.code,'CLOUD_AUTHORIZATION_REQUIRED');assert.equal(requests,0);
    await queue.shutdown();console.log('cloud queue: local import, automatic enqueue, explicit retry and changed-hash authorization cannot upload without consent');
    })().catch(error=>{console.error(error);process.exitCode=1;});
  `, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: bundle, external: ['better-sqlite3'], plugins: [{ name: 'test-electron', setup(build) { build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' })); build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const app={isPackaged:false};', loader: 'js' })); } }] });
  const result = spawnSync(process.execPath, [path.resolve('scripts/run-electron-node.mjs'), bundle, root], { windowsHide: true, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr); console.log(result.stdout.trim());
} finally { assert.ok(root.startsWith(staging + path.sep + 'desktop-cloud-')); rmSync(root, { recursive: true, force: true }); }
