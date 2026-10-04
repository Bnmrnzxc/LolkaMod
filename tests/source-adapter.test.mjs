import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { transform } from 'esbuild';
import { transformEntry, sourceAdapterReference, nativeQualityPatches, ENTRY_HASH } from '../dist/source-adapter.mjs';

const fixturePath = 'research/public-frontend/pinned-entry.js';

test('unknown ESM entry returns its original bytes without a patch', () => {
  const body = 'const eo = {}; // unknown version\n';
  const result = transformEntry(body);
  assert.equal(result.changed, false);
  assert.equal(result.status, 'unsupported-hash');
  assert.equal(result.body, body);
});
test('appended source adapter reference parses without the private vendor fixture', async () => {
  await transform(sourceAdapterReference, { loader: 'js', format: 'esm' });
});

test('pinned ESM transform commits all native-quality patches and parses in its original scope', {
  skip: !existsSync(fixturePath),
}, async () => {
  const original = await fs.readFile(fixturePath, 'utf8');
  const result = transformEntry(original);
  assert.equal(result.changed, true);
  assert.equal(result.hash, ENTRY_HASH);
  assert.deepEqual(result.patches, nativeQualityPatches.map(p=>p.id));
  assert.equal(result.body.endsWith(sourceAdapterReference), true);
  assert.equal(result.body.includes('eo.getState().screenShareBitrate'), true);
  await transform(result.body, { loader: 'js', format: 'esm' });
  // Mutating one byte invalidates the patch; reapplying to already patched code also refuses.
  assert.equal(transformEntry(original + ' ').changed, false);
  assert.equal(transformEntry(result.body).changed, false);
});
