import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectInstallation, applyOperation } from './portable-platform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const payloadDirectory = path.join(here, path.basename(fileURLToPath(import.meta.url)) === 'backend.mjs' ? 'dist' : '../dist');
const [operation, target, ...extra] = process.argv.slice(2);
try {
  if (!['inspect', 'install', 'uninstall', 'repair'].includes(operation) || !target || !path.isAbsolute(target) || extra.length) throw new Error('Invalid installer arguments');
  if (process.getuid?.() === 0) {
    // The privileged Linux helper only runs code and payload installed by root.
    // A writable user copy must never become an implicit root code loader.
    const protectedFiles = [fileURLToPath(import.meta.url), payloadDirectory, path.join(payloadDirectory, 'main.cjs'), path.join(payloadDirectory, 'preload.js'), path.join(payloadDirectory, 'build.json')];
    if (operation !== 'inspect') protectedFiles.push(path.resolve(target), path.join(target, 'resources'));
    for (const file of protectedFiles) {
      for (let current = path.resolve(file); ; current = path.dirname(current)) {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink() || stat.uid !== 0 || stat.mode & 0o022) throw new Error('Privileged installer files must be root-owned and not writable by other users');
        if (path.dirname(current) === current) break;
      }
    }
  }
  const result = operation === 'inspect' ? await inspectInstallation(target) : await applyOperation(operation, target, { payloadDirectory });
  console.log(JSON.stringify({ ok: true, result }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error.message, code: error.code ?? 'INSTALL_FAILED' }));
  process.exitCode = 1;
}
