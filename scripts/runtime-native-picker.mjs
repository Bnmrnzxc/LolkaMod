import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { CDP } from './cdp.mjs';
const restart = process.argv.includes('--restart');
const cdp = await CDP.connect();
const pause = () => new Promise(resolve=>setTimeout(resolve,200));
try {
  for(let i=0;i<80;i++) {
    if(await cdp.evaluate('!!window.LolkaMod?.modules.get("ScreenShareSettings")?.test')) break;
    await pause();
  }
  const initial = await cdp.evaluate(`(() => {
    const a=window.LolkaMod.modules.get('ScreenShareSettings');
    window.__lmNativePicker?.dispose();document.getElementById('lm-native-picker-test')?.remove();
    const before=a.snapshot();
    const container=document.createElement('div');container.id='lm-native-picker-test';document.body.append(container);
    window.__lmNativePicker={dispose:a.test.mountPicker(container,(...args)=>{window.__lmNativePicker.selection=args})};
    return {version:window.LolkaMod.version,before,profile:a.test.profile(),capabilities:a.capabilities()};
  })()`);
  if(restart) {
    assert.equal(initial.before.resolution,'1440p');assert.equal(initial.before.fps,'60');
  }
  await pause();
  const trials=[];
  for(const [resolution,fps] of [['1440p','60 FPS'],['720p','30 FPS'],['1080p','30 FPS'],['1440p','60 FPS']]) {
    const options={};
    for(const [index,value] of [[1,resolution],[2,fps]]) {
      await cdp.evaluate(`document.getElementById('lm-native-picker-test').querySelectorAll('[role=combobox]')[${index}].click()`);
      await pause();
      const available=await cdp.evaluate(`[...document.querySelectorAll('[role=option]')].map(o=>({text:o.textContent,disabled:o.getAttribute('aria-disabled')}))`);
      options[index]=available;
      assert.deepEqual(available.map(o=>o.text),index===1?['720p','1080p','1440p']:['30 FPS','60 FPS']);
      assert.ok(available.every(o=>o.disabled!=='true'));
      await cdp.evaluate(`(() => {const option=[...document.querySelectorAll('[role=option]')].find(o=>o.textContent===${JSON.stringify(value)});if(!option)throw new Error('Missing option');option.click()})()`);
      await pause();
    }
    await cdp.evaluate(`document.getElementById('lm-native-picker-test').querySelector('button[class*=sourceCard]').click()`);
    await pause();
    const result=await cdp.evaluate(`({selection:window.__lmNativePicker.selection,stored:window.LolkaMod.modules.get('ScreenShareSettings').snapshot(),profile:window.LolkaMod.modules.get('ScreenShareSettings').test.profile()})`);
    assert.equal(result.selection[2],resolution);assert.equal(result.selection[3],Number(fps.split(' ')[0]));
    assert.equal(result.stored.resolution,resolution);assert.equal(result.stored.fps,String(result.selection[3]));
    trials.push({resolution,fps,options,result});
  }
  // A 0.2 profile must never rewrite native keys or enforce capture parameters.
  const legacyIsolation=await cdp.evaluate(`(async()=>{
    const api=window.LolkaMod,saved=api.settings(),adapter=api.modules.get('ScreenShareSettings');
    await api.saveSettings({qualityEnabled:true,profile:{resolution:'720p',fps:30,codec:'VP8',bitrateMbps:6}});
    const keys=adapter.snapshot();await api.saveSettings(saved);
    return {keys,plugins:api.diagnostics().plugins};
  })()`);
  assert.equal(legacyIsolation.keys.resolution,'1440p');assert.equal(legacyIsolation.keys.fps,'60');
  assert.equal(legacyIsolation.plugins.registered.includes('StreamQuality'),false);
  await cdp.evaluate(`(()=>{
    const d=document.getElementById('lm-native-picker-test');window.__lmNativePicker.dispose();
    window.__lmNativePicker.dispose=window.LolkaMod.modules.get('ScreenShareSettings').test.mountPicker(d,()=>{});
  })()`);
  await pause();
  const reopened=await cdp.evaluate(`[...document.getElementById('lm-native-picker-test').querySelectorAll('[role=combobox]')].map(o=>o.textContent)`);
  assert.deepEqual(reopened,['VP9','1440p','60 FPS']);
  const evidence={status:'PASS',test:'stock-Lolka-React-picker-with-synthetic-source',coldRestart:restart,initial,trials,legacyIsolation,reopened,
    testedAt:new Date().toISOString(),limit:'Hidden isolated clone; no login, OS capture, audio, active SFU session or friend viewing.'};
  await fs.writeFile(`.runtime/evidence/native-picker${restart?'-restart':''}-0.4.0.json`,JSON.stringify(evidence,null,2));
  console.log(JSON.stringify({status:evidence.status,coldRestart:restart,nativeSelections:trials.map(t=>[t.resolution,t.fps]),reopened}));
} finally {
  try {await cdp.evaluate(`(()=>{window.__lmNativePicker?.dispose();document.getElementById('lm-native-picker-test')?.remove();delete window.__lmNativePicker})()`);} finally{cdp.close();}
}
