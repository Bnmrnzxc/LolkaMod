import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { bundleDigest, macStateDirectory, readFuseState } from '../scripts/portable-platform.mjs';

const wire = flags => Buffer.concat([Buffer.from('binary-prefix:dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'), Buffer.from([1, flags.length]), Buffer.from(flags), Buffer.from('binary-suffix')]);
test('fuse inspection distinguishes existing host policy without modifying a binary', () => {
  const bytes = wire('10110001'), before = Buffer.from(bytes);
  assert.deepEqual(readFuseState(bytes), { asarIntegrity: false, onlyAsar: false });
  assert.deepEqual(bytes, before);
  assert.deepEqual(readFuseState(wire('10111101')), { asarIntegrity: true, onlyAsar: true });
  for (const invalid of [Buffer.from('no-fuses'), wire('101'), wire('101z0001'), Buffer.concat([bytes, bytes])]) assert.throws(() => readFuseState(invalid));
});

test('full bundle backup digest covers contents and normal framework symlinks', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'lolkamod-bundle-digest-'));
  try {
    const app = path.join(folder, 'Lolka.app'); await fs.mkdir(path.join(app, 'Versions/A'), { recursive: true });
    const binary = path.join(app, 'Versions/A/Electron'); await fs.writeFile(binary, 'original executable');
    const first = await bundleDigest(app);
    await fs.writeFile(binary, 'modified executable'); assert.notEqual(await bundleDigest(app), first);
    await fs.writeFile(binary, 'original executable'); assert.equal(await bundleDigest(app), first);
    if (process.platform !== 'win32') {
      await fs.symlink('A', path.join(app, 'Versions/Current'));
      const linked = await bundleDigest(app); assert.notEqual(linked, first);
      await fs.chmod(binary, 0o755); assert.notEqual(await bundleDigest(app), linked);
      await fs.symlink('../../outside', path.join(app, 'escape'));
      await assert.rejects(bundleDigest(app), /external symbolic link/);
    }
    assert.equal(path.dirname(macStateDirectory(app)), folder);
    assert.notEqual(macStateDirectory(app), macStateDirectory(path.join(folder, 'Other.app')));
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});
