import { build } from 'esbuild';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { transform } from 'esbuild';
// Validate the complete offline pack before producing an installer payload.
const compileModule = async entry => {
  const result = await build({ entryPoints: [entry], bundle: true, write: false,
    platform: 'node', format: 'esm', target: 'node22' });
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
};
const { DISCORD_SOUND_ASSETS } = await compileModule('src/shared/discord-sounds.ts');
const { createBundledSoundPackService } = await compileModule('src/main/bundled-sound-pack-service.ts');
const bundledSounds = JSON.parse(await readFile('assets/sounds/discord/classic.json', 'utf8'));
const soundVerifier = createBundledSoundPackService(DISCORD_SOUND_ASSETS, bundledSounds);
await soundVerifier.load(); soundVerifier.stop();
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/renderer/index.ts'], outfile: 'dist/renderer.js', bundle: true,
  platform: 'browser', format: 'iife', target: 'chrome144', legalComments: 'none' });
const renderer = await readFile('dist/renderer.js', 'utf8');
const thirdPartyNotice = await readFile('THIRD_PARTY_NOTICES.md', 'utf8');
await build({ entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload.js', bundle: true,
  platform: 'browser', format: 'iife', target: 'chrome144', external: ['electron'],
  define: { __RENDERER_SOURCE__: JSON.stringify(renderer) }, legalComments: 'none' });
await build({ entryPoints: ['src/main/index.ts'], outfile: 'dist/main.cjs', bundle: true,
  platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], legalComments: 'none',
  banner: { js: `/*\n${thirdPartyNotice.replaceAll('*/', '* /')}\n*/` } });
for (const entry of ['settings', 'lifecycle', 'source-adapter', 'stream-diagnostics', 'stream-quality', 'patcher']) {
  await build({ entryPoints: [entry === 'settings' ? 'src/shared/settings.ts' : entry === 'source-adapter' ? 'src/main/source-adapter.ts' : `src/renderer/${entry}.ts`],
    outfile: `dist/${entry}.mjs`, bundle: true, platform: 'node', format: 'esm', target: 'node22' });
}
const { transformEntry, sourceAdapterReference } = await import('../dist/source-adapter.mjs?build=' + Date.now());
await transform(sourceAdapterReference, { loader: 'js', format: 'esm', target: 'chrome144' });
const pinnedFixture = 'research/public-frontend/pinned-entry.js';
let hasPinnedFixture = true;
try {
  await access(pinnedFixture, constants.R_OK);
} catch (error) {
  if (error && error.code === 'ENOENT') hasPinnedFixture = false;
  else throw error;
}
if (hasPinnedFixture) {
  const pinnedEntry = await readFile(pinnedFixture, 'utf8');
  const patchedEntry = transformEntry(pinnedEntry);
  if (!patchedEntry.changed) throw new Error('Pinned source entry does not match patch manifest');
  await transform(patchedEntry.body, { loader: 'js', format: 'esm', target: 'chrome144' });
}
const packageInfo = JSON.parse(await readFile('package.json', 'utf8'));
await writeFile('dist/build.json', JSON.stringify({ version: packageInfo.version, builtAt: new Date().toISOString() }, null, 2));
