import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { launchNoteTest, command, waitFor } from './electron-note-test-session.mjs';
const root=path.resolve('output/verification/external-document-package'),fixture=await fs.mkdtemp(path.join(os.tmpdir(),'trellora-nsis-acceptance-'));
const install=path.join(fixture,'installed'),userData=path.join(fixture,'user-data'),progId='com.trellora.acceptance.external.Text',appId='com.trellora.acceptance.external';
const exe=path.join(install,'Trellora External Acceptance.exe'),uninstaller=path.join(install,'Uninstall Trellora External Acceptance.exe');
const v1=path.join(root,'v1/Trellora External Acceptance-1.0.0-setup-x64.exe'),v2=path.join(root,'v2/Trellora External Acceptance-1.0.1-setup-x64.exe');
const helperRoot=path.join(fixture,'powershell');await fs.mkdir(helperRoot);
// PowerShell 5 C# compilation needs writable TMP; use files to retain quotes/Unicode.
const helperEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!['psmodulepath','temp','tmp'].includes(key.toLowerCase())));
helperEnv.TEMP=helperRoot;helperEnv.TMP=helperRoot;
helperEnv.TRELLORA_ACCEPTANCE_PROFILE=userData;
const previousProfile=process.env.TRELLORA_ACCEPTANCE_PROFILE;process.env.TRELLORA_ACCEPTANCE_PROFILE=userData;
const powershellExe=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe').split(path.sep).join('/');
let session,ownedProfile=false,installed=false;const checks=[];
const defaultProfiles=['trellora-external-acceptance','Trellora External Acceptance'].map(name=>path.join(process.env.APPDATA,name));const ownedDefaultProfiles=[];let nativePickerPassed=false;
const pending=[];
const snapshotScript=String.raw`$result=@{}; foreach($ext in @('md','markdown','txt')) { $key=Get-Item -LiteralPath ('HKCU:\Software\Classes\.'+$ext) -ErrorAction SilentlyContinue; $choice=Get-Item -LiteralPath ('HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.'+$ext+'\UserChoice') -ErrorAction SilentlyContinue; $result[$ext]=@{default=$(if($key){$key.GetValue('')}else{$null}); choice=$(if($choice){@{ProgId=$choice.GetValue('ProgId');Hash=$choice.GetValue('Hash')}}else{$null})}; }; $result | ConvertTo-Json -Compress -Depth 6`;
try {
  assert.equal(await exists(userData),false,'isolated acceptance profile already exists; refusing to overwrite');
  assert.equal(await powershell(`Test-Path -LiteralPath ${ps('HKCU:\\Software\\Classes\\'+progId)}`),false,'acceptance registration already exists');
  for(const profile of defaultProfiles){assert.equal(await exists(profile),false,'acceptance default profile already exists');await fs.mkdir(profile);ownedDefaultProfiles.push(profile);await fs.writeFile(path.join(profile,'uninstall-sentinel.txt'),'preserve private user data');}
  const defaults=await powershell(snapshotScript);await fs.mkdir(userData);ownedProfile=true;
  const source=path.join(fixture,'右键打开 中文 空格.md');await fs.writeFile(source,'# 系统打开\n中文与空格路径');
  await fs.writeFile(path.join(userData,'config.json'),JSON.stringify({workspacePath:path.join(fixture,'workspace'),onboarding:{version:1,status:'skipped'},appPreferences:{defaultEditorMode:'source'}}));
  await command(v1,['/S','/currentuser',`/D=${install}`]);installed=true;await waitFor(()=>exists(exe),'installed executable');
  assert.deepEqual(await powershell(snapshotScript),defaults);
  const expected=`"${exe}" "%1"`;const registration=await inspect();assert.equal(registration.command,expected);assert.deepEqual(registration.extensions,['md','markdown','txt']);assert.equal(registration.registered,true);record('real NSIS per-user install adds three optional types and quoted command; defaults and UserChoice unchanged');
  session=await launchNoteTest({executablePath:exe,userData,args:[]});await session.send('Emulation.setFocusEmulationEnabled',{enabled:true});
  await powershell(`Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class ExternalShell { [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct Info { public int size; public uint mask; public IntPtr hwnd; public string verb; public string file; public string parameters; public string directory; public int show; public IntPtr instance; public IntPtr idList; public string className; public IntPtr classKey; public uint hotKey; public IntPtr icon; public IntPtr process; } [DllImport("shell32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool ShellExecuteEx(ref Info info); public static bool Open(string file,string className) { var info=new Info { size=Marshal.SizeOf(typeof(Info)),mask=1,verb="open",file=file,className=className,show=1 };return ShellExecuteEx(ref info); } }
'@
if(-not [ExternalShell]::Open(${ps(source)},'${progId}')){throw 'Registered ShellExecuteEx failed'}; 'true'`);
  await waitFor(()=>session.evaluate(`document.querySelector('.external-document-name p:last-child')?.textContent?.toLowerCase()===${JSON.stringify(source.toLowerCase())}`),'Windows registered open command delivered');assert.equal(await fs.readFile(source,'utf8'),'# 系统打开\n中文与空格路径');
  const {data}=await session.send('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.resolve('docs/verification/external-documents/installed-shell.png'),Buffer.from(data,'base64'));record('actual Windows ShellExecuteEx resolves registered ProgID and opens Chinese-space file in running packaged app');
  const chooserSource=path.join(fixture,'打开方式 第二份.txt');await fs.writeFile(chooserSource,'原生打开方式选择验收');
  try{
    await runPowerShellFile(path.resolve('scripts/windows-open-with-acceptance.ps1'),['-File',chooserSource,'-AppName','Trellora External Acceptance','-EvidencePath',path.resolve('docs/verification/external-documents/windows-open-with.png')]);
    await waitFor(()=>session.evaluate(`document.querySelector('.external-document-name p:last-child')?.textContent?.toLowerCase()===${JSON.stringify(chooserSource.toLowerCase())}`),'actual Open With selection opens file');nativePickerPassed=true;record('real Windows Open With dialog lists installed app; native selection opens TXT once without changing defaults');
  }catch{pending.push('Native Open With app selection not verified: host provided an empty interim picker window without actionable app controls. Verify on clean Windows.');console.log('PENDING native Windows Open With selection; continuing installation lifecycle checks');}
  assert.deepEqual(await powershell(snapshotScript),defaults);
  await session.evaluate("document.querySelector('.external-document .cm-content').focus()");
  for(const type of ['rawKeyDown','keyUp'])await session.send('Input.dispatchKeyEvent',{type,key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});
  await session.send('Input.insertText',{text:'升级前保留的未保存草稿'});
  await waitFor(()=>session.evaluate("window.electronAPI.listDocumentRecovery().then(x=>x.length>0)"),'private recovery before upgrade');
  const recoveries=await session.evaluate('window.electronAPI.listDocumentRecovery()');const recoveryFile=path.join(userData,'external-documents',`${recoveries[0].recoveryId}.json`);
  await waitFor(async()=>JSON.parse(await fs.readFile(recoveryFile,'utf8')).content==='升级前保留的未保存草稿','latest source draft persisted');
  await session.dispose();session=undefined;
  const recoveryBefore=hash(await fs.readFile(recoveryFile));assert.equal(JSON.parse(await fs.readFile(recoveryFile,'utf8')).content,'升级前保留的未保存草稿');
  await fs.writeFile(path.join(userData,'upgrade-sentinel.txt'),'preserve private recovery and settings');const configBefore=hash(await fs.readFile(path.join(userData,'config.json')));
  await command(v2,['/S','/currentuser',`/D=${install}`]);await waitFor(()=>exists(exe),'upgraded executable');assert.deepEqual(await powershell(snapshotScript),defaults);assert.equal((await inspect()).command,expected);assert.equal(await fs.readFile(path.join(userData,'upgrade-sentinel.txt'),'utf8'),'preserve private recovery and settings');assert.equal(hash(await fs.readFile(path.join(userData,'config.json'))),configBefore);
  assert.equal(hash(await fs.readFile(recoveryFile)),recoveryBefore);
  const version=await powershell(`(Get-Item -LiteralPath ${ps(exe)}).VersionInfo.ProductVersion | ConvertTo-Json -Compress`);assert.ok(String(version).startsWith('1.0.1'));record('real 1.0.0 to 1.0.1 upgrade preserves settings and private data and refreshes optional registration');
  await command(uninstaller,['/S','/currentuser']);await waitFor(async()=>!(await exists(exe)),'uninstalled executable');installed=false;
  const removed=await inspect();assert.equal(removed.command,null);assert.equal(removed.registered,false);assert.deepEqual(removed.extensions,[]);assert.deepEqual(await powershell(snapshotScript),defaults);assert.equal(await fs.readFile(path.join(userData,'upgrade-sentinel.txt'),'utf8'),'preserve private recovery and settings');record('real uninstall removes owned optional registration and preserves defaults, UserChoice and user data');
  for(const profile of defaultProfiles)assert.equal(await fs.readFile(path.join(profile,'uninstall-sentinel.txt'),'utf8'),'preserve private user data');assert.equal(hash(await fs.readFile(recoveryFile)),recoveryBefore);
  await fs.writeFile(path.resolve('docs/verification/external-documents/installer.json'),JSON.stringify({date:new Date().toISOString(),electronBuilder:'24.13.3',packaged:true,cleanMachine:false,identity:'isolated acceptance appId/name; production main/preload and NSIS macros; separate entry redirects userData to a temporary directory because host APPDATA same-directory rename fails EXDEV',checks,pending,allPassed:pending.length===0,actualRecoverySurvivesUpgrade:true,defaultAppDataSentinelsSurviveUninstall:true,artifacts:{v1:{path:path.relative(process.cwd(),v1),sha256:hash(await fs.readFile(v1))},v2:{path:path.relative(process.cwd(),v2),sha256:hash(await fs.readFile(v2))}},nativeOpenWithDialog:nativePickerPassed,interactiveExplorerRightClick:false,userSelectedDefaultDoubleClick:false},null,2));
  if(pending.length)process.exitCode=1;
}catch(error){console.error(error,session?.diagnostics());if(session)console.error(await session.evaluate('window.electronAPI.listDocumentOpenRequests().then(pending=>JSON.stringify({body:document.body.innerText.slice(0,3500),pending}))').catch(String));throw error;}
finally{await session?.dispose();if(installed&&await exists(uninstaller))await command(uninstaller,['/S','/currentuser']).catch(()=>undefined);if(previousProfile===undefined)delete process.env.TRELLORA_ACCEPTANCE_PROFILE;else process.env.TRELLORA_ACCEPTANCE_PROFILE=previousProfile;for(const profile of ownedDefaultProfiles){assert.equal(path.dirname(profile),path.resolve(process.env.APPDATA));assert.ok(defaultProfiles.includes(profile));await fs.rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:250});}if(ownedProfile){assert.equal(path.dirname(userData),fixture);await fs.rm(userData,{recursive:true,force:true,maxRetries:10,retryDelay:250});}assert.equal(path.dirname(fixture),path.resolve(os.tmpdir()));await fs.rm(fixture,{recursive:true,force:true,maxRetries:10,retryDelay:250});}
function ps(value){return `'${value.replaceAll("'","''")}'`;}
function hash(bytes){return createHash('sha256').update(bytes).digest('hex');}
function record(text){checks.push(text);console.log(`PASS ${text}`);}
async function exists(file){try{await fs.access(file);return true;}catch{return false;}}
async function powershell(script){
  const file=path.join(helperRoot,`${checks.length}-${Date.now()}.ps1`);
  await fs.writeFile(file,'\uFEFF$ErrorActionPreference = \'Stop\'\n[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)\n'+script);
  try { const value=(await runPowerShellFile(file)).trim();try{return JSON.parse(value);}catch{if(/^False$/i.test(value))return false;if(/^True$/i.test(value))return true;throw new Error('Unexpected registry reply: '+value);} }
  finally { await fs.rm(file,{force:true}); }
}
function runPowerShellFile(file,args=[]){return new Promise((resolve,reject)=>{const child=spawn(powershellExe,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',file,...args],{env:helperEnv,windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.once('error',reject);child.once('exit',code=>code===0?resolve(out):reject(new Error(`Windows PowerShell exit ${code}: ${err || out}; script ${file}`)));});}
function inspect(){return powershell(String.raw`$key=Get-Item -LiteralPath ${ps('HKCU:\\Software\\Classes\\'+progId+'\\shell\\open\\command')} -ErrorAction SilentlyContinue;$exts=@();foreach($ext in @('md','markdown','txt')){$item=Get-Item -LiteralPath ('HKCU:\Software\Classes\.'+$ext+'\OpenWithProgids') -ErrorAction SilentlyContinue;if($item -and ($item.GetValueNames() -contains '${progId}')){$exts+=$ext}};$registeredKey=Get-Item -LiteralPath 'HKCU:\Software\RegisteredApplications' -ErrorAction SilentlyContinue;$registered=$registeredKey -and ($registeredKey.GetValueNames() -contains '${appId}');@{command=$(if($key){$key.GetValue('')}else{$null});extensions=@($exts);registered=[bool]$registered}|ConvertTo-Json -Compress -Depth 4`);}
