import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createPackage } from '@electron/asar';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const staging = path.join(root, '.staging', 'installer');
const output = path.join(root, 'release');
await fs.mkdir(staging, { recursive: true });
await fs.mkdir(output, { recursive: true });
const shim = path.join(staging, 'shim');
await fs.mkdir(shim, { recursive: true });
await fs.writeFile(path.join(shim, 'package.json'), JSON.stringify({ name: 'Lolka', version: '1.0.120', main: 'index.js' }));
// The distribution contains only the loader. Original vendor code stays on the user's machine.
await fs.writeFile(path.join(shim, 'index.js'), `const path = require('path');
const fs = require('fs');
const electron = require('electron');
const modDir = path.join(process.resourcesPath, 'lolkamod');
const config = JSON.parse(fs.readFileSync(path.join(modDir, 'config.json')));
const original = path.join(process.resourcesPath, '_app.asar');
try {
  if (process.argv.includes('--lolkamod-disable') && !config.testMode) {
    electron.app.setAppPath(original);
    electron.app.getVersion = () => JSON.parse(fs.readFileSync(path.join(original, 'package.json'))).version;
    require(path.join(original, config.hostMain || 'dist-js/main.js'));
  } else { require(path.join(modDir, 'main.cjs')); }
} catch (error) {
  if (config.testMode) { fs.writeFileSync(path.join(modDir, 'bootstrap-error.txt'), String(error.stack)); electron.app.exit(1); }
  else { throw error; }
}
`);
const payloadDir = path.join(staging, 'payload');
await fs.mkdir(payloadDir, { recursive: true });
for (const file of ['main.cjs', 'preload.js', 'build.json']) await fs.copyFile(path.join(root, 'dist', file), path.join(payloadDir, file));
await createPackage(shim, path.join(payloadDir, 'shim.asar'));
const zipPath = path.join(staging, 'payload.zip');
const run = promisify(execFile);
await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  'Add-Type -AssemblyName System.IO.Compression.FileSystem; if (Test-Path -LiteralPath $env:LM_PAYLOAD_ZIP) { Remove-Item -LiteralPath $env:LM_PAYLOAD_ZIP }; [IO.Compression.ZipFile]::CreateFromDirectory($env:LM_PAYLOAD_DIR, $env:LM_PAYLOAD_ZIP)'],
  { windowsHide: true, env: { ...process.env, LM_PAYLOAD_DIR: payloadDir, LM_PAYLOAD_ZIP: zipPath } });
const payloadHash = crypto.createHash('sha256').update(await fs.readFile(zipPath)).digest('hex');
const integrity = path.join(staging, 'PayloadIntegrity.cs');
await fs.writeFile(integrity, `namespace LolkaModInstaller { internal static class PayloadIntegrity { internal const string Sha256 = "${payloadHash}"; } }\n`);
const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const exe = path.join(output, `LolkaModInstaller-${pkg.version}.exe`);
const source = ['Program.cs', 'InstallerBackend.cs', 'MainForm.cs'].map(f => path.join(root, 'Installer', f));
await run(compiler, ['/nologo', '/target:winexe', '/platform:x64', '/optimize+', `/out:${exe}`,
  '/r:System.dll', '/r:System.Core.dll', '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll', '/r:System.Web.Extensions.dll',
  '/r:System.IO.Compression.dll', '/r:System.IO.Compression.FileSystem.dll', `/resource:${zipPath},LolkaMod.Payload.zip`, ...source, integrity], { windowsHide: true });
const bytes = await fs.readFile(exe);
const hash = crypto.createHash('sha256').update(bytes).digest('hex');
await fs.writeFile(path.join(output, `LolkaModInstaller-${pkg.version}.sha256`), `${hash}  ${path.basename(exe)}\n`);
console.log(JSON.stringify({ installer: exe, bytes: bytes.length, sha256: hash, payloadHash }));
