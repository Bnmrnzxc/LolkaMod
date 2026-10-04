import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { CDP } from './cdp.mjs';

const cdp = await CDP.connect();
let evidence;
try {
  for(let i=0;i<80;i++) {
    if(await cdp.evaluate('window.LolkaMod?.ready === true')) break;
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  const setup = await cdp.evaluate(`(async () => {
    const api = window.LolkaMod;
    if (!api?.ready) throw new Error('Mod not ready');
    if (document.querySelector('#lm-synthetic-video')) throw new Error('Synthetic test already running');
    const saved = api.settings(); const stock=api.modules.get('ScreenShareSettings'); api.stop();
    if (!stock?.test || stock.test.profile().resolution !== '1440p' || stock.test.profile().fps !== 60) throw new Error('Native picker must select 1440p/60 first');
    const devices = navigator.mediaDevices;
    const descriptor = Object.getOwnPropertyDescriptor(devices, 'getDisplayMedia');
    const nativeCapture = devices.getDisplayMedia;
    const nativePeer = window.RTCPeerConnection;
    const canvas = document.createElement('canvas'); canvas.width = 2560; canvas.height = 1440;
    const context = canvas.getContext('2d'); let frame = 0;
    const draw = () => {
      context.fillStyle = '#173947'; context.fillRect(0,0,2560,1440);
      for(let i=0;i<24;i++) {
        context.fillStyle = 'hsl('+((frame*7+i*13)%360)+' 70% 55%)';
        context.fillRect((frame*15+i*101)%2560,(i*61)%1440,160,80);
      }
      context.fillStyle = '#fff'; context.font = '72px sans-serif'; context.fillText('LolkaMod 2560 × 1440 — '+frame++,80,180);
    };
    draw(); const timer = setInterval(draw, 16);
    const source = canvas.captureStream(60);
    Object.defineProperty(devices,'getDisplayMedia',{configurable:true,writable:true,value:async()=>source});
    api.start();
    const nativeConstraints=stock.test.constraints();
    const stream = await devices.getDisplayMedia({video:{frameRate:stock.test.profile().fps},audio:false});
    const track = stream.getVideoTracks()[0];
    await track.applyConstraints({width:nativeConstraints.width,height:nativeConstraints.height,frameRate:nativeConstraints.frameRate});
    const senderPeer = new RTCPeerConnection({iceServers:[]});
    const receiverPeer = new RTCPeerConnection({iceServers:[]});
    const video = document.createElement('video'); video.id = 'lm-synthetic-video'; video.muted=true; video.autoplay=true; video.playsInline=true;
    video.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none'; document.body.append(video);
    window.__lmSynthetic = {senderPeer,receiverPeer,track,video,timer,saved,devices,descriptor,nativeCapture,nativePeer};
    receiverPeer.ontrack = event => { video.srcObject = new MediaStream([event.track]); void video.play().catch(()=>{}); };
    const localSender = senderPeer.addTrack(track, stream);
    const waitIce = pc => new Promise(resolve => {
      if(pc.iceGatheringState==='complete') return resolve();
      const timer = setTimeout(()=>{pc.removeEventListener('icegatheringstatechange',changed);resolve();},3000);
      const changed = () => { if(pc.iceGatheringState==='complete') {clearTimeout(timer);pc.removeEventListener('icegatheringstatechange',changed);resolve();} };
      pc.addEventListener('icegatheringstatechange',changed);
    });
    await senderPeer.setLocalDescription(await senderPeer.createOffer()); await waitIce(senderPeer);
    await receiverPeer.setRemoteDescription(senderPeer.localDescription);
    await receiverPeer.setLocalDescription(await receiverPeer.createAnswer()); await waitIce(receiverPeer);
    await senderPeer.setRemoteDescription(receiverPeer.localDescription);
    const parameters = localSender.getParameters();
    parameters.encodings = parameters.encodings.map(encoding => ({...encoding,maxBitrate:nativeConstraints.bitrate,maxFramerate:stock.test.profile().fps}));
    await localSender.setParameters(parameters);
    // Invoke the actual patched screen-producer helper, not a fixed-profile wrapper.
    await stock.test.encoder({rtpSender:localSender});
    window.__lmSynthetic.localSender=localSender;
    const captured=track.getSettings();
    return {version:api.version,profile:stock.test.profile(),nativeConstraints,degradationPreference:localSender.getParameters().degradationPreference,
      capture:{width:captured.width,height:captured.height,frameRate:captured.frameRate},constraints:track.getConstraints(),
      encodings:localSender.getParameters().encodings.map(e=>({maxBitrate:e.maxBitrate,maxFramerate:e.maxFramerate,scaleResolutionDownBy:e.scaleResolutionDownBy})),
      nativeCapabilities:api.modules.get('ScreenShareSettings')?.capabilities()??null};
  })()`);
  assert.equal(setup.version,'0.3.0');
  assert.equal(setup.capture.width,2560); assert.equal(setup.capture.height,1440);
  assert.equal(setup.encodings[0].maxBitrate,16_000_000);
  assert.equal(setup.encodings[0].maxFramerate,60);
  assert.equal(setup.degradationPreference,'maintain-resolution');
  const observations=[];
  for(let i=0;i<24;i++) {
    await new Promise(resolve=>setTimeout(resolve,500));
    const snapshot = await cdp.evaluate(`(async()=>{await window.LolkaMod.streams.sample();return window.LolkaMod.streams.snapshot();})()`);
    observations.push(snapshot);
    const out=snapshot.diagnostics.streams.find(s=>s.direction==='outbound'&&s.media==='screen');
    const incoming=snapshot.diagnostics.streams.find(s=>s.direction==='inbound');
    if(out?.encoded?.width===2560&&out?.encoded?.height===1440&&incoming?.decoded?.width===2560&&incoming?.decoded?.height===1440&&out.bitrateKbps>0&&incoming.bitrateKbps>0) {
      evidence={status:'PASS',test:'native-selected-profile-synthetic-canvas-local-WebRTC',version:setup.version,setup,
        samples:observations.length,observedAt:new Date().toISOString(),outbound:out,inbound:incoming,
        limit:'This isolated stock-profile canvas/loopback test does not prove OS screen capture, audio, Lolka SFU delivery or stable real-world 60 FPS.'};
      break;
    }
  }
  if(!evidence) {
    const states=await cdp.evaluate(`({sender:window.__lmSynthetic?.senderPeer.connectionState,receiver:window.__lmSynthetic?.receiverPeer.connectionState})`);
    await fs.writeFile('.runtime/evidence/stream-failed-0.3.0.json',JSON.stringify({status:'FAIL',setup,states,last:observations.at(-1)},null,2));
  }
  assert.ok(evidence,'No matching encoded/decoded 2560×1440 frames observed within 12 seconds');
} finally {
  const cleanup = await cdp.evaluate(`(async()=>{
    const data=window.__lmSynthetic;if(!data)return{cleaned:false};
    window.LolkaMod.stop(); clearInterval(data.timer);
    const aliveBefore=data.track.readyState==='live'&&data.senderPeer.connectionState!=='closed';
    const hooksRestored=data.devices.getDisplayMedia!==data.nativeCapture&&window.RTCPeerConnection===data.nativePeer;
    data.senderPeer.close();data.receiverPeer.close();data.track.stop();data.video.remove();
    if(data.descriptor)Object.defineProperty(data.devices,'getDisplayMedia',data.descriptor);
    else delete data.devices.getDisplayMedia;
    window.LolkaMod.start();await window.LolkaMod.saveSettings(data.saved);delete window.__lmSynthetic;
    await window.LolkaMod.streams.sample();
    return {cleaned:true,hostResourcesLeftAliveByStop:aliveBefore,hooksRestored,noRemainingStreams:window.LolkaMod.streams.snapshot().diagnostics.state.noStream};
  })()`);
  if(evidence) {
    evidence.cleanup=cleanup;
    assert.equal(cleanup.hostResourcesLeftAliveByStop,true); assert.equal(cleanup.hooksRestored,true);assert.equal(cleanup.noRemainingStreams,true);
    await fs.writeFile('.runtime/evidence/stream-0.3.0.json',JSON.stringify(evidence,null,2));
    console.log(JSON.stringify(evidence));
  }
  cdp.close();
}
