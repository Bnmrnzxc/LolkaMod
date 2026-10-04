export interface SourcePatch { id: string; find: string; replace: string }

// Exact fragments for the supported entry only. Each must occur once, and the
// entire group commits together. No account, auth or server state is changed.
export const nativeQualityPatches: readonly SourcePatch[] = [
  { id: "picker-valid-resolutions", find: 'function $tr(e,t,n=0){return t?e?[my,xg,vR]:n>=2?[my,xg]:[my]:[my,xg]}',
    replace: 'function $tr(e,t,n=0){return[my,xg,vR]}' },
  { id: "picker-valid-fps", find: 'function Btr(e,t,n=0){return!t||e?[Q1.toString(),uM.toString()]:n>=1?[Q1.toString(),uM.toString()]:[Q1.toString()]}',
    replace: 'function Btr(e,t,n=0){return[Q1.toString(),uM.toString()]}' },
  { id: "picker-resolution-options", find: 'De=[{value:my,label:"720p"},...me?',
    replace: 'De=[{value:my,label:"720p"},...!0?' },
  { id: "picker-fallback-options", find: 'ze=[{value:my,label:"720p"},{value:xg,label:"1080p"}]',
    replace: 'ze=[{value:my,label:"720p"},{value:xg,label:"1080p"},{value:vR,label:"1440p"}]' },
  { id: "picker-fps-options", find: 'ye=[{value:Q1.toString(),label:"30 FPS"},...xe?',
    replace: 'ye=[{value:Q1.toString(),label:"30 FPS"},...!0?' },
  { id: "live-menu-options", find: 'Ns=(Dt.getState().user?.premium_level||0)>0,Qa=_2(),Zi=Ns||Qa>=2,wa=Ns||Qa>=1;',
    replace: 'Ns=!0,Qa=_2(),Zi=!0,wa=!0;' },
  { id: "browser-capture-fps", find: 'getDisplayMedia({audio:o,video:{frameRate:30}})',
    replace: 'getDisplayMedia({audio:o,video:{frameRate:__lmStockProfile().fps}})' },
  { id: "browser-producer-profile", find: 'const o=Dt.getState().user?.premium_level||0,a=o>0?byt:yxe,l=o>0?xg:my,{width:c,height:u}=mS[l];await wxe({response:e,videoTrack:r,audioTrack:t.getAudioTracks()[0]||null,ownedTracks:t.getTracks(),voiceChannelId:n,targetBitrate:_xe(a),resolution:l,maxWidth:c,maxHeight:u,fps:30,',
    replace: 'const o=__lmStockProfile(),l=o.resolution,a=mS[l].freeBitrate,{width:c,height:u}=mS[l];await wxe({response:e,videoTrack:r,audioTrack:t.getAudioTracks()[0]||null,ownedTracks:t.getTracks(),voiceChannelId:n,targetBitrate:_xe(a),resolution:l,maxWidth:c,maxHeight:u,fps:o.fps,codec:o.codec,' },
  { id: "screen-encoder-resolution", find: 'V2e=async e=>{const t=e.rtpSender;if(t)try{const n=t.getParameters();n.degradationPreference="balanced",',
    replace: 'V2e=async e=>{const t=e.rtpSender;if(t)try{const n=t.getParameters();n.degradationPreference="maintain-resolution",' },
];

export function applyPatchGroup(body: string, patches: readonly SourcePatch[]) {
  for (const patch of patches) {
    if (!patch.find || body.split(patch.find).length !== 2) {
      return { changed: false, body, failedPatch: patch.id, applied: [] as string[] };
    }
  }
  let next = body;
  for (const patch of patches) next = next.replace(patch.find, () => patch.replace);
  return { changed: true, body: next, applied: patches.map(p => p.id), failedPatch: undefined };
}

// Function declarations are hoisted in the original ESM lexical scope. Only the
// three ordinary stream preference keys are read; invalid values use stock defaults.
export const nativeProfileReference = `
function __lmStockProfile() {
  let resolution = "720p", fps = 30, codec = "vp9";
  try {
    const savedResolution = localStorage.getItem("screenShareResolution");
    const savedFps = localStorage.getItem("screenShareFps");
    const savedCodec = localStorage.getItem("screenShareCodecV3");
    if (["720p", "1080p", "1440p"].includes(savedResolution)) resolution = savedResolution;
    if (savedFps === "60") fps = 60;
    if (["vp8", "vp9", "h264", "av1"].includes(savedCodec)) codec = savedCodec;
  } catch {}
  return {resolution, fps, codec};
}
`;
