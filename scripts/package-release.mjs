import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const pkg = JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
const stage = await fs.mkdtemp(path.join(root,'.staging','release-'));
const output = path.join(root,'release');
await fs.mkdir(output,{recursive:true});
const copy = async (relative,target) => {
  const source = path.join(root,relative);
  const stat = await fs.lstat(source);
  if(stat.isSymbolicLink()) throw new Error('Refusing linked source: '+relative);
  if(stat.isDirectory()) {
    await fs.mkdir(target,{recursive:true});
    for(const file of await fs.readdir(source)) await copy(path.join(relative,file),path.join(target,file));
  } else { await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(source,target); }
};
const run = promisify(execFile);
async function zip(dir,file) {
  await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem; if (Test-Path -LiteralPath $env:LM_RELEASE_ZIP) { Remove-Item -LiteralPath $env:LM_RELEASE_ZIP }; [IO.Compression.ZipFile]::CreateFromDirectory($env:LM_RELEASE_DIR, $env:LM_RELEASE_ZIP)'],
    {windowsHide:true,env:{...process.env,LM_RELEASE_DIR:dir,LM_RELEASE_ZIP:file}});
}
try {
  const windows = path.join(stage,'Windows');
  const source = path.join(stage,'LolkaMod');
  for(const file of ['README.md','LICENSE','THIRD_PARTY_NOTICES.md','docs/stream-test.md',`release/LolkaModInstaller-${pkg.version}.exe`,`release/LolkaModInstaller-${pkg.version}.sha256`]) {
    const relative=file.startsWith('release/')?path.basename(file):file;
    await copy(file,path.join(windows,relative));
  }
  // Explicit public allowlist excludes research, profiles, vendor code, local paths and agent instructions.
  for(const file of ['src','Installer','tests','scripts','.github','.gitignore','.gitattributes','README.md','LICENSE','THIRD_PARTY_NOTICES.md','docs','package.json','package-lock.json','tsconfig.json']) {
    if(file==='scripts') {
      await fs.mkdir(path.join(source,file),{recursive:true});
      for(const name of ['build.mjs','build-installer.mjs','package-release.mjs','fetch-frontend.mjs','install.mjs','restore-desktop.ps1']) await copy(`scripts/${name}`,path.join(source,file,name));
    } else await copy(file,path.join(source,file));
  }
  const artifacts=[`LolkaMod-${pkg.version}-Windows.zip`,`LolkaMod-${pkg.version}-Source.zip`];
  await zip(windows,path.join(output,artifacts[0]));await zip(source,path.join(output,artifacts[1]));
  const entries=[];
  for(const file of artifacts) {
    const bytes=await fs.readFile(path.join(output,file));
    entries.push({file,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
  }
  await fs.writeFile(path.join(output,'release-manifest.json'),JSON.stringify({version:pkg.version,experimental:true,artifacts:entries},null,2));
  console.log(JSON.stringify(entries));
} finally {
  if(path.dirname(stage)!==path.join(root,'.staging'))throw new Error('Unsafe stage cleanup');
  await fs.rm(stage,{recursive:true,force:true});
}
