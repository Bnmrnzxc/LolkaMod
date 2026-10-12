import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectInstallation, applyOperation } from './portable-platform.mjs';
import { ensureInstallationStopped } from './install.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const payloadDirectory = path.join(here, path.basename(fileURLToPath(import.meta.url)) === 'backend.mjs' ? 'dist' : '../dist');
const [operation, target, ...extra] = process.argv.slice(2);
async function assertProtectedAncestors(file) {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || stat.uid !== 0 || stat.mode & 0o022) throw new Error(`Privileged installer files must be root-owned and not writable by other users: ${current}`);
    if (path.dirname(current) === current) break;
  }
}

async function protectVendorDirectory(directory) {
  // The official Lolka DEB uses root:root 0775 for these two directories.
  // Secure them through a non-following descriptor before any root file writes.
  // Never change an ancestor, a user-owned directory or a world-writable target.
  const handle = await fs.open(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o002) || ((stat.mode & 0o020) && stat.gid !== 0)) throw new Error(`Unsafe privileged Lolka directory: ${directory}`);
    if (stat.mode & 0o020) await handle.chmod((stat.mode & 0o7777) & ~0o020);
  } finally { await handle.close(); }
}

try {
  if (!['inspect', 'install', 'uninstall', 'repair'].includes(operation) || !target || !path.isAbsolute(target) || extra.length) throw new Error('Invalid installer arguments');
  if (process.getuid?.() === 0) {
    // The privileged Linux helper only runs code and payload installed by root.
    // A writable user copy must never become an implicit root code loader.
    const protectedFiles = [fileURLToPath(import.meta.url), payloadDirectory, path.join(payloadDirectory, 'main.cjs'), path.join(payloadDirectory, 'preload.js'), path.join(payloadDirectory, 'build.json')];
    for (const file of protectedFiles) await assertProtectedAncestors(file);
    if (operation !== 'inspect') {
      if (process.platform !== 'linux') throw new Error('Use a user-owned Lolka installation on macOS');
      await assertProtectedAncestors(path.dirname(target));
      // Validate the selected host and its stopped state before changing even
      // directory permissions. Inspection parses ASAR data without executing it.
      await inspectInstallation(target);
      await ensureInstallationStopped(target);
      await protectVendorDirectory(target);
      await assertProtectedAncestors(target);
      const resources = path.join(target, 'resources');
      await protectVendorDirectory(resources);
      await assertProtectedAncestors(resources);
    }
  }
  const result = operation === 'inspect' ? await inspectInstallation(target) : await applyOperation(operation, target, { payloadDirectory });
  console.log(JSON.stringify({ ok: true, result }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error.message, code: error.code ?? 'INSTALL_FAILED' }));
  process.exitCode = 1;
}
