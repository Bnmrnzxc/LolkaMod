import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { install, uninstall, repair, inspectInstallation as inspectCore, ensureInstallationStopped, getInstallationLayout, hash } from './install.mjs';

const run = promisify(execFile);
const exists = file => fs.lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const sha = /^[a-f0-9]{64}$/;
const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');

export function macStateDirectory(root) {
  const absolute = path.resolve(root);
  return path.join(path.dirname(absolute), `.lolkamod-${hash(Buffer.from(absolute)).slice(0, 16)}`);
}

// Framework symlinks are normal in a macOS bundle. Inspect them without following
// directory links, and refuse a bundle that refers outside its own boundary.
export async function bundleDigest(root) {
  const absolute = path.resolve(root), digest = crypto.createHash('sha256');
  async function walk(directory, prefix = '') {
    for (const name of (await fs.readdir(directory)).sort()) {
      const file = path.join(directory, name), relative = prefix + name, stat = await fs.lstat(file);
      const mode = stat.mode & 0o7777;
      if (stat.isSymbolicLink()) {
        const target = await fs.readlink(file), resolved = path.resolve(directory, target);
        if (path.isAbsolute(target) || !resolved.startsWith(absolute + path.sep)) throw new Error('Bundle contains an external symbolic link');
        digest.update(`l:${relative}:${target}\n`);
      } else if (stat.isDirectory()) {
        digest.update(`d:${relative}:${mode}\n`); await walk(file, relative + '/');
      } else if (stat.isFile()) {
        const content = crypto.createHash('sha256');
        for await (const chunk of createReadStream(file)) content.update(chunk);
        digest.update(`f:${relative}:${mode}:${content.digest('hex')}\n`);
      } else throw new Error('Unsupported bundle filesystem entry');
    }
  }
  if ((await fs.lstat(absolute)).isSymbolicLink()) throw new Error('Linked application bundles are not supported');
  await walk(absolute); return digest.digest('hex');
}

export function readFuseState(bytes) {
  const offset = bytes.indexOf(sentinel);
  if (offset < 0 || bytes.indexOf(sentinel, offset + 1) >= 0) throw new Error('Unknown Electron fuse layout');
  const start = offset + sentinel.length;
  if (bytes[start] !== 1 || bytes[start + 1] < 6 || bytes[start + 1] > 32 || start + 2 + bytes[start + 1] > bytes.length) throw new Error('Unsupported Electron fuse wire');
  const flags = bytes.subarray(start + 2, start + 2 + bytes[start + 1]);
  if (![...flags].every(value => [0x30, 0x31, 0x72].includes(value))) throw new Error('Unsupported Electron fuse state');
  return { asarIntegrity: flags[4] === 0x31, onlyAsar: flags[5] === 0x31 };
}

async function checkMacFuses(root) {
  const framework = path.join(root, 'Contents/Frameworks/Electron Framework.framework/Electron Framework');
  const state = readFuseState(await fs.readFile(framework));
  // The loader retains vendor files and fuses. A stricter future host needs a
  // separately reviewed adapter rather than silently disabling its checks.
  if (state.asarIntegrity || state.onlyAsar) throw new Error('This Lolka version enables an unsupported ASAR integrity policy');
}

async function writeJSON(file, value) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temporary, file);
  const directory = await fs.open(path.dirname(file), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

async function checkStateDirectory(directory) {
  await fs.mkdir(directory, { mode: 0o700, recursive: true });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o022)) throw new Error('Unsafe macOS backup directory');
}

async function copyBundle(source, target, expected) {
  if (await exists(target)) throw new Error('Backup destination already exists');
  await run('/usr/bin/ditto', ['--rsrc', '--extattr', source, target], { maxBuffer: 1024 * 1024 });
  if (await bundleDigest(target) !== expected) throw new Error('Complete application backup verification failed');
}

async function removeOwned(directory, parent) {
  if (path.dirname(path.resolve(directory)) !== path.resolve(parent) || (await fs.lstat(directory)).isSymbolicLink()) throw new Error('Unsafe backup cleanup target');
  await fs.rm(directory, { recursive: true, force: true });
}

