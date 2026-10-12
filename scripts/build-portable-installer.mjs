import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build as esbuild } from 'esbuild';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const appDir = path.join(root, '.staging', 'portable-app');
const resourcesDir = path.join(root, '.staging', 'portable-resources');
const outputDir = path.join(root, 'release', 'portable');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const require = createRequire(import.meta.url);
const builderConfig = require('../electron-builder.config.cjs');

function parseArgs(argv) {
  let platform = null;
  let directoryOnly = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dir') {
      if (directoryOnly) throw new Error('--dir may be specified only once');
      directoryOnly = true;
    } else if (arg === '--platform') {
      if (platform !== null) throw new Error('--platform may be specified only once');
      platform = argv[++i];
      if (!['mac', 'linux'].includes(platform)) throw new Error('--platform must be mac or linux');
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (directoryOnly && platform !== null) throw new Error('--dir builds an unpacked app for the current platform; omit --platform');
  if (!directoryOnly && platform === null) {
    if (process.platform === 'darwin') platform = 'mac';
    else if (process.platform === 'linux') platform = 'linux';
    else throw new Error('Choose --platform mac or --platform linux, or use --dir for a local unpacked app');
  }
  if (!directoryOnly && platform === 'mac' && process.platform !== 'darwin') {
    throw new Error('macOS arm64 packages must be built on macOS');
  }
  if (!directoryOnly && platform === 'linux' && process.platform !== 'linux') {
    throw new Error('Linux packages must be built on Linux');
  }
  return { platform, directoryOnly };
}

const { platform, directoryOnly } = parseArgs(process.argv.slice(2));

function configForCurrentBuild() {
  const config = { ...builderConfig };
  if (directoryOnly) {
    delete config.mac;
    delete config.linux;
    delete config.deb;
    delete config.rpm;
  } else if (platform === 'mac') {
    delete config.linux;
    delete config.win;
    delete config.deb;
    delete config.rpm;
  } else {
    delete config.mac;
    delete config.win;
  }
  return config;
}

async function resetStage(directory) {
  const stageRoot = path.join(root, '.staging');
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== stageRoot || !resolved.startsWith(stageRoot + path.sep)) {
    throw new Error(`Refusing to reset path outside the portable staging area: ${resolved}`);
  }
  await fs.rm(resolved, { recursive: true, force: true });
  await fs.mkdir(resolved, { recursive: true });
}

async function copyFile(relative, destination) {
  const source = path.join(root, relative);
  const stat = await fs.lstat(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a regular source file: ${relative}`);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

await resetStage(appDir);
await resetStage(resourcesDir);
await fs.mkdir(outputDir, { recursive: true });

const appFiles = [
  ['DesktopInstaller/main.mjs', 'main.mjs'],
  ['DesktopInstaller/preload.cjs', 'preload.cjs'],
  ['DesktopInstaller/renderer.html', 'renderer.html'],
  ['DesktopInstaller/renderer.css', 'renderer.css'],
  ['DesktopInstaller/renderer.js', 'renderer.js'],
  ['assets/branding/logo.png', 'logo.png'],
  ['assets/branding/app.ico', 'app.icon'],
  ['assets/branding/app.ico', 'app.ico'],
  ['LICENSE', 'LICENSE'],
  ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
];
for (const [source, name] of appFiles) await copyFile(source, path.join(appDir, name));

const appPackage = {
  name: 'lolkamod-installer',
  productName: 'LolkaMod Installer',
  desktopName: 'LolkaMod',
  version: pkg.version,
  description: pkg.description,
  license: 'MIT',
  author: { name: 'LolkaMod contributors', email: 'Bnmrnzxc@users.noreply.github.com' },
  homepage: 'https://github.com/Bnmrnzxc/LolkaMod',
  private: true,
  type: 'module',
  main: 'main.mjs',
  dependencies: {},
};
await fs.writeFile(path.join(appDir, 'package.json'), `${JSON.stringify(appPackage, null, 2)}\n`);

await esbuild({
  entryPoints: [path.join(root, 'scripts', 'portable-cli.mjs')],
  outfile: path.join(resourcesDir, 'backend.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['electron', 'original-fs'],
  legalComments: 'none',
});
await esbuild({
  entryPoints: [path.join(root, 'DesktopInstaller', 'main.mjs')],
  outfile: path.join(appDir, 'main.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['electron'],
  legalComments: 'none',
});

const payloadDir = path.join(resourcesDir, 'dist');
await fs.mkdir(payloadDir, { recursive: true });
for (const name of ['main.cjs', 'preload.js', 'build.json']) {
  await copyFile(`dist/${name}`, path.join(payloadDir, name));
}

const manifestEntries = [];
for (const relative of [
  'backend.mjs',
  'dist/main.cjs',
  'dist/preload.js',
  'dist/build.json',
]) {
  const bytes = await fs.readFile(path.join(resourcesDir, relative));
  manifestEntries.push({ file: relative.replaceAll(path.sep, '/'), bytes: bytes.length, sha256: sha256(bytes) });
}
const manifest = { schemaVersion: 1, version: pkg.version, files: manifestEntries };
await fs.writeFile(path.join(resourcesDir, 'portable-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await fs.chmod(path.join(resourcesDir, 'backend.mjs'), 0o644);

if (directoryOnly) {
  console.log(JSON.stringify({ stagedApp: appDir, stagedResources: resourcesDir, packageDir: outputDir, mode: 'dir' }));
  const { build, Platform } = await import('electron-builder');
  await build({
    config: configForCurrentBuild(),
    targets: Platform.current().createTarget('dir'),
  });
} else {
  const { build, Platform, Arch } = await import('electron-builder');
  const targets = platform === 'mac'
    ? Platform.MAC.createTarget(['dmg', 'zip'], Arch.arm64)
    : Platform.LINUX.createTarget(['deb', 'rpm'], Arch.x64);
  console.log(JSON.stringify({ platform, version: pkg.version, output: outputDir }));
  await build({ config: configForCurrentBuild(), targets });
}
