import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ENTRY_HASH } from '../dist/source-adapter.mjs';

const loginUrl = new URL('https://lolka.app/login');
const fixturePath = fileURLToPath(new URL('../research/public-frontend/pinned-entry.js', import.meta.url));
const maximumBytes = 20 * 1024 * 1024;
const entryPathPattern = /^\/assets\/index-[\w-]+\.js$/;

function isAllowedLoginUrl(url) {
  return url.protocol === 'https:' && url.origin === loginUrl.origin && url.pathname === '/login'
    && !url.username && !url.password && !url.search && !url.hash;
}

function isAllowedEntryUrl(url) {
  return url.protocol === 'https:' && url.origin === loginUrl.origin && entryPathPattern.test(url.pathname)
    && !url.username && !url.password && !url.search && !url.hash;
}

async function fetchBytes(url, acceptUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      credentials: 'omit',
      headers: { 'user-agent': 'LolkaMod-PublicSourceCheck/1.0' },
      signal: controller.signal,
    });
    const finalUrl = new URL(response.url);
    if (!acceptUrl(finalUrl)) throw new Error('Request redirected outside the permitted public URL.');
    if (!response.ok) throw new Error('Public source request failed with HTTP ' + response.status + '.');
    if (!response.body) throw new Error('Public source response had no body.');
    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        totalBytes += part.value.length;
        if (totalBytes > maximumBytes) {
          await reader.cancel();
          throw new Error('Public source response exceeded 20 MiB.');
        }
        chunks.push(Buffer.from(part.value));
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, totalBytes);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const htmlBytes = await fetchBytes(loginUrl, isAllowedLoginUrl);
  const html = htmlBytes.toString('utf8');
  const scriptPattern = /<script\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1/gi;
  const candidateUrls = new Set();
  let match;
  while ((match = scriptPattern.exec(html)) !== null) {
    let candidate;
    try {
      candidate = new URL(match[2], loginUrl);
    } catch {
      continue;
    }
    if (isAllowedEntryUrl(candidate)) candidateUrls.add(candidate.href);
  }

  if (candidateUrls.size === 0) {
    throw new Error('Login HTML contained no permitted https://lolka.app/assets/index-*.js entry.');
  }

  const mismatches = [];
  for (const candidateUrl of candidateUrls) {
    const source = await fetchBytes(new URL(candidateUrl), isAllowedEntryUrl);
    const hash = createHash('sha256').update(source).digest('hex');
    if (hash !== ENTRY_HASH) {
      mismatches.push(candidateUrl + ' sha256=' + hash);
      continue;
    }

    await mkdir(new URL('../research/public-frontend/', import.meta.url), { recursive: true });
    await writeFile(fixturePath, source, { flag: 'w' });
    process.stdout.write('Pinned public source fixture saved; sha256=' + hash + '\n');
    return;
  }

  throw new Error('No public entry matched source adapter hash ' + ENTRY_HASH + '.\n' + mismatches.join('\n'));
}

main().catch((error) => {
  process.stderr.write('Frontend fixture fetch failed: ' + (error && error.message ? error.message : String(error)) + '\n');
  process.exitCode = 1;
});
