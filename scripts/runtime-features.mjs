import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { CDP } from './cdp.mjs';
const c=await CDP.connect();
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const restart=process.argv.includes('--restart');
try {
  for(let i=0;i<80;i++){if(await c.evaluate('!!window.LolkaMod?.ready'))break;await pause(200);}
  const initial=await c.evaluate(`({version:window.LolkaMod.version,settings:window.LolkaMod.settings(),features:window.LolkaMod.diagnostics().features,plugins:window.LolkaMod.diagnostics().plugins})`);
  assert.deepEqual(initial.plugins.failed,[]);
  if(restart){assert.equal(initial.settings.themeId,'graphite');assert.equal(initial.settings.indicatorEnabled,true);}
  const setup=await c.evaluate(`(()=>{
    window.__lmFeatureSaved=window.LolkaMod.settings();
    window.__lmSettingsTest?.();document.getElementById('lm-settings-test')?.remove();
    const a=window.LolkaMod.modules.get('HostSettings');a.open();
    const div=document.createElement('div');div.id='lm-settings-test';document.body.append(div);window.__lmSettingsTest=a.test.mount(div);return true;
  })()`);assert.equal(setup,true);await pause(250);
  const native=await c.evaluate(`({tabs:[...document.querySelectorAll('button')].filter(b=>b.textContent==='LolkaMod').length,embedded:document.querySelectorAll('#lolkamod-embedded-settings').length,settings:document.querySelectorAll('[data-lolkamod-host-settings]').length})`);
  assert.deepEqual(native,{tabs:1,embedded:1,settings:1});
  await c.evaluate(`(()=>{const theme=document.getElementById('lolkamod-embedded-settings').shadowRoot.querySelector('select[data-setting=themeId]');theme.value='graphite';theme.dispatchEvent(new Event('change'));})()`);
  for(let i=0;i<30;i++){if(await c.evaluate('window.LolkaMod.settings().themeId === "graphite"'))break;await pause(100);}
  const themes=[];
  for(const id of ['graphite','amoled','contrast','native']){
    themes.push(await c.evaluate(`(async()=>{await window.LolkaMod.saveSettings({themeId:${JSON.stringify(id)}});return {id:window.LolkaMod.settings().themeId,attribute:document.documentElement.getAttribute('data-lolkamod-theme'),styles:document.querySelectorAll('#lolkamod-built-in-theme').length,color:getComputedStyle(document.documentElement).getPropertyValue('--color-bg-primary').trim()}})()`));
  }
  assert.equal(themes[0].color,'#17191d');assert.equal(themes[1].color,'#000000');assert.equal(themes[2].color,'#07090d');assert.equal(themes[3].styles,0);assert.equal(themes[3].attribute,null);
  const noStream=await c.evaluate(`(async()=>{await window.LolkaMod.saveSettings({indicatorEnabled:true,indicatorDetailed:true});await window.LolkaMod.streams.sample();return {indicator:window.LolkaMod.streams.snapshot().indicator,dom:!!document.getElementById('lolkamod-stream-indicator')};})()`);
  assert.equal(noStream.dom,true);assert.equal(noStream.indicator.status,'idle');
  const controls=await c.evaluate(`(async()=>{
    const api=window.LolkaMod, original=api.modules.get('StreamControls'),calls=[];
    const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;canvas.getContext('2d').fillRect(0,0,320,180);
    const trackStream=canvas.captureStream(30), video=document.createElement('video');video.muted=true;video.autoplay=true;video.srcObject=trackStream;document.body.append(video);await video.play();
    await new Promise(r=>setTimeout(r,100));let requests=0;
    Object.defineProperty(video,'requestPictureInPicture',{configurable:true,value:()=>{requests++;return Promise.resolve({width:320,height:180})}});
    api.modules.register('StreamControls',{active:()=>({resolution:'720p',fps:30,codec:'vp9'}),setQuality:async p=>{calls.push(['quality',p]);return {success:true}},videos:()=>[{id:'synthetic',video,title:'Тестовый поток'}],nativePip:()=>false,pipAvailable:()=>true,pip:()=>{throw new Error('Unexpected native PiP')},closePip:()=>{}},'synthetic-ui-test');
    const box=document.createElement('div');document.body.append(box);const dispose=api.mountStreamMenu(box,{active:true,onStop:()=>calls.push(['stop']),onSource:async()=>calls.push(['source'])});
    const root=box.querySelector('span').shadowRoot;root.querySelector('.arrow').click();
    const selects=root.querySelectorAll('select');selects[0].value='1440p';selects[1].value='60';selects[2].value='VP9';
    [...root.querySelectorAll('button')].find(b=>b.textContent==='Применить качество').click();await new Promise(r=>setTimeout(r,100));
    [...root.querySelectorAll('button')].find(b=>b.textContent==='Изменить источник').click();await new Promise(r=>setTimeout(r,100));
    root.querySelector('.arrow').click();[...root.querySelectorAll('button')].find(b=>b.textContent==='Мини-плеер').click();await new Promise(r=>setTimeout(r,100));
    root.querySelector('.arrow').click();[...root.querySelectorAll('button')].find(b=>b.textContent==='Прекратить стрим').click();await new Promise(r=>setTimeout(r,100));
    const keys=['screenShareResolution','screenShareFps','screenShareCodecV3'].map(k=>localStorage.getItem(k));
    dispose();box.remove();trackStream.getTracks().forEach(t=>t.stop());video.remove();api.modules.register('StreamControls',original,'restored-live-host');
    return {calls,requests,keys,extraPeers:api.streams.snapshot().diagnostics.state.connections};
  })()`);
  assert.deepEqual(controls.calls,[['quality',{resolution:'1440p',fps:60,codec:'vp9'}],['source'],['stop']]);assert.equal(controls.requests,1);assert.equal(controls.extraPeers,0);assert.deepEqual(controls.keys,['1440p','60','vp9']);
  const lifecycle=await c.evaluate(`(()=>{const api=window.LolkaMod;for(let i=0;i<100;i++){api.stop();api.start();}return {panel:document.querySelectorAll('#lolkamod-panel').length,embedded:document.querySelectorAll('#lolkamod-embedded-settings').length,failed:api.diagnostics().plugins.failed,indicator:document.querySelectorAll('#lolkamod-stream-indicator').length}})()`);
  assert.deepEqual(lifecycle,{panel:1,embedded:1,failed:[],indicator:1});
  const update=await c.evaluate('window.LolkaMod.checkUpdates()');assert.ok(['current','ahead','available','error','rate-limited'].includes(update.state));
  await c.evaluate(`(async()=>{await window.LolkaMod.saveSettings({themeId:'graphite',indicatorEnabled:true});window.__lmSettingsTest();document.getElementById('lm-settings-test')?.remove();delete window.__lmSettingsTest;})()`);
  const evidence={status:'PASS',version:initial.version,coldRestart:restart,initial,native,themes,noStream,controls,lifecycle,update,limit:'Empty isolated profile. Menu actions and browser PiP request use explicit synthetic mocks. Real active SFU source replacement, native PiP window and audio remain NOT RUN.',testedAt:new Date().toISOString()};
  await fs.writeFile(`.runtime/evidence/features${restart?'-restart':''}-0.5.0.json`,JSON.stringify(evidence,null,2));
  console.log(JSON.stringify({status:'PASS',native,themes:themes.map(t=>t.id),lifecycle,update:update.state}));
}finally{c.close();}
