import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { extractFile } from '@electron/asar';
import { hash, inspectHost, DEFAULT_INSTALLATION } from './install.mjs';
const installation = path.resolve(process.argv[2] || DEFAULT_INSTALLATION);
const resources = path.join(installation, 'resources'), modDir = path.join(resources, 'lolkamod');
const { version } = JSON.parse(await fs.readFile('package.json', 'utf8'));
const manifest = JSON.parse(await fs.readFile(path.join(modDir, 'install.json'), 'utf8'));
assert.equal(manifest.modVersion, version);
const original = path.join(resources, '_app.asar');
assert.equal(hash(await fs.readFile(original)), manifest.originalHash);
const host = inspectHost(await fs.readFile(original));
assert.equal(host.version, manifest.hostVersion);
assert.equal(hash(await fs.readFile(path.join(resources, 'app.asar'))), manifest.shimHash);
assert.equal(await fs.readFile(path.join(modDir, 'main.cjs'), 'utf8'), await fs.readFile('dist/main.cjs', 'utf8'));
const expectedPreload = `// Original preload retained in its own scope.\n(function(){\n${extractFile(original, manifest.hostPreload || 'dist-js/preload.js').toString()}\n})();\n${await fs.readFile('dist/preload.js', 'utf8')}`;
assert.equal(await fs.readFile(path.join(modDir, 'preload.js'), 'utf8'), expectedPreload);
const config = JSON.parse(await fs.readFile(path.join(modDir, 'config.json'), 'utf8'));
assert.equal(config.hostMain || 'dist-js/main.js', 'dist-js/main.js');
assert.equal(config.hostPreload || 'dist-js/preload.js', 'dist-js/preload.js');
assert.equal(config.baseline, false);
if (!config.testMode) assert.equal(config.userData, undefined);
const compatibility = await fs.readFile(path.join(modDir, 'compatibility.json'), 'utf8').then(JSON.parse, () => null);
console.log(JSON.stringify({ status: 'PASS', installed: version, hostVersion: host.version,
  originalBackupHash: manifest.originalHash, testMode: config.testMode === true,
  sourceAdapter: compatibility, limit: 'Archive/payload verification only; runtime and stream acceptance are separate.' }));
