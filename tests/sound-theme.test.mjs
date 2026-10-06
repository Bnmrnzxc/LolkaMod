import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {build} from 'esbuild';
const compiled=await build({entryPoints:['src/renderer/sound-theme.ts'],bundle:true,write:false,format:'esm',platform:'browser'});
const {createSoundThemeController}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const ids=['voiceJoin','voiceLeave','userLeave','mute','unmute','soundDisable','soundEnable','cameraDisable','cameraEnable','radioActivation','radioDeactivation','messageSound','outgoingCall','incomingCall','screenShareStarted','screenShareStopped'];
const bytes=Buffer.from('ID3 test sound bytes');
const assets=[{key:'sample',bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),mimeType:'audio/mpeg'}];
const mapping=Object.fromEntries(ids.map(id=>[id,'sample']));
const pack=()=>({id:'discord',assets:[{key:'sample',mimeType:'audio/mpeg',base64:bytes.toString('base64')}]});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function until(predicate){for(let count=0;count<100;count++){if(predicate())return;await new Promise(done=>setTimeout(done,5));}assert.fail('Sound controller did not settle');}
function fixture(load=async()=>pack(),options={}){
  let present=true,loads=0,clears=0,resources,previews=[];
  const adapter={snapshot:()=>({actions:ids.map(id=>({id,enabled:true,defaultUrl:'/stock/'+id})),allSoundsMuted:false,overlayActive:!!resources}),
    overlay:async value=>{resources=value;},clear:()=>{clears++;resources=undefined;},preview:(...args)=>previews.push(args)};
  const controller=createSoundThemeController({adapter:()=>present?adapter:undefined,load:()=>{loads++;return load();},assets,mapping,change:()=>{},...options});
  return {controller,adapter,setPresent:value=>{present=value;},get loads(){return loads;},get clears(){return clears;},get resources(){return resources;},previews};
}
test('disabled preference does not load audio; enabling maps all actions and clearing restores host',async()=>{
  const f=fixture();f.controller.apply(false);assert.equal(f.loads,0);
  f.controller.apply(true);await until(()=>f.controller.status().state==='active');
  assert.equal(f.loads,1);assert.equal(f.controller.status().mapped,16);assert.deepEqual(Object.keys(f.resources),ids);
  f.controller.preview('messageSound',0);assert.deepEqual(f.previews,[['messageSound',0]]);
  f.controller.refresh();assert.equal(f.loads,1);
  f.controller.apply(false);assert.equal(f.controller.status().state,'off');assert.equal(f.resources,undefined);
  assert.throws(()=>f.controller.preview('messageSound'),/not active/);f.controller.stop();
});
test('late module registration activates a saved preference without restarting the mod',async()=>{
  const f=fixture();f.setPresent(false);f.controller.apply(true);assert.equal(f.controller.status().state,'waiting');assert.equal(f.loads,0);
  f.setPresent(true);f.controller.refresh();await until(()=>f.controller.status().state==='active');assert.equal(f.loads,1);f.controller.stop();
});
test('turning off during a download cannot activate the stale sound preference',async()=>{
  const pending=deferred(),f=fixture(()=>pending.promise);f.controller.apply(true);f.controller.apply(false);pending.resolve(pack());
  await new Promise(done=>setTimeout(done,20));assert.equal(f.controller.status().state,'off');assert.equal(f.resources,undefined);f.controller.stop();
});
test('checksum failure keeps original sounds and retries only after another explicit enable',async()=>{
  let bad=true;const f=fixture(async()=>{const p=pack();if(bad)p.assets[0].base64=Buffer.from('other bytes of size').toString('base64');return p;});
  f.controller.apply(true);await until(()=>f.controller.status().state==='error');assert.equal(f.resources,undefined);
  assert.equal(f.controller.status().errorStage,'verify');
  f.controller.refresh();assert.equal(f.loads,1);bad=false;f.controller.apply(false);f.controller.apply(true);
  await until(()=>f.controller.status().state==='active');assert.equal(f.loads,2);f.controller.stop();
});

test('load errors expose fixed status codes without raw proxy or IPC error messages',async()=>{
  let fail=true;
  const f=fixture(async()=>{if(fail)throw new Error('private proxy configuration and credentials');return pack();},
    {downloadStatus:()=>({state:'error',stage:'download',code:'network',asset:'sample'})});
  f.controller.apply(true);await until(()=>f.controller.status().state==='error');
  assert.equal(f.controller.status().errorStage,'load');assert.equal(f.controller.status().errorCode,'network');
  assert.match(f.controller.status().message,/встроенный набор/);assert.doesNotMatch(JSON.stringify(f.controller.status()),/private proxy|credentials|VPN/);
  fail=false;f.controller.apply(false);f.controller.apply(true);await until(()=>f.controller.status().state==='active');
  assert.equal(f.controller.status().errorCode,undefined);f.controller.stop();
});

test('failed diagnostics and native decode have different safe failure stages',async()=>{
  const f=fixture(async()=>{throw new Error('remote denied');},{downloadStatus:()=>{throw new Error('IPC denied');}});
  f.controller.apply(true);await until(()=>f.controller.status().state==='error');assert.equal(f.controller.status().errorCode,'unknown');
  assert.match(f.controller.status().message,/встроенный набор/);f.controller.stop();
  const g=fixture();g.adapter.overlay=async()=>{throw new Error('local audio device details');};
  g.controller.apply(true);await until(()=>g.controller.status().state==='error');assert.equal(g.controller.status().errorStage,'overlay');
  assert.match(g.controller.status().message,/воспроизвести/);assert.doesNotMatch(g.controller.status().message,/device details/);g.controller.stop();
});
test('pending overlay cleanup revokes its blobs after cancellation and does not resurrect stopped hooks',async()=>{
  const pending=deferred(),f=fixture();let resources;
  f.adapter.overlay=async value=>{resources=value;await pending.promise;};
  f.controller.apply(true);await until(()=>!!resources);const url=resources.messageSound;
  assert.equal((await fetch(url)).status,200);f.controller.stop();pending.resolve();await new Promise(done=>setTimeout(done,20));
  await assert.rejects(fetch(url));assert.throws(()=>f.controller.preview('messageSound'),/not active/);
});
test('host adapter replacement clears previous hooks and uses a fresh overlay',async()=>{
  const a=fixture();a.controller.apply(true);await until(()=>a.controller.status().state==='active');
  a.setPresent(false);a.controller.refresh();assert.equal(a.controller.status().state,'waiting');assert.equal(a.resources,undefined);
  a.setPresent(true);a.controller.refresh();await until(()=>a.controller.status().state==='active');assert.equal(a.loads,2);a.controller.stop();
});
