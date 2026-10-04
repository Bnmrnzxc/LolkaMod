import fs from 'node:fs/promises';
import { CDP } from './cdp.mjs';
const cdp = await CDP.connect();
try {
  const baseline = await cdp.evaluate(`({ ready: document.readyState, origin: location.origin,
    electronApi: Object.keys(window.electronAPI || {}).sort(),
    nodeRequire: typeof window.require, mod: typeof window.LolkaMod,
    rootChildren: document.getElementById('root')?.childElementCount,
    scripts: [...document.scripts].filter(s=>s.type==='module').length })`);
  baseline.main = JSON.parse(await fs.readFile('.runtime/desktop/resources/lolkamod/runtime.json', 'utf8'));
  await fs.mkdir('.runtime/evidence', { recursive: true });
  await fs.writeFile('.runtime/evidence/baseline.json', JSON.stringify(baseline, null, 2));
  console.log(JSON.stringify(baseline, null, 2));
} finally { cdp.close(); }
