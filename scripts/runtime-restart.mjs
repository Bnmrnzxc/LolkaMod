import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { CDP } from './cdp.mjs';
const cdp = await CDP.connect();
try {
  let result;
  for (let i=0; i<80; i++) {
    result = await cdp.evaluate(`({ready: window.LolkaMod?.ready, settings: window.LolkaMod?.settings(),
      applied: !!document.documentElement && getComputedStyle(document.documentElement).getPropertyValue('--lolkamod-smoke-test').trim() === '1440',
      reference: !!window.LolkaMod?.modules.get('ScreenShareSettings'),
      panelCount: document.querySelectorAll('#lolkamod-panel').length})`);
    if (result.ready && result.reference) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.deepEqual(result.settings, {
    enabled: true,
    customCss: 'html { --lolkamod-smoke-test: 1440; }',
    qualityEnabled: false,
    profile: { resolution: '1440p', fps: 30, codec: 'auto', bitrateMbps: 16 },
  });
  assert.equal(result.applied, true); assert.equal(result.reference, true); assert.equal(result.panelCount, 1);
  await fs.writeFile('.runtime/evidence/restart.json', JSON.stringify({status: 'PASS', ...result}, null, 2));
  console.log(JSON.stringify({status: 'PASS', ...result}));
} finally { cdp.close(); }
