import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createPackage, uncache } from '@electron/asar';

// Migration hint only: newer Lolka packages are checked structurally.
export const SUPPORTED_HASH = 'fd94ecec264d7d7a56a0b5d1bb5ac1e416b6c9a4ee2d171b3704b0b72f0260a8';
export const DEFAULT_INSTALLATION = path.join(process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Local'), 'Programs', 'Lolka');
const workspace = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const mainPath = 'dist-js/main.js', preloadPath = 'dist-js/preload.js';
const shaPattern = /^[a-f0-9]{64}$/, versionPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
export const hash = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
async function exists(file) { return fs.lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }); }
async function noLink(file) { if ((await fs.lstat(file)).isSymbolicLink()) throw new Error(`Symbolic links/junctions are not supported: ${file}`); }
async function checkTree(folder) {
  await noLink(folder);
  for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name); await noLink(file);
    if (entry.isDirectory()) await checkTree(file);
    else if (!entry.isFile()) throw new Error('Unsupported filesystem entry');
  }
}
async function treeHash(folder) {
  const items = [];
  async function walk(current, prefix) {
    for (const name of (await fs.readdir(current)).sort()) {
      const file = path.join(current, name), relative = prefix + name; await noLink(file);
      if ((await fs.stat(file)).isDirectory()) { items.push(`d:${relative}\n`); await walk(file, `${relative}/`); }
      else items.push(`f:${relative}:${hash(await fs.readFile(file))}\n`);
    }
  }
  await walk(folder, ''); return hash(Buffer.from(items.join('')));
}
async function layout(installation) {
  const root = path.resolve(installation), resources = path.join(root, 'resources');
  for (let current = root; ; current = path.dirname(current)) { await noLink(current); if (path.dirname(current) === current) break; }
  await noLink(resources);
  const state = { root, resources, archive: path.join(resources, 'app.asar'), backup: path.join(resources, '_app.asar'), mod: path.join(resources, 'lolkamod'), journal: path.join(resources, '.lolkamod-transaction.json') };
  await noLink(state.archive);
  for (const file of [state.backup, state.mod, state.journal]) if (await exists(file)) await noLink(file);
  if (await exists(state.mod)) await checkTree(state.mod);
  return state;
}
async function ensureStopped(root) {
  const executable = path.join(root, 'Lolka.exe');
  if (process.platform !== 'win32' || !await exists(executable)) return;
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$processes = @(Get-CimInstance Win32_Process -Filter \"Name = 'Lolka.exe'\"); if (@($processes | Where-Object { -not $_.ExecutablePath }).Count) { throw 'Cannot inspect Lolka processes' }; @($processes | Where-Object { $_.ExecutablePath -eq $env:LOLKAMOD_INSTALL_TARGET }).Count"],
  { windowsHide: true, env: { ...process.env, LOLKAMOD_INSTALL_TARGET: executable } });
  if (Number(stdout.trim()) !== 0) throw new Error('Close this Lolka installation before changing its files.');
}
async function durableWrite(file, bytes) { const handle = await fs.open(file, 'wx'); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } }
async function atomicWrite(file, bytes) {
  const temp = path.join(path.dirname(file), `.lolkamod-entry-${crypto.randomUUID()}.tmp`);
  await durableWrite(temp, bytes);
  try { await fs.rename(temp, file); } finally { await fs.rm(temp, { force: true }); }
}
async function replaceArchive(state, bytes, expectedHash) {
  if (hash(bytes) !== expectedHash) throw new Error('Replacement archive integrity mismatch');
  await ensureStopped(state.root); await atomicWrite(state.archive, bytes); uncache(state.archive);
  if (hash(await fs.readFile(state.archive)) !== expectedHash) throw new Error('Archive verification failed');
}
async function removeTree(file, parent) {
  if (path.dirname(path.resolve(file)) !== parent) throw new Error('Unsafe cleanup target');
  if (await exists(file)) { await checkTree(file); await fs.rm(file, { recursive: true }); }
}
function asarFile(bytes, file) {
  if (bytes.length < 16 || bytes.readUInt32LE(0) !== 4) throw new Error('Unsupported Lolka ASAR header');
  const headerSize = bytes.readUInt32LE(4), jsonSize = bytes.readUInt32LE(12), start = 8 + headerSize;
  if (headerSize < 8 || jsonSize > headerSize - 8 || jsonSize > 16 * 1024 * 1024 || start > bytes.length) throw new Error('Unsupported Lolka ASAR header');
  let current = JSON.parse(decode(bytes.subarray(16, 16 + jsonSize)));
  for (const component of file.split('/')) {
    if (!current || current.link || current.unpacked || typeof current.files !== 'object' || !Object.hasOwn(current.files, component)) throw new Error(`Unsupported Lolka ASAR entry: ${file}`);
    current = current.files[component];
  }
  if (current.link || current.unpacked || !/^\d+$/.test(current.offset ?? '') || !Number.isSafeInteger(current.size)) throw new Error(`Unsupported Lolka ASAR entry: ${file}`);
  const offset = Number(current.offset), size = current.size;
  if (!Number.isSafeInteger(offset) || offset < 0 || size < 0 || size > 16 * 1024 * 1024 || start + offset + size > bytes.length) throw new Error('ASAR entry out of bounds');
  return bytes.subarray(start + offset, start + offset + size);
}
export function inspectHost(bytes) {
  const pkg = JSON.parse(decode(asarFile(bytes, 'package.json')));
  if (pkg.name !== 'Lolka' || pkg.homepage !== 'https://lolka.app' || !versionPattern.test(pkg.version ?? '') || pkg.main !== mainPath || pkg.type === 'module') throw new Error('Unsupported Lolka package structure');
  const main = decode(asarFile(bytes, mainPath)), preload = decode(asarFile(bytes, preloadPath));
  if (!/\brequire\s*\(\s*["']electron["']\s*\)/.test(main) || !['BrowserWindow', 'ipcMain', 'https://lolka.app', 'get-desktop-sources', 'set-display-media-selected-source'].every(anchor => main.includes(anchor))) throw new Error('Unsupported Lolka main bridge');
  if (!/\brequire\s*\(\s*["']electron["']\s*\)/.test(preload) || !/exposeInMainWorld\s*\(\s*["']electronAPI["']\s*,/.test(preload) || !['get-desktop-sources', 'set-display-media-selected-source'].every(anchor => preload.includes(anchor))) throw new Error('Unsupported Lolka preload bridge');
  return { version: pkg.version, main: mainPath, preload: preloadPath, originalPreload: preload, originalHash: hash(bytes) };
}
async function readManifest(state) {
  if (!await exists(state.mod)) return null;
  try {
    const data = JSON.parse(await fs.readFile(path.join(state.mod, 'install.json'), 'utf8'));
    if (!shaPattern.test(data.originalHash ?? '') || !shaPattern.test(data.shimHash ?? '') || !versionPattern.test(data.hostVersion ?? '') || typeof data.modVersion !== 'string') return null;
    if (data.schemaVersion === 2) { if (data.hostMain !== mainPath || data.hostPreload !== preloadPath) return null; }
    else if ((data.schemaVersion != null && data.schemaVersion !== 1) || data.originalHash !== SUPPORTED_HASH) return null;
    return data;
  } catch { return null; }
}
async function verifiedBackup(state, manifest) {
  if (!manifest || !await exists(state.backup)) throw new Error('Original backup missing or installation manifest invalid');
  const bytes = await fs.readFile(state.backup);
  if (hash(bytes) !== manifest.originalHash) throw new Error('Original backup integrity mismatch');
  const host = inspectHost(bytes);
  if (host.version !== manifest.hostVersion) throw new Error('Original backup host version mismatch');
  return { bytes, host };
}
async function classify(state) {
  const entry = await fs.readFile(state.archive), currentHash = hash(entry), manifest = await readManifest(state);
  try { return { entry, currentHash, manifest, liveHost: inspectHost(entry) }; } catch { /* A shim requires its own valid manifest. */ }
  if (!manifest || currentHash !== manifest.shimHash) throw new Error('Host entry changed or unsupported; current files are preserved');
  return { entry, currentHash, manifest, liveHost: null, backup: await verifiedBackup(state, manifest) };
}
async function recover(state) {
  if (!await exists(state.journal)) return false;
  const journal = JSON.parse(await fs.readFile(state.journal, 'utf8'));
  if (journal.schemaVersion !== 1 || !/^\.lolkamod-stage-[a-f0-9-]+$/.test(journal.stage ?? '') || !shaPattern.test(journal.archiveBeforeHash ?? '') || !shaPattern.test(journal.archiveAfterHash ?? '') || ![journal.backupBeforeHash, journal.backupAfterHash, journal.beforeModHash, journal.afterModHash].every(value => value == null || shaPattern.test(value))) throw new Error('Invalid recovery journal; files are preserved');
  const stage = path.join(state.resources, journal.stage); await checkTree(stage);
  const archiveBefore = await fs.readFile(path.join(stage, 'entry.before'));
  if (hash(archiveBefore) !== journal.archiveBeforeHash) throw new Error('Recovery snapshot integrity mismatch');
  const backupBefore = journal.backupBeforeHash == null ? null : await fs.readFile(path.join(stage, 'backup.before'));
  if (backupBefore && hash(backupBefore) !== journal.backupBeforeHash) throw new Error('Recovery backup integrity mismatch');
  if (journal.beforeModHash != null && await treeHash(path.join(stage, 'mod.before')) !== journal.beforeModHash) throw new Error('Recovery mod snapshot integrity mismatch');
  const current = hash(await fs.readFile(state.archive));
  if (![journal.archiveBeforeHash, journal.archiveAfterHash].includes(current)) throw new Error('Host changed during interrupted transaction; current files are preserved');
  if (await exists(state.backup) && ![journal.backupBeforeHash, journal.backupAfterHash].includes(hash(await fs.readFile(state.backup)))) throw new Error('Backup changed during interrupted transaction; current files are preserved');
  if (await exists(state.mod) && ![journal.beforeModHash, journal.afterModHash].includes(await treeHash(state.mod))) throw new Error('Mod files changed during interrupted transaction; current files are preserved');
  await replaceArchive(state, archiveBefore, journal.archiveBeforeHash);
  if (backupBefore) await atomicWrite(state.backup, backupBefore); else await fs.rm(state.backup, { force: true });
  // Moving a directory is atomic; an interrupted recursive removal would destroy
  // the live tree in pieces and prevent a verifiable retry of the recovery.
  if (await exists(state.mod)) await fs.rename(state.mod, path.join(stage, `mod.discarded-${crypto.randomUUID()}`));
  if (journal.beforeModHash != null) {
    const restored = path.join(stage, 'restore-mod'); if (await exists(restored)) await removeTree(restored, stage);
    await fs.cp(path.join(stage, 'mod.before'), restored, { recursive: true }); await fs.rename(restored, state.mod);
  }
  await fs.unlink(state.journal); await removeTree(stage, state.resources); return true;
}
async function transaction(state, { entry, backup, modSource, preserveBackup = false, expectedArchiveHash, expectedBackupHash }) {
  const stage = path.join(state.resources, `.lolkamod-stage-${crypto.randomUUID()}`); await fs.mkdir(stage);
  let journalWritten = false, committed = false;
  try {
    const beforeEntry = await fs.readFile(state.archive), beforeBackup = await exists(state.backup) ? await fs.readFile(state.backup) : null;
    if (hash(beforeEntry) !== expectedArchiveHash || (expectedBackupHash != null && (!beforeBackup || hash(beforeBackup) !== expectedBackupHash))) throw new Error('Host or backup changed during staging; current files are preserved');
    await durableWrite(path.join(stage, 'entry.before'), beforeEntry);
    if (beforeBackup) await durableWrite(path.join(stage, 'backup.before'), beforeBackup);
    const beforeModHash = await exists(state.mod) ? await treeHash(state.mod) : null;
    if (beforeModHash != null) await fs.cp(state.mod, path.join(stage, 'mod.before'), { recursive: true });
    if (beforeModHash != null && await treeHash(path.join(stage, 'mod.before')) !== beforeModHash) throw new Error('Mod snapshot changed during staging');
    if (modSource) await fs.cp(modSource, path.join(stage, 'mod.next'), { recursive: true });
    const afterModHash = modSource ? await treeHash(path.join(stage, 'mod.next')) : null;
    const journal = { schemaVersion: 1, stage: path.basename(stage), archiveBeforeHash: hash(beforeEntry), archiveAfterHash: hash(entry), backupBeforeHash: beforeBackup ? hash(beforeBackup) : null, backupAfterHash: backup ? hash(backup) : null, beforeModHash, afterModHash };
    await ensureStopped(state.root);
    if (hash(await fs.readFile(state.archive)) !== journal.archiveBeforeHash || (beforeModHash != null && await treeHash(state.mod) !== beforeModHash)) throw new Error('Host or mod changed during staging');
    await atomicWrite(state.journal, Buffer.from(JSON.stringify(journal))); journalWritten = true;
    if (backup) await atomicWrite(state.backup, backup); else await fs.rm(state.backup, { force: true });
    if (await exists(state.mod)) await fs.rename(state.mod, path.join(stage, 'mod.removed'));
    if (modSource) await fs.rename(path.join(stage, 'mod.next'), state.mod);
    await replaceArchive(state, entry, journal.archiveAfterHash);
    if ((backup && hash(await fs.readFile(state.backup)) !== journal.backupAfterHash) || (modSource && await treeHash(state.mod) !== afterModHash)) throw new Error('Post-transaction integrity mismatch');
    if (preserveBackup && beforeBackup) await durableWrite(path.join(state.resources, `lolkamod-backup-${hash(beforeBackup)}-${crypto.randomUUID()}.asar`), beforeBackup);
    await fs.unlink(state.journal); committed = true;
  } catch (error) {
    if (journalWritten) await recover(state);
    throw error;
  } finally {
    if (committed || !journalWritten) { try { await removeTree(stage, state.resources); } catch (error) { if (!committed) throw error; } }
  }
}
async function locked(installation, operation) {
  const state = await layout(installation), lockPath = path.join(state.resources, '.lolkamod-install.lock'); let handle;
  try { handle = await fs.open(lockPath, 'wx'); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    await noLink(lockPath); const previous = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    if (!Number.isSafeInteger(previous.pid) || previous.pid < 1) throw new Error('Unknown installer lock; files are preserved');
    let alive = true; try { process.kill(previous.pid, 0); } catch (failure) { if (failure.code === 'ESRCH') alive = false; }
    if (alive) throw new Error('Another installer is running');
    await fs.unlink(lockPath); handle = await fs.open(lockPath, 'wx');
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid })); await handle.sync();
    await ensureStopped(state.root); await recover(state); return await operation(state);
  } finally { await handle.close(); await fs.unlink(lockPath); }
}
export async function install(installation, options = {}) {
  if (options.testMode && typeof options.userData !== 'string') throw new Error('testMode requires an explicit separate userData directory');
  return locked(installation, async state => {
    const current = await classify(state), original = current.liveHost ? current.entry : current.backup.bytes, host = current.liveHost ?? current.backup.host;
    const stage = path.join(state.resources, `.lolkamod-stage-${crypto.randomUUID()}`); await fs.mkdir(stage);
    try {
      const mod = path.join(stage, 'next'); await fs.mkdir(mod);
      for (const file of ['main.cjs', 'build.json']) await fs.copyFile(path.join(workspace, 'dist', file), path.join(mod, file));
      const build = JSON.parse(await fs.readFile(path.join(mod, 'build.json'), 'utf8'));
      const modPreload = await fs.readFile(path.join(workspace, 'dist', 'preload.js'), 'utf8');
      await fs.writeFile(path.join(mod, 'preload.js'), `// Original preload retained in its own scope.\n(function(){\n${host.originalPreload}\n})();\n${modPreload}`);
      const config = { testMode: options.testMode === true, baseline: options.baseline === true, hostMain: host.main, hostPreload: host.preload, ...(options.testMode ? { userData: path.resolve(options.userData) } : {}) };
      await fs.writeFile(path.join(mod, 'config.json'), JSON.stringify(config, null, 2));
      const shim = path.join(stage, 'shim'); await fs.mkdir(shim);
      await fs.writeFile(path.join(shim, 'package.json'), JSON.stringify({ name: 'LolkaModBootstrap', version: build.version, main: 'index.js' }));
      await fs.writeFile(path.join(shim, 'index.js'), `const path = require('path');\nconst fs = require('fs');\nconst electron = require('electron');\nconst modDir = path.join(process.resourcesPath, 'lolkamod');\nconst config = JSON.parse(fs.readFileSync(path.join(modDir, 'config.json')));\nconst original = path.join(process.resourcesPath, '_app.asar');\ntry {\n  if (process.argv.includes('--lolkamod-disable') && !config.testMode) {\n    electron.app.setAppPath(original);\n    electron.app.getVersion = () => JSON.parse(fs.readFileSync(path.join(original, 'package.json'))).version;\n    require(path.join(original, config.hostMain || 'dist-js/main.js'));\n  } else { require(path.join(modDir, 'main.cjs')); }\n} catch (error) {\n  if (config.testMode) { fs.writeFileSync(path.join(modDir, 'bootstrap-error.txt'), String(error.stack)); electron.app.exit(1); } else { throw error; }\n}\n`);
      const shimFile = path.join(stage, 'shim.asar'); await createPackage(shim, shimFile);
      const entry = await fs.readFile(shimFile), shimHash = hash(entry);
      const manifest = { schemaVersion: 2, modVersion: build.version, hostVersion: host.version, hostMain: host.main, hostPreload: host.preload, originalHash: host.originalHash, shimHash, installedAt: new Date().toISOString(), testMode: config.testMode };
      await fs.writeFile(path.join(mod, 'install.json'), JSON.stringify(manifest, null, 2));
      await transaction(state, { entry, backup: original, modSource: mod, preserveBackup: !!current.liveHost && await exists(state.backup), expectedArchiveHash: current.currentHash, expectedBackupHash: current.liveHost ? undefined : host.originalHash });
      return { installed: true, ...manifest };
    } finally { await removeTree(stage, state.resources); }
  });
}
async function removeInstallation(state, repairMode) {
  const originalEntry = await fs.readFile(state.archive), manifest = await readManifest(state); let liveHost;
  try { liveHost = inspectHost(originalEntry); } catch { /* Explicit repair may restore a verified backup for unknown bytes. */ }
  if (liveHost) {
    const alreadyRestored = !await exists(state.mod) && !await exists(state.backup);
    if (!alreadyRestored) await transaction(state, { entry: originalEntry, backup: null, modSource: null, preserveBackup: true, expectedArchiveHash: hash(originalEntry) });
    return { restored: true, alreadyRestored, repaired: repairMode, originalHash: liveHost.originalHash, hostVersion: liveHost.version, preservedUpdatedHost: true };
  }
  const backup = await verifiedBackup(state, manifest), currentHash = hash(originalEntry);
  if (currentHash !== manifest.shimHash && !repairMode) throw new Error('Host entry changed since installation; current files are preserved');
  if (currentHash !== manifest.shimHash) await durableWrite(path.join(state.resources, `lolkamod-recovered-${crypto.randomUUID()}.asar`), originalEntry);
  await transaction(state, { entry: backup.bytes, backup: null, modSource: null, expectedArchiveHash: currentHash, expectedBackupHash: backup.host.originalHash });
  return { restored: true, repaired: repairMode, originalHash: backup.host.originalHash, hostVersion: backup.host.version };
}
export async function uninstall(installation) { return locked(installation, state => removeInstallation(state, false)); }
export async function repair(installation) { return locked(installation, state => removeInstallation(state, true)); }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, target = DEFAULT_INSTALLATION] = process.argv.slice(2);
  try {
    if (command === 'install') console.log(JSON.stringify(await install(target)));
    else if (command === 'uninstall') console.log(JSON.stringify(await uninstall(target)));
    else if (command === 'repair') console.log(JSON.stringify(await repair(target)));
    else throw new Error('Usage: node scripts/install.mjs install|uninstall|repair [Lolka directory]');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
