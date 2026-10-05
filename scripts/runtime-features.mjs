import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { CDP } from './cdp.mjs';
const compiledCatalog=await build({entryPoints:[fileURLToPath(new URL('../src/shared/themes.ts',import.meta.url))],bundle:true,format:'esm',platform:'node',target:'node22',write:false,logLevel:'silent'});
const {BUILT_IN_THEMES}=await import(`data:text/javascript;base64,${Buffer.from(compiledCatalog.outputFiles[0].text).toString('base64')}`);
const c=await CDP.connect();
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const restart=process.argv.includes('--restart');
async function chooseTheme(id){
  return c.evaluate(`(async()=>{
    const root=document.getElementById('lolkamod-embedded-settings').shadowRoot;
    const button=root.querySelector('button[data-theme-id='+${JSON.stringify(id)}+']');
    if(!button)throw new Error('Missing theme swatch');
    button.click();
    const group=root.querySelector('[role=radiogroup]');
    for(let i=0;i<80;i++){
      if(window.LolkaMod.settings().themeId===${JSON.stringify(id)}&&group.getAttribute('aria-busy')==='false')break;
      await new Promise(r=>setTimeout(r,25));
    }
    const computed=getComputedStyle(document.documentElement);
    return {id:window.LolkaMod.settings().themeId,attribute:document.documentElement.getAttribute('data-lolkamod-theme'),
      styles:document.querySelectorAll('#lolkamod-built-in-theme').length,color:computed.getPropertyValue('--color-bg-primary').trim(),
      colorScheme:computed.colorScheme,selected:[...root.querySelectorAll('button[role=radio][aria-checked=true],button[data-theme-id=native][aria-pressed=true]')].map(b=>b.dataset.themeId),
      busy:group.getAttribute('aria-busy'),swatches:root.querySelectorAll('button[role=radio][data-setting=themeId]').length};
  })()`);
}
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
    window.__lmSettingsTest=()=>document.querySelector('button[class*="SettingsLayout-module__headerClose"]')?.click();return true;
  })()`);assert.equal(setup,true);await pause(500);
  await c.evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='LolkaMod').click()`);await pause(100);
  const native=await c.evaluate(`({tabs:[...document.querySelectorAll('button')].filter(b=>b.textContent==='LolkaMod').length,embedded:document.querySelectorAll('#lolkamod-embedded-settings').length,settings:document.querySelectorAll('[data-lolkamod-host-settings]').length,miniToggles:document.getElementById('lolkamod-embedded-settings').shadowRoot.querySelectorAll('[data-setting=miniPlayerEnabled],[data-setting=miniPlayerDock]').length,themeSwatches:document.getElementById('lolkamod-embedded-settings').shadowRoot.querySelectorAll('button[role=radio][data-setting=themeId]').length,themeSelects:document.getElementById('lolkamod-embedded-settings').shadowRoot.querySelectorAll('select[data-setting=themeId]').length})`);
  assert.equal(BUILT_IN_THEMES.length,25);
  assert.deepEqual(native,{tabs:1,embedded:1,settings:1,miniToggles:0,themeSwatches:BUILT_IN_THEMES.length,themeSelects:0});
  const nativeBefore=await chooseTheme('native');
  assert.deepEqual(nativeBefore.selected,['native']);assert.equal(nativeBefore.attribute,null);assert.equal(nativeBefore.styles,0);
  const nativeStateBefore=await c.evaluate(`({className:document.documentElement.className,keys:['screenShareResolution','screenShareFps','screenShareCodecV3'].map(k=>[k,localStorage.getItem(k)]),customCss:document.getElementById('lolkamod-custom-css')?.textContent??null})`);
  const themes=[];
  for(const theme of BUILT_IN_THEMES){
    const measured=await chooseTheme(theme.id);themes.push(measured);
    assert.equal(measured.id,theme.id);assert.deepEqual(measured.selected,[theme.id]);assert.equal(measured.busy,'false');
    assert.equal(measured.swatches,BUILT_IN_THEMES.length);
    assert.equal(measured.styles,theme.id==='native'?0:1);assert.equal(measured.attribute,theme.id==='native'?null:theme.id);
    if(theme.palette){assert.equal(measured.color,theme.palette.primary);assert.equal(measured.colorScheme,theme.palette.mode);}
    else{assert.equal(measured.color,nativeBefore.color);assert.equal(measured.colorScheme,nativeBefore.colorScheme);}
  }
  const nativeAfter=await chooseTheme('native');
  assert.deepEqual(nativeAfter,nativeBefore,'Returning to native removes only owned theme styles and restores host appearance');
  const nativeStateAfter=await c.evaluate(`({className:document.documentElement.className,keys:['screenShareResolution','screenShareFps','screenShareCodecV3'].map(k=>[k,localStorage.getItem(k)]),customCss:document.getElementById('lolkamod-custom-css')?.textContent??null})`);
  assert.deepEqual(nativeStateAfter,nativeStateBefore,'Theme choices preserve native host classes, quality keys and custom CSS');
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
  const nativeStateAfterCleanup=await c.evaluate(`({className:document.documentElement.className,keys:['screenShareResolution','screenShareFps','screenShareCodecV3'].map(k=>[k,localStorage.getItem(k)]),customCss:document.getElementById('lolkamod-custom-css')?.textContent??null})`);
  assert.deepEqual(nativeStateAfterCleanup,nativeStateBefore,'Cleanup preserves native state while retaining the explicit graphite restart fixture');
  const evidence={status:'PASS',version:initial.version,coldRestart:restart,initial,native,themes,nativeAppearance:{before:nativeBefore,after:nativeAfter},nativeState:{before:nativeStateBefore,after:nativeStateAfter,afterCleanup:nativeStateAfterCleanup},noStream,controls,lifecycle,update,limit:'Isolated no-auth profile. Every catalog theme is selected through its UI swatch; selected ARIA state, palette variables, color scheme and native cleanup are checked. Immediate quality/source/stop use explicit mock controls; removed mini-player API, DOM, settings and menu actions are checked absent. Native quality keys are restored after the test. Graphite and indicatorEnabled remain explicit restart fixtures. Real SFU media, audio, auth navigation and connected user workflow remain NOT RUN.',testedAt:new Date().toISOString()};
  await fs.writeFile(`.runtime/evidence/features${restart?'-restart':''}-${initial.version}.json`,JSON.stringify(evidence,null,2));
  console.log(JSON.stringify({status:'PASS',native,themes:themes.map(t=>t.id),lifecycle,update:update.state}));
}finally{c.close();}
