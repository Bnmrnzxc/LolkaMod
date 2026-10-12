const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function isRegularFile(file) {
  try {
    const stat = await fs.lstat(file);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function locateResources(appOutDir) {
  const candidates = [
    path.join(appOutDir, 'resources'),
    path.join(appOutDir, 'Contents', 'Resources'),
    path.join(appOutDir, 'LolkaMod Installer.app', 'Contents', 'Resources'),
  ];
  for (const candidate of candidates) {
    if (await isRegularFile(path.join(candidate, 'portable-manifest.json'))) return candidate;
  }
  throw new Error(`Portable resources manifest is missing under ${appOutDir}`);
}

module.exports = async function afterPack(context) {
  const resourcesDir = await locateResources(context.appOutDir);
  const manifest = JSON.parse(await fs.readFile(path.join(resourcesDir, 'portable-manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) {
    throw new Error('Portable resources manifest has an unsupported schema');
  }
  const expected = new Set(['backend.mjs', 'dist/main.cjs', 'dist/preload.js', 'dist/build.json']);
  for (const entry of manifest.files) {
    if (!entry || typeof entry.file !== 'string' || !expected.delete(entry.file)) {
      throw new Error('Portable resources manifest contains an unexpected or duplicate file');
    }
    const file = path.resolve(resourcesDir, entry.file);
    if (path.dirname(file) !== resourcesDir && !file.startsWith(resourcesDir + path.sep)) {
      throw new Error(`Portable resources manifest path escapes resources: ${entry.file}`);
    }
    if (!(await isRegularFile(file))) throw new Error(`Portable resource is missing or linked: ${entry.file}`);
    const bytes = await fs.readFile(file);
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
      throw new Error(`Portable resource integrity mismatch: ${entry.file}`);
    }
  }
  if (expected.size !== 0) throw new Error(`Portable resources manifest is incomplete: ${[...expected].join(', ')}`);
};