async function restoreSnapshot(root, snapshot, expected, stateDirectory) {
  if (await bundleDigest(snapshot) !== expected) throw new Error('Application snapshot integrity mismatch');
  const discarded = path.join(stateDirectory, `discarded-${crypto.randomUUID()}.app`);
  await fs.rename(root, discarded);
  try { await fs.rename(snapshot, root); }
  catch (error) { await fs.rename(discarded, root); throw error; }
  try { await removeOwned(discarded, stateDirectory); } catch { /* A verified restore takes precedence over deleting an obsolete snapshot. */ }
}

async function recoverMac(root, directory) {
  const journalPath = path.join(directory, 'transaction.json');
  if (!await exists(journalPath)) return;
  const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
  if (journal.schema !== 1 || journal.root !== root || !/^stage-[a-f0-9-]+$/.test(journal.stage) || !sha.test(journal.beforeDigest) || !sha.test(journal.beforeArchive) || (journal.afterArchive != null && !sha.test(journal.afterArchive)) || !['active', 'committed'].includes(journal.phase)) throw new Error('Invalid macOS recovery journal; files are preserved');
  const stage = path.join(directory, journal.stage);
  if ((await fs.lstat(stage)).isSymbolicLink()) throw new Error('Unsafe macOS recovery snapshot');
  if (journal.phase === 'active') {
    const current = hash(await fs.readFile(path.join(root, 'Contents/Resources/app.asar')));
    if (![journal.beforeArchive, journal.afterArchive].includes(current)) throw new Error('Lolka changed after an interrupted patch; files are preserved');
    await restoreSnapshot(root, path.join(stage, 'before.app'), journal.beforeDigest, directory);
  }
  await fs.unlink(journalPath); await removeOwned(stage, directory);
}

async function updateMacIntegrity(root) {
  const info = path.join(root, 'Contents/Info.plist');
  const result = await run('/usr/bin/plutil', ['-extract', 'ElectronAsarIntegrity', 'json', '-o', '-', info]);
  const integrity = JSON.parse(result.stdout);
  const archive = await fs.readFile(path.join(root, 'Contents/Resources/app.asar'));
  if (archive.length < 16 || archive.readUInt32LE(12) > archive.length - 16) throw new Error('Invalid replacement ASAR header');
  integrity['Resources/app.asar'] = { algorithm: 'SHA256', hash: hash(archive.subarray(16, 16 + archive.readUInt32LE(12))) };
  await run('/usr/bin/plutil', ['-replace', 'ElectronAsarIntegrity', '-json', JSON.stringify(integrity), info]);
}

async function signMac(root) {
  await updateMacIntegrity(root);
  // Preserve the existing application's runtime entitlements, not its vendor
  // certificate requirement. This is a local ad-hoc signature, not Developer ID.
  await run('/usr/bin/codesign', ['--force', '--sign', '-', '--preserve-metadata=entitlements,flags', '--timestamp=none', root], { maxBuffer: 2 * 1024 * 1024 });
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', root], { maxBuffer: 2 * 1024 * 1024 });
}

export async function inspectInstallation(root) {
  const status = await inspectCore(root);
  if (process.platform === 'darwin') status.recoveryRequired ||= await exists(path.join(macStateDirectory(root), 'transaction.json'));
  return status;
}

