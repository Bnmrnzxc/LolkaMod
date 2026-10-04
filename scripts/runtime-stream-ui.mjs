import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {CDP} from './cdp.mjs';

const c=await CDP.connect(),pause=ms=>new Promise(r=>setTimeout(r,ms));
let evidence;
try {
  for(let i=0;i<80;i++){if(await c.evaluate('!!window.LolkaMod?.ready'))break;await pause(200);}
  const setup=await c.evaluate(`(async()=>{
    const api=window.LolkaMod;if(!api?.ready)throw Error('Not ready');
    if(api.diagnostics().desktop.testMode!==true)throw Error('Only the isolated no-auth test profile is supported');
    const original=api.modules.get('StreamControls'),saved=api.settings(),calls=[];
    const savedNativeKeys=['screenShareResolution','screenShareFps','screenShareCodecV3'].map(k=>[k,localStorage.getItem(k)]);
    const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;
    canvas.getContext('2d').fillRect(0,0,320,180);const stream=canvas.captureStream(30);
    const video=document.createElement('video');video.muted=true;video.autoplay=true;video.srcObject=stream;
    video.style.cssText='position:fixed;width:1px;height:1px;opacity:0';document.body.append(video);await video.play();
    let profile={resolution:'1440p',fps:60,codec:'av1'};
    api.modules.register('StreamControls',{active:()=>({...profile}),setQuality:async p=>{calls.push(['quality',{...p}]);profile={...p};return {success:true}}},'synthetic-ui');
    await api.saveSettings({indicatorEnabled:true,streamMenuEnabled:true});
    const box=document.createElement('div');box.id='lm-stream-chrome-test';box.style.cssText='position:relative;z-index:2147481000';document.body.append(box);
    const chrome=api.modules.get('HostSettings').test.mountChrome(box,{active:true,userId:'ui-test',ownScreen:true,onStop:()=>calls.push('stop'),onSource:async()=>calls.push('source')});
    const selected=document.createElement('div');selected.id='lm-selected-tools-test';selected.style.cssText='position:fixed;z-index:2147481000;right:24px;top:24px;display:flex;align-items:center;gap:6px;background:#111;color:white';
    const ping=document.createElement('span');ping.textContent='Пинг';const live=document.createElement('span');live.textContent='В ЭФИРЕ';
    const slot=document.createElement('span');selected.append(ping,slot,live);document.body.append(selected);
    const tools=api.mountStreamTools(slot,{userId:'ui-test',ownScreen:true,get video(){return video}});
    const cap=Object.getOwnPropertyDescriptor(RTCRtpSender,'getCapabilities');
    Object.defineProperty(RTCRtpSender,'getCapabilities',{value:()=>{throw Error('Synthetic native capabilities unavailable')},configurable:true});
    window.__lmUi={original,saved,savedNativeKeys,calls,video,stream,box,selected,chrome,tools,cap,profile:()=>({...profile})};
    return {version:api.version,adapter:api.diagnostics().desktop.sourceAdapter,testOnlyProfile:api.diagnostics().desktop.testMode,
      miniRemoved:{api:typeof api.openMini==='undefined',diagnostics:!('mini' in api.diagnostics()),settings:['miniPlayerEnabled','miniPlayerDock'].filter(k=>k in api.settings()),capability:!('pip' in api.diagnostics().features)}};
  })()`);
  assert.equal(setup.testOnlyProfile,true);assert.deepEqual(setup.miniRemoved,{api:true,diagnostics:true,settings:[],capability:true});await pause(100);
  const trigger=await c.evaluate(`(()=>{const e=document.querySelector('[data-lolkamod-host-toolbar]').querySelector('.lolkamod-stream-menu').shadowRoot.querySelector('.arrow'),r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  const click=async p=>{await c.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p});};
  await click(trigger);
  const popup=await c.evaluate(`(()=>{const p=[...document.querySelectorAll('.lolkamod-stream-menu-portal')].at(-1),m=p.shadowRoot.querySelector('.menu'),r=m.getBoundingClientRect();return {visible:!m.hidden,topLevel:p.parentElement===document.body,width:r.width,height:r.height,x:r.x,y:r.y,viewport:{width:innerWidth,height:innerHeight},hit:document.elementFromPoint(r.x+20,r.y+20)===p}})()`);
  assert.equal(popup.visible,true);assert.equal(popup.topLevel,true);assert.equal(popup.hit,true);
  assert.ok(popup.x>=0&&popup.y>=0&&popup.x+popup.width<=popup.viewport.width&&popup.y+popup.height<=popup.viewport.height);
  await c.evaluate(`(()=>{const p=[...document.querySelectorAll('.lolkamod-stream-menu-portal')].at(-1);p.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,composed:true}));})()`);
  assert.equal(await c.evaluate(`![...document.querySelectorAll('.lolkamod-stream-menu-portal')].at(-1).shadowRoot.querySelector('.menu').hidden`),true);
  const quality=await c.evaluate(`(async()=>{
    const root=[...document.querySelectorAll('.lolkamod-stream-menu-portal')].at(-1).shadowRoot,controls=root.querySelectorAll('select');
    const hasApplyButton=[...root.querySelectorAll('button')].some(b=>b.textContent==='Применить качество');
    const hasMiniControls=[...root.querySelectorAll('button,select')].some(e=>/мини-плеер/i.test(e.textContent+' '+e.getAttribute('aria-label')));
    for(const [index,value] of [[0,'1080p'],[1,'30'],[0,'1440p'],[1,'60']]){
      controls[index].value=value;controls[index].dispatchEvent(new Event('change'));await new Promise(r=>setTimeout(r,50));
    }
    return {hasApplyButton,hasMiniControls,calls:window.__lmUi.calls,profile:window.__lmUi.profile(),keys:['screenShareResolution','screenShareFps','screenShareCodecV3'].map(k=>localStorage.getItem(k)),disabled:[...controls].slice(0,3).map(e=>e.disabled)};
  })()`);
  assert.equal(quality.hasApplyButton,false);assert.equal(quality.hasMiniControls,false);
  assert.deepEqual(quality.calls,[['quality',{resolution:'1080p',fps:60,codec:'av1'}],['quality',{resolution:'1080p',fps:30,codec:'av1'}],['quality',{resolution:'1440p',fps:30,codec:'av1'}],['quality',{resolution:'1440p',fps:60,codec:'av1'}]]);
  assert.deepEqual(quality.profile,{resolution:'1440p',fps:60,codec:'av1'});assert.deepEqual(quality.keys,['1440p','60','av1']);assert.deepEqual(quality.disabled,[false,false,false]);
  await c.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  assert.equal(await c.evaluate(`[...document.querySelectorAll('.lolkamod-stream-menu-portal')].at(-1).shadowRoot.querySelector('.menu').hidden`),true);
  const tooltip=await c.evaluate(`(()=>{
    const root=document.querySelector('#lm-selected-tools-test .lolkamod-stream-tools').shadowRoot;
    const icon=root.querySelector('[data-lolkamod-owned=stream-indicator]'),button=icon.shadowRoot.querySelector('button');
    const before=document.querySelectorAll('[data-lolkamod-owned=stream-tooltip]').length;
    button.dispatchEvent(new MouseEvent('mouseenter'));
    const p=document.querySelector('[data-lolkamod-owned=stream-tooltip]'),r=icon.getBoundingClientRect(),t=p.shadowRoot.querySelector('[role=tooltip]');
    return {before,width:r.width,height:r.height,text:t.textContent,topLevel:p.parentElement===document.body};
  })()`);
  assert.equal(tooltip.before,0);assert.equal(tooltip.width,18);assert.equal(tooltip.height,18);assert.equal(tooltip.topLevel,true);
  assert.match(tooltip.text,/Выбрано: 1440p · 60 FPS · AV1/);assert.match(tooltip.text,/фактические метрики недоступны/);
  const shot=await c.send('Page.captureScreenshot',{format:'png'});await fs.writeFile('.runtime/evidence/stream-ui-preview.png',Buffer.from(shot.data,'base64'));
  const removed=await c.evaluate(`(()=>{
    const root=document.querySelector('#lm-selected-tools-test .lolkamod-stream-tools').shadowRoot;
    const icon=root.querySelector('[data-lolkamod-owned=stream-indicator]');icon.shadowRoot.querySelector('button').dispatchEvent(new MouseEvent('mouseleave'));
    return {toolButtons:root.querySelectorAll('button').length,miniDom:document.querySelectorAll('#lolkamod-floating-mini-player,[data-lolkamod-owned=mini-menu]').length,
      tooltips:document.querySelectorAll('[data-lolkamod-owned=stream-tooltip]').length,miniApi:typeof window.LolkaMod.openMini};
  })()`);
  assert.deepEqual(removed,{toolButtons:0,miniDom:0,tooltips:0,miniApi:'undefined'});
  const disabled=await c.evaluate(`(async()=>{await window.LolkaMod.saveSettings({indicatorEnabled:false});const root=document.querySelector('#lm-selected-tools-test .lolkamod-stream-tools').shadowRoot;return {iconHidden:root.querySelector('[data-lolkamod-owned=stream-indicator]').hidden,toolButtons:root.querySelectorAll('button').length,miniDom:document.querySelectorAll('#lolkamod-floating-mini-player,[data-lolkamod-owned=mini-menu]').length}})()`);
  assert.deepEqual(disabled,{iconHidden:true,toolButtons:0,miniDom:0});
  const lifecycle=await c.evaluate(`(()=>{const api=window.LolkaMod;for(let i=0;i<20;i++){api.stop();api.start();}return {portals:document.querySelectorAll('.lolkamod-stream-menu-portal').length,tools:document.querySelectorAll('.lolkamod-stream-tools').length,tooltips:document.querySelectorAll('[data-lolkamod-owned=stream-tooltip]').length,miniDom:document.querySelectorAll('#lolkamod-floating-mini-player,[data-lolkamod-owned=mini-menu]').length,failed:api.diagnostics().plugins.failed}})()`);
  assert.deepEqual(lifecycle,{portals:1,tools:2,tooltips:0,miniDom:0,failed:[]});
  evidence={status:'PASS',setup,popup,quality,tooltip,removed,disabled,lifecycle,testedAt:new Date().toISOString(),limit:'Isolated no-auth profile. Trusted mouse input exercises real host React wrappers in a clipped/transformed ancestor. Immediate quality uses a mutable mock profile; selected-video tooltip uses a synthetic canvas MediaStream without RTP/SFU metrics. Removed mini-player API, settings, DOM and controls are checked absent. Native quality keys are restored in cleanup. Real SFU media, audio, auth navigation and connected user workflow remain NOT RUN.'};
}finally{
  const cleanup=await c.evaluate(`(async()=>{const x=window.__lmUi;if(!x)return false;
    try{x.chrome();x.tools();x.box.remove();x.selected.remove();x.stream.getTracks().forEach(t=>t.stop());x.video.remove();}
    finally{if(x.cap)Object.defineProperty(RTCRtpSender,'getCapabilities',x.cap);else delete RTCRtpSender.getCapabilities;
      for(const [key,value] of x.savedNativeKeys){if(value===null)localStorage.removeItem(key);else localStorage.setItem(key,value);}
      window.LolkaMod.modules.register('StreamControls',x.original,'restored-live-host');await window.LolkaMod.saveSettings(x.saved);}
    delete window.__lmUi;await new Promise(r=>setTimeout(r,100));
    return {portals:document.querySelectorAll('.lolkamod-stream-menu-portal').length,tools:document.querySelectorAll('.lolkamod-stream-tools').length,tooltips:document.querySelectorAll('[data-lolkamod-owned=stream-tooltip]').length,miniDom:document.querySelectorAll('#lolkamod-floating-mini-player,[data-lolkamod-owned=mini-menu]').length,nativeKeysRestored:x.savedNativeKeys.every(([key,value])=>localStorage.getItem(key)===value)};
  })()`);
  if(evidence){evidence.cleanup=cleanup;assert.deepEqual(cleanup,{portals:0,tools:0,tooltips:0,miniDom:0,nativeKeysRestored:true});await fs.writeFile(`.runtime/evidence/stream-ui-${evidence.setup.version}.json`,JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));}
  c.close();
}
