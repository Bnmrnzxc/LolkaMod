import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { CDP } from './cdp.mjs';
const cdp = await CDP.connect();
try {
  for (let i=0; i<80; i++) {
    if (await cdp.evaluate("document.readyState === 'complete' && !!window.electronAPI && document.getElementById('root')?.childElementCount > 0")) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const result = await cdp.evaluate(`(async () => ({ready:document.readyState, mod: typeof window.LolkaMod,
    modBridge: typeof window.LolkaModNative, panel: !!document.getElementById('lolkamod-panel'),
    appVersion: await window.electronAPI.getAppVersion(),
    electronApi: Object.keys(window.electronAPI || {}).sort(), rootChildren:document.getElementById('root')?.childElementCount}))()`);
  const baseline = JSON.parse(await fs.readFile('.runtime/evidence/baseline.json', 'utf8'));
  assert.deepEqual(result.electronApi, baseline.electronApi);
  assert.equal(result.mod, 'undefined'); assert.equal(result.modBridge, 'undefined');
  assert.equal(result.panel, false); assert.equal(result.appVersion, '1.0.120'); assert.ok(result.rootChildren > 0);
  await fs.writeFile('.runtime/evidence/disabled.json', JSON.stringify({status: 'PASS', ...result}, null, 2));
  console.log(JSON.stringify({status: 'PASS', ...result}));
} finally { cdp.close(); }