export async function applyOperation(operation, installation, options = {}) {
  if (!['install', 'uninstall', 'repair'].includes(operation)) throw new Error('Unknown installation operation');
  const root = path.resolve(installation);
  let beforeArchiveChange;
  const perform = () => {
    const coreOptions = { ...options, beforeArchiveChange };
    return operation === 'install' ? install(root, coreOptions) : operation === 'repair' ? repair(root, coreOptions) : uninstall(root, coreOptions);
  };
  if (process.platform !== 'darwin') return perform();
  if (!root.endsWith('.app')) throw new Error('Choose Lolka.app');
  await getInstallationLayout(root);
  await ensureInstallationStopped(root);
  await fs.access(path.dirname(root), fs.constants.W_OK);
  const directory = macStateDirectory(root); await checkStateDirectory(directory);
  const lock = path.join(directory, 'lock'); let handle;
  try { handle = await fs.open(lock, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if ((await fs.lstat(lock)).isSymbolicLink()) throw new Error('Unsafe macOS installer lock');
    const previous = JSON.parse(await fs.readFile(lock, 'utf8'));
    if (!Number.isSafeInteger(previous.pid) || previous.pid < 1) throw new Error('Invalid macOS installer lock');
    try { process.kill(previous.pid, 0); throw new Error('Another installer is running'); }
    catch (failure) { if (failure.code !== 'ESRCH') throw failure; }
    await fs.unlink(lock); handle = await fs.open(lock, 'wx', 0o600);
  }
  let stage, journal;
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid })); await handle.sync();
    await recoverMac(root, directory);
    const before = await inspectCore(root); await checkMacFuses(root);
    const beforeDigest = await bundleDigest(root);
    const metadata = path.join(directory, 'active-original.json');
    let saved, original;
    if (operation === 'install' && !before.installed) {
      original = path.join(directory, `original-${beforeDigest}.app`);
      if (!await exists(original)) {
        const next = path.join(directory, `original-next-${crypto.randomUUID()}.app`);
        try { await copyBundle(root, next, beforeDigest); await fs.rename(next, original); }
        finally { if (await exists(next)) await removeOwned(next, directory); }
      }
      if (await bundleDigest(original) !== beforeDigest) throw new Error('Original application backup conflicts with the installed client');
      saved = { schema: 1, originalHash: before.originalHash, digest: beforeDigest, hostVersion: before.hostVersion, backup: path.basename(original) };
      await writeJSON(metadata, saved);
    }
    // An archive-only backup cannot restore the vendor's executable signature.
    if (before.installed) {
      if (!await exists(metadata) || (await fs.lstat(metadata)).isSymbolicLink()) throw new Error('Complete original Mac application backup is missing; files are preserved');
      saved = JSON.parse(await fs.readFile(metadata, 'utf8'));
      if (saved.schema !== 1 || saved.originalHash !== before.originalHash || !sha.test(saved.digest) || saved.backup !== `original-${saved.digest}.app`) throw new Error('Invalid original application metadata');
      original = path.join(directory, saved.backup);
      if (await bundleDigest(original) !== saved.digest) throw new Error('Complete original Mac application backup integrity mismatch');
    }
    stage = path.join(directory, `stage-${crypto.randomUUID()}`); await fs.mkdir(stage, { mode: 0o700 });
    await copyBundle(root, path.join(stage, 'before.app'), beforeDigest);
    journal = { schema: 1, root, stage: path.basename(stage), phase: 'active', beforeDigest, beforeArchive: hash(await fs.readFile(path.join(root, 'Contents/Resources/app.asar'))) };
    await writeJSON(path.join(directory, 'transaction.json'), journal);
    beforeArchiveChange = async nextHash => {
      journal.afterArchive = nextHash;
      // Persist the permitted next entry before the core can replace any files.
      await writeJSON(path.join(directory, 'transaction.json'), journal);
    };
    const result = await perform();
    journal.afterArchive = hash(await fs.readFile(path.join(root, 'Contents/Resources/app.asar')));
    await writeJSON(path.join(directory, 'transaction.json'), journal);
    if (operation === 'install') await signMac(root);
    else if (before.installed) {
      const restored = path.join(stage, 'original.app'); await copyBundle(original, restored, saved.digest);
      await restoreSnapshot(root, restored, saved.digest, directory);
      await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', root]);
    }
    journal.phase = 'committed'; await writeJSON(path.join(directory, 'transaction.json'), journal);
    await fs.unlink(path.join(directory, 'transaction.json'));
    try { await removeOwned(stage, directory); } catch { /* The committed bundle is valid; cleanup can be retried separately. */ }
    stage = null;
    return { ...result, ...(operation === 'install' ? { signature: 'local-ad-hoc' } : {}) };
  } catch (error) {
    if (stage && journal?.phase === 'active') {
      // In-process failures can restore the complete pre-operation bundle even
      // when codesign was interrupted after changing the Mach-O executable.
      await restoreSnapshot(root, path.join(stage, 'before.app'), journal.beforeDigest, directory);
      await fs.rm(path.join(directory, 'transaction.json'), { force: true });
      await removeOwned(stage, directory);
    } else if (stage && !journal) {
      await removeOwned(stage, directory);
    }
    throw error;
  } finally { await handle.close(); await fs.unlink(lock); }
}
