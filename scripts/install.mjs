import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createPackage, extractFile, uncache } from '@electron/asar';
export const SUPPORTED_HASH = 'fd94ecec264d7d7a56a0b5d1bb5ac1e416b6c9a4ee2d171b3704b0b72f0260a8';
export const DEFAULT_INSTALLATION = path.join(process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Local'), 'Programs', 'Lolka');
const workspace = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const hash = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
async function exists(file) { return fs.access(file).then(() => true, () => false); }
async function ensureStopped(root) {
  const executable = path.join(root, 'Lolka.exe');
  if (process.platform !== 'win32' || !await exists(executable)) return;
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "@(Get-CimInstance Win32_Process -Filter \"Name = 'Lolka.exe'\" | Where-Object { $_.ExecutablePath -eq $env:LOLKAMOD_INSTALL_TARGET }).Count"],
    { windowsHide: true, env: { ...process.env, LOLKAMOD_INSTALL_TARGET: executable } });
  if (Number(stdout.trim()) !== 0) throw new Error('Close this Lolka installation before changing its files.');
}
async function replaceArchive(resources, bytes, expectedHash) {
  if (hash(bytes) !== expectedHash) throw new Error('Replacement archive integrity mismatch');
  const temp = path.join(resources, `.lolkamod-entry-${crypto.randomUUID()}.tmp`);
  const handle = await fs.open(temp, 'wx');
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try {
    if (hash(await fs.readFile(temp)) !== expectedHash) throw new Error('Staged archive integrity mismatch');
    await fs.rename(temp, path.join(resources, 'app.asar'));
    uncache(path.join(resources, 'app.asar'));
  } finally { await fs.rm(temp, { force: true }); }
}
async function removeModDir(resources) {
  const modDir = path.join(resources, 'lolkamod');
  if (path.dirname(modDir) !== resources || path.basename(modDir) !== 'lolkamod') throw new Error('Unsafe cleanup target');
  await fs.rm(modDir, { recursive: true, force: true });
}
export async function install(installation, options = {}) {
  if (options.testMode && typeof options.userData !== 'string') throw new Error('testMode requires an explicit separate userData directory');
  const root = path.resolve(installation);
  await ensureStopped(root);
  const resources = path.join(root, 'resources');
  const archive = path.join(resources, 'app.asar');
  const backup = path.join(resources, '_app.asar');
  const modDir = path.join(resources, 'lolkamod');
  const archiveBytes = await fs.readFile(archive);
  if (hash(archiveBytes) !== SUPPORTED_HASH) throw new Error('Unsupported or already modified app.asar. Restore before installing.');
  if (await exists(backup) || await exists(modDir)) throw new Error('Existing backup or mod directory; refusing to overwrite.');
  uncache(archive);
  const host = JSON.parse(extractFile(archive, 'package.json').toString());
  const originalPreload = extractFile(archive, 'dist-js/preload.js').toString();
  const stage = await fs.mkdtemp(path.join(resources, '.lolkamod-stage-'));
  let backupCreated = false;
  let modCreated = false;
  try {
    await fs.mkdir(path.join(stage, 'lolkamod'));
    for (const file of ['main.cjs', 'build.json']) await fs.copyFile(path.join(workspace, 'dist', file), path.join(stage, 'lolkamod', file));
    const modPreload = await fs.readFile(path.join(workspace, 'dist', 'preload.js'), 'utf8');
    await fs.writeFile(path.join(stage, 'lolkamod', 'preload.js'), `// Original Lolka preload, kept byte-for-byte inside its own scope.\n(function(){\n${originalPreload}\n})();\n${modPreload}`);
    const config = { testMode: options.testMode === true, baseline: options.baseline === true,
      ...(options.testMode ? { userData: path.resolve(options.userData) } : {}) };
    await fs.writeFile(path.join(stage, 'lolkamod', 'config.json'), JSON.stringify(config, null, 2));
    await fs.mkdir(path.join(stage, 'shim'));
    await fs.writeFile(path.join(stage, 'shim', 'package.json'), JSON.stringify({ name: 'Lolka', version: host.version, main: 'index.js' }));
    await fs.writeFile(path.join(stage, 'shim', 'index.js'), `const path = require('path');\nconst fs = require('fs');\nconst electron = require('electron');\nconst modDir = path.join(process.resourcesPath, 'lolkamod');\nconst config = JSON.parse(fs.readFileSync(path.join(modDir, 'config.json')));\nconst original = path.join(process.resourcesPath, '_app.asar');\ntry {\n  if (process.argv.includes('--lolkamod-disable') && !config.testMode) {\n    electron.app.setAppPath(original);\n    require(path.join(original, 'dist-js', 'main.js'));\n  } else { require(path.join(modDir, 'main.cjs')); }\n} catch (error) {\n  if (config.testMode) { fs.writeFileSync(path.join(modDir, 'bootstrap-error.txt'), String(error.stack)); electron.app.exit(1); } else { throw error; }\n}\n`);
    await createPackage(path.join(stage, 'shim'), path.join(stage, 'app.asar'));
    const shimHash = hash(await fs.readFile(path.join(stage, 'app.asar')));
    await fs.writeFile(path.join(stage, 'lolkamod', 'install.json'), JSON.stringify({
      modVersion: JSON.parse(await fs.readFile(path.join(workspace, 'dist', 'build.json'), 'utf8')).version, hostVersion: host.version, originalHash: SUPPORTED_HASH, shimHash,
      installedAt: new Date().toISOString(), testMode: config.testMode
    }, null, 2));
    // All fallible compilation/staging completes before replacing the entry archive.
    await fs.copyFile(archive, backup, fs.constants.COPYFILE_EXCL);
    backupCreated = true;
    if (hash(await fs.readFile(backup)) !== SUPPORTED_HASH) throw new Error('Backup hash mismatch');
    await fs.rename(path.join(stage, 'lolkamod'), modDir);
    modCreated = true;
    await replaceArchive(resources, await fs.readFile(path.join(stage, 'app.asar')), shimHash);
    if (hash(await fs.readFile(backup)) !== SUPPORTED_HASH || hash(await fs.readFile(archive)) !== shimHash) throw new Error('Post-install hash mismatch');
    return { installed: true, hostVersion: host.version, originalHash: SUPPORTED_HASH, shimHash, testMode: config.testMode };
  } catch (error) {
    if (backupCreated && await exists(backup)) {
      const bytes = await fs.readFile(backup);
      if (hash(bytes) === SUPPORTED_HASH) {
        await replaceArchive(resources, bytes, SUPPORTED_HASH);
        if (modCreated) await removeModDir(resources);
        await fs.unlink(backup);
      }
    }
    throw error;
  } finally {
    // stage is created by mkdtemp immediately under this explicit resources root.
    if (path.dirname(stage) !== resources) throw new Error('Unsafe stage cleanup target');
    await fs.rm(stage, { recursive: true, force: true });
  }
}
export async function uninstall(installation) {
  await ensureStopped(path.resolve(installation));
  const resources = path.join(path.resolve(installation), 'resources');
  const archive = path.join(resources, 'app.asar');
  const backup = path.join(resources, '_app.asar');
  const modDir = path.join(resources, 'lolkamod');
  const currentHash = hash(await fs.readFile(archive));
  if (!await exists(backup) && !await exists(modDir) && currentHash === SUPPORTED_HASH) return { restored: true, alreadyRestored: true, originalHash: SUPPORTED_HASH };
  const manifest = await exists(modDir) ? JSON.parse(await fs.readFile(path.join(modDir, 'install.json'), 'utf8')) : null;
  if (manifest && manifest.originalHash !== SUPPORTED_HASH) throw new Error('Unrecognized mod installation');
  if (currentHash !== SUPPORTED_HASH && currentHash !== manifest?.shimHash) throw new Error('Host entry changed since installation; preserve current files and repair manually.');
  if (currentHash !== SUPPORTED_HASH) {
    await replaceArchive(resources, await fs.readFile(backup), SUPPORTED_HASH);
  } else if (await exists(backup) && hash(await fs.readFile(backup)) !== SUPPORTED_HASH) {
    throw new Error('Original backup integrity mismatch');
  }
  if (hash(await fs.readFile(archive)) !== SUPPORTED_HASH) throw new Error('Restore verification failed');
  await removeModDir(resources);
  await fs.rm(backup, { force: true });
  return { restored: true, originalHash: SUPPORTED_HASH };
}
export async function repair(installation) {
  await ensureStopped(path.resolve(installation));
  const resources = path.join(path.resolve(installation), 'resources');
  const bytes = await fs.readFile(path.join(resources, '_app.asar'));
  if (hash(bytes) !== SUPPORTED_HASH) throw new Error('Original backup integrity mismatch');
  // Preserve an unexpected archive for investigation; never overwrite that evidence.
  const archive = path.join(resources, 'app.asar');
  if (await exists(archive) && hash(await fs.readFile(archive)) !== SUPPORTED_HASH) {
    await fs.copyFile(archive, path.join(resources, `lolkamod-recovered-${crypto.randomUUID()}.asar`), fs.constants.COPYFILE_EXCL);
  }
  await replaceArchive(resources, bytes, SUPPORTED_HASH);
  return { repaired: true, restored: true, originalHash: SUPPORTED_HASH, next: 'uninstall to clean mod files' };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, target = DEFAULT_INSTALLATION] = process.argv.slice(2);
  try {
    if (command === 'install') console.log(JSON.stringify(await install(target)));
    else if (command === 'uninstall') console.log(JSON.stringify(await uninstall(target)));
    else if (command === 'repair') console.log(JSON.stringify(await repair(target)));
    else throw new Error('Usage: node scripts/install.mjs install|uninstall|repair [Lolka directory]');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
