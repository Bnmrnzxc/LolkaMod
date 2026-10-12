import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = path.resolve('.runtime/platform-fixtures');
const bucket = 'https://storage.yandexcloud.net/lolka-electron/releases/';
const fixtures = process.platform === 'darwin' ? [
  { file: 'Lolka-1.0.113-arm64-mac.zip', size: 108113882, sha256: '1dfd23cd185629b7570700683cf100e71688387e1ba3ad50567f6c85036bc327', kind: 'mac' },
] : process.platform === 'linux' ? [
  { file: 'Lolka_1.0.100_amd64.deb', size: 92414780, sha256: '15c25d3c45314d859db3753764d1b0e6d91d2528c410ef070f502483bdfc9b2c', kind: 'deb' },
  { file: 'Lolka-1.0.100.x86_64.rpm', size: 81892977, sha256: '06878c792b541f4bb052e5e52d1890b019dd998851fd48b12851e76c6e60eed8', kind: 'rpm' },
] : [];
if (!fixtures.length) throw new Error('Platform fixtures require Linux or macOS');
await fs.mkdir(root, { recursive: true });
for (const fixture of fixtures) {
  const file = path.join(root, fixture.file);
  let bytes = await fs.readFile(file).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (!bytes) {
    const response = await fetch(bucket + fixture.file, { redirect: 'error', signal: AbortSignal.timeout(120000) });
    if (!response.ok || Number(response.headers.get('content-length')) !== fixture.size) throw new Error('Unexpected vendor package response');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length; if (size > fixture.size) throw new Error('Vendor package exceeds pinned size'); chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks); await fs.writeFile(file, bytes, { flag: 'wx' });
  }
  if (bytes.length !== fixture.size || crypto.createHash('sha256').update(bytes).digest('hex') !== fixture.sha256) throw new Error('Vendor package SHA256 mismatch');
  const destination = path.join(root, fixture.kind);
  if (await fs.lstat(destination).then(() => true, () => false)) throw new Error('Fixture destination exists; use a fresh CI checkout');
  await fs.mkdir(destination);
  // Only data is extracted; no DEB/RPM maintainer script is executed.
  if (fixture.kind === 'mac') await run('/usr/bin/ditto', ['-x', '-k', file, destination]);
  else if (fixture.kind === 'deb') await run('dpkg-deb', ['-x', file, destination]);
  else await run('bsdtar', ['-xf', file, '-C', destination]);
  console.log(JSON.stringify({ kind: fixture.kind, sha256: fixture.sha256, root: path.join(destination, fixture.kind === 'mac' ? 'Lolka.app' : 'opt/Lolka') }));
}
