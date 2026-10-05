import fs from 'node:fs/promises';
import path from 'node:path';
import { command } from './electron-note-test-session.mjs';
const staging=path.resolve('.package-staging');await fs.mkdir(staging,{recursive:true});const temporary=await fs.mkdtemp(path.join(staging,'external-acceptance-config-'));
const base=JSON.parse(await fs.readFile('package.json','utf8')).build;
try {
  // Only the acceptance entry redirects private state; production main stays identical.
  const entry=path.join(temporary,'external-acceptance-main.js');
  await fs.writeFile(entry,"const {app}=require('electron');if(!process.env.TRELLORA_ACCEPTANCE_PROFILE)throw new Error('Isolated acceptance profile is required');app.setPath('userData',process.env.TRELLORA_ACCEPTANCE_PROFILE);require('./dist-electron/main.js');\n");
  for(const [directory,version] of [['v1','1.0.0'],['v2','1.0.1']]) {
    const config=path.join(temporary,`${directory}.json`);
    await fs.writeFile(config,JSON.stringify({...base,files:[...base.files,{from:temporary,to:'.',filter:['external-acceptance-main.js']}],appId:'com.trellora.acceptance.external',productName:'Trellora External Acceptance',extraMetadata:{name:'trellora-external-acceptance',version,main:'external-acceptance-main.js'},directories:{...base.directories,output:path.resolve('output/verification/external-document-package',directory)},win:{...base.win,target:[{target:'nsis',arch:['x64']}]},nsis:{...base.nsis,runAfterFinish:false,createDesktopShortcut:false,createStartMenuShortcut:false}},null,2));
    console.log(`Building isolated Windows acceptance ${version}`);
    await command(process.execPath,['scripts/build-windows-packages.mjs','--config',config,'--win','nsis']);
  }
}finally{assertStaging();await fs.rm(temporary,{recursive:true,force:true,maxRetries:10,retryDelay:250});}
function assertStaging(){if(path.dirname(temporary)!==staging)throw new Error('Acceptance config escaped staging');}
