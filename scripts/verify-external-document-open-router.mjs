import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const staging=path.resolve('.package-staging');await fs.mkdir(staging,{recursive:true});const temporary=await fs.mkdtemp(path.join(staging,'open-router-'));
try{
  await build({entryPoints:['electron/documents/openRequestRouter.ts'],outfile:path.join(temporary,'router.cjs'),bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
  const {parseDocumentArguments,OpenRequestRouter}=createRequire(import.meta.url)(path.join(temporary,'router.cjs'));
  const cwd=path.resolve('C:/Chinese space'), first=path.join(cwd,'中文 空格.md'), second=path.join(cwd,'另一份.txt');
  assert.deepEqual(parseDocumentArguments(['electron.exe','app/main.js','--user-data-dir','not-a-document.md','--remote-debugging-port=9222','--profile-directory','profile.txt','--disable-gpu','中文 空格.md','--','另一份.txt'],cwd,false),[first,second]);
  assert.deepEqual(parseDocumentArguments(['Trellora.exe','--unknown-option','value.md','中文 空格.md'],cwd,true),[first]);
  const queued=[], pending=new Map();let changed=0;
  const router=new OpenRequestRouter({enqueue:async file=>{if(file.endsWith('missing.txt'))throw new Error('missing fixture');const key=file.toLowerCase();if(!pending.has(key)){const request={requestId:String(pending.size),displayPath:file};pending.set(key,request);queued.push(file);}return pending.get(key);},changed:()=>changed++});
  router.collect(['Trellora.exe',first,first,second],cwd,true);await router.flush();assert.equal(queued.length,0);
  router.start();await router.flush();assert.deepEqual(queued,[first,second]);
  router.collect(['Trellora.exe',first,path.join(cwd,'missing.txt'),path.join(cwd,'第三份.md')],cwd,true);await router.flush();assert.equal(queued.length,3);assert.equal(router.takeFailures().length,1);assert.equal(router.takeFailures().length,0);
  assert.equal((await router.submit([first]))[0].displayPath,first);assert.ok(changed>=2);
  await fs.writeFile(path.resolve('docs/verification/external-documents/open-router.json'),JSON.stringify({date:new Date().toISOString(),checks:['development entry and switch values excluded','relative Chinese-space paths use sender cwd','startup requests retained until service ready','stable ordered dedup and per-file failure isolation','picker/system/drop router share enqueue boundary']},null,2));console.log('Open router contracts passed.');
}finally{assert.equal(path.dirname(temporary),staging);await fs.rm(temporary,{recursive:true,force:true});}
