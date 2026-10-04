import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { CDP } from './cdp.mjs';
const c=await CDP.connect();
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const restart=process.argv.includes('--restart');
try {
  for(let i=0;i<80;i++){if(await c.evaluate('!!window.LolkaMod?.ready'))break;await pause(200);}
  const initial=await c.evaluate(`({version:window.LolkaMod.version,settings:window.LolkaMod.settings(),features:window.LolkaMod.diagnostics().features,plugins:window.LolkaMod.diagnostics().plugins,testOnlyProfile:window.LolkaMod.diagnostics().desktop.testMode,miniRemoved:{api:typeof window.LolkaMod.openMini==='undefined',diagnostics:!('mini' in window.LolkaMod.diagnostics()),dom:document.querySelectorAll('#lolkamod-floating-mini-player,[data-lolkamod-owned=mini-menu]').length,settings:['miniPlayerEnabled','miniPlayerDock'].filter(k=>k in window.LolkaMod.settings())}})`);
  assert.equal(initial.testOnlyProfile,true,'Only the isolated no-auth test profile is supported');
  assert.deepEqual(initial.plugins.failed,[]);
  assert.deepEqual(initial.miniRemoved,{api:true,diagnostics:true,dom:0,settings:[]});assert.equal('pip' in initial.features,false);
  if(restart){assert.equal(initial.settings.themeId,'graphite');assert.equal(initial.settings.indicatorEnabled,true);}
  const setup=await c.evaluate(`(()=>{
    window.__lmFeatureSaved=window.LolkaMod.settings();
    window.__lmSettingsTest?.();document.getElementById('lm-settings-test')?.remove();
    const a=window.LolkaMod.modules.get('HostSettings');a.open();
    const div=document.createElement('div');div.id='lm-settings-test';document.body.append(div);window.__lmSettingsTest=a.test.mount(div);return true;
  })()`);assert.equal(setup,true);await pause(250);
  const native=await c.evaluate(`({tabs:[...document.querySelectorAll('button')].filter(b=>b.textContent==='LolkaMod').length,embedded:document.querySelectorAll('#lolkamod-embedded-settings').length,settings:document.querySelectorAll('[data-lolkamod-host-settings]').length,miniToggles:document.getElementById('lolkamod-embedded-settings').shadowRoot.querySelectorAll('[data-setting=miniPlayerEnabled],[data-setting=miniPlayerDock]').length})`);
  assert.deepEqual(native,{tabs:1,embedded:1,settings:1,miniToggles:0});
  await c.evaluate(`(()=>{const theme=document.getElementById('lolkamod-embedded-settings').shadowRoot.querySelector('select[data-setting=themeId]');theme.value='graphite';theme.dispatchEvent(new Event('change'));})()`);
  for(let i=0;i<30;i++){if(await c.evaluate('window.LolkaMod.settings().themeId === "graphite"'))break;await pause(100);}
  const themes=[];
  for(const id of ['graphite','amoled','contrast','native']){
    themes.push(await c.evaluate(`(async()=>{await window.LolkaMod.saveSettings({themeId:${JSON.stringify(id)}});return {id:window.LolkaMod.settings().themeId,attribute:document.documentElement.getAttribute('data-lolkamod-theme'),styles:document.querySelectorAll('#lolkamod-built-in-theme').length,color:getComputedStyle(document.documentElement).getPropertyValue('--color-bg-primary').trim()}})()`));
  }
  assert.equal(themes[0].color,'#17191d');assert.equal(themes[1].color,'#000000');assert.equal(themes[2].color,'#07090d');assert.equal(themes[3].styles,0);assert.equal(themes[3].attribute,null);
  const noStream=await c.evaluate(`(async()=>{await window.LolkaMod.saveSettings({indicatorEnabled:true,indicatorDetailed:true});await window.LolkaMod.streams.sample();return {indicator:window.LolkaMod.streams.snapshot().indicator,dom:!!document.getElementById('lolkamod-stream-indicator')};})()`);
  assert.equal(noStream.dom,false);assert.equal(noStream.indicator.status,'idle');
  const controls=await c.evaluate(`(async()=>{
    const api=window.LolkaMod, original=api.modules.get('StreamControls'),calls=[];
    const nativeKeys=['screenShareResolution','screenShareFps','screenShareCodecV3'],savedKeys=nativeKeys.map(k=>[k,localStorage.getItem(k)]);
    let profile={resolution:'720p',fps:30,codec:'vp9'};
    api.modules.register('StreamControls',{active:()=>({...profile}),setQuality:async p=>{calls.push(['quality',{...p}]);profile={...p};return {success:true}}},'synthetic-ui-test');
    const box=document.createElement('div');document.body.append(box);
    const dispose=api.mountStreamMenu(box,{active:true,own:true,onStop:()=>calls.push(['stop']),onSource:async()=>calls.push(['source'])});
    let result;
    try{
      const trigger=box.querySelector('span').shadowRoot;trigger.querySelector('.arrow').click();
      const root=[...document.querySelectorAll('.lolkamod-stream-menu-portal')].at(-1).shadowRoot;
      const hasApplyButton=[...root.querySelectorAll('button')].some(b=>b.textContent==='Применить качество');
      const hasMiniButton=[...root.querySelectorAll('button')].some(b=>/Мини-плеер|мини-плеер/.test(b.textContent));
      const selects=root.querySelectorAll('select');
      selects[0].value='1440p';selects[0].dispatchEvent(new Event('change'));await new Promise(r=>setTimeout(r,100));
      selects[1].value='60';selects[1].dispatchEvent(new Event('change'));await new Promise(r=>setTimeout(r,100));
      [...root.querySelectorAll('button')].find(b=>b.textContent==='Изменить источник').click();await new Promise(r=>setTimeout(r,100));
      trigger.querySelector('.arrow').click();[...root.querySelectorAll('button')].find(b=>b.textContent==='Прекратить стрим').click();await new Promise(r=>setTimeout(r,100));
      const keys=nativeKeys.map(k=>localStorage.getItem(k));
      result={calls,keys,profile:{...profile},hasApplyButton,hasMiniButton,extraPeers:api.streams.snapshot().diagnostics.state.connections};
    }finally{
      dispose();box.remove();api.modules.register('StreamControls',original,'restored-live-host');
      for(const [key,value] of savedKeys){if(value===null)localStorage.removeItem(key);else localStorage.setItem(key,value);}
    }
    return {...result,nativeKeysRestored:savedKeys.every(([key,value])=>localStorage.getItem(key)===value),remainingMini:document.querySelectorAll('#lolkamod-floating-mini-player,[data-lolkamod-owned=mini-menu]').length};
  })()`);
  assert.deepEqual(controls.calls,[['quality',{resolution:'1440p',fps:30,codec:'vp9'}],['quality',{resolution:'1440p',fps:60,codec:'vp9'}],['source'],['stop']]);
  assert.equal(controls.hasApplyButton,false);assert.equal(controls.hasMiniButton,false);assert.equal(controls.extraPeers,0);assert.deepEqual(controls.keys,['1440p','60','vp9']);assert.deepEqual(controls.profile,{resolution:'1440p',fps:60,codec:'vp9'});
  assert.equal(controls.nativeKeysRestored,true);assert.equal(controls.remainingMini,0);
  const lifecycle=await c.evaluate(`(()=>{const api=window.LolkaMod;for(let i=0;i<100;i++){api.stop();api.start();}return {panel:document.querySelectorAll('#lolkamod-panel').length,embedded:document.querySelectorAll('#lolkamod-embedded-settings').length,failed:api.diagnostics().plugins.failed,indicator:document.querySelectorAll('[data-lolkamod-owned=stream-indicator]').length,portals:document.querySelectorAll('.lolkamod-stream-menu-portal').length,miniDom:document.querySelectorAll('#lolkamod-floating-mini-player,[data-lolkamod-owned=mini-menu]').length,miniApi:typeof api.openMini}})()`);
  assert.deepEqual(lifecycle,{panel:1,embedded:1,failed:[],indicator:0,portals:0,miniDom:0,miniApi:'undefined'});
  const update=await c.evaluate('window.LolkaMod.checkUpdates()');assert.ok(['current','ahead','available','error','rate-limited'].includes(update.state));
  await c.evaluate(`(async()=>{await window.LolkaMod.saveSettings({themeId:'graphite',indicatorEnabled:true});window.__lmSettingsTest();document.getElementById('lm-settings-test')?.remove();delete window.__lmSettingsTest;})()`);
  const evidence={status:'PASS',version:initial.version,coldRestart:restart,initial,native,themes,noStream,controls,lifecycle,update,limit:'Isolated no-auth profile. Immediate quality/source/stop use explicit mock controls; removed mini-player API, DOM, settings and menu actions are checked absent. Native quality keys are restored after the test. Real SFU media, audio, auth navigation and connected user workflow remain NOT RUN.',testedAt:new Date().toISOString()};
  await fs.writeFile(`.runtime/evidence/features${restart?'-restart':''}-${initial.version}.json`,JSON.stringify(evidence,null,2));
  console.log(JSON.stringify({status:'PASS',native,themes:themes.map(t=>t.id),lifecycle,update:update.state}));
}finally{c.close();}
