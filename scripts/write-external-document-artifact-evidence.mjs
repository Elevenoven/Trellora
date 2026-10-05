import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

// Record concrete local candidates and verify the code shipped inside each archive.
const require=createRequire(import.meta.url);
const asar=require(require.resolve('@electron/asar',{paths:[require.resolve('electron-builder')]}));
const config=JSON.parse(await fs.readFile('package.json','utf8'));
const output=config.build.directories.output;
const evidence=path.resolve('docs/verification/external-documents');
const sum=bytes=>createHash('sha256').update(bytes).digest('hex');
const digest=async file=>{const hash=createHash('sha256');for await(const bytes of createReadStream(file))hash.update(bytes);return hash.digest('hex');};
const files=['dist-electron/main.js','dist-electron/preload.js','dist/index.html',...(await fs.readdir('dist/assets')).filter(name=>/^index-.*\.js$/.test(name)).map(name=>`dist/assets/${name}`)];
const archives=[`${output}/win-unpacked/resources/app.asar`,...['v1','v2'].map(version=>`output/verification/external-document-package/${version}/win-unpacked/resources/app.asar`)];
const packages=[];
for(const archive of archives){const entries=[];for(const file of files){const localSha256=sum(await fs.readFile(file)),packagedSha256=sum(asar.extractFile(archive,path.normalize(file)));assert.equal(packagedSha256,localSha256,`${archive}: ${file}`);entries.push({file,localSha256,packagedSha256});}packages.push({archive,matched:true,files:entries});}
const staging=path.resolve('.package-staging');await fs.mkdir(staging,{recursive:true});
const temporary=await fs.mkdtemp(path.join(staging,'external-artifact-payload-'));
try{
  const sevenZip=require(require.resolve('7zip-bin',{paths:[require.resolve('electron-builder')]})).path7za;
  for(const target of ['portable','setup']){
    const executable=`${output}/${config.build.productName}-${config.version}-${target}-x64.exe`,directory=path.join(temporary,target);
    execFileSync(sevenZip,['x',executable,'resources\\app.asar',`-o${directory}`,'-y'],{windowsHide:true,stdio:'ignore'});
    const archive=path.join(directory,'resources/app.asar'),entries=[];
    for(const file of files){const localSha256=sum(await fs.readFile(file)),packagedSha256=sum(asar.extractFile(archive,path.normalize(file)));assert.equal(packagedSha256,localSha256,`${executable}: ${file}`);entries.push({file,localSha256,packagedSha256});}
    packages.push({archive:`${executable} > resources/app.asar`,matched:true,files:entries});
  }
}finally{assert.equal(path.dirname(temporary),staging);await fs.rm(temporary,{recursive:true,force:true,maxRetries:10,retryDelay:250});}
const artifacts=[];
for(const file of [`${output}/${config.build.productName}-${config.version}-portable-x64.exe`,`${output}/${config.build.productName}-${config.version}-setup-x64.exe`,'output/verification/external-document-package/v1/Trellora External Acceptance-1.0.0-setup-x64.exe','output/verification/external-document-package/v2/Trellora External Acceptance-1.0.1-setup-x64.exe']){
  const signature=JSON.parse(execFileSync('pwsh.exe',['-NoProfile','-NonInteractive','-File',path.resolve('scripts/read-release-signature.ps1'),path.resolve(file)],{encoding:'utf8',windowsHide:true}));
  artifacts.push({path:file,byteLength:(await fs.stat(file)).size,sha256:await digest(file),signature});
}
await fs.mkdir(evidence,{recursive:true});
await fs.writeFile(path.join(evidence,'package-source.json'),JSON.stringify({date:new Date().toISOString(),matched:true,packages},null,2));
await fs.writeFile(path.join(evidence,'artifacts.json'),JSON.stringify({date:new Date().toISOString(),sourceSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),requiresCurrentDirtyWorktree:true,publicRelease:false,cleanMachine:false,artifacts},null,2));
console.log('Production and isolated acceptance main/preload/frontend hashes match; four local candidate hashes recorded.');
