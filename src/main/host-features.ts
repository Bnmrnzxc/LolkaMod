import { optionalContracts } from "./compatible-quality";
import { BRAND_HEX_PATH, BRAND_CUTOUTS } from "../shared/brand";

const sidebarIconFind = 'const ue=I$n[Me.id];return s.jsxs(su.SidebarItem,{active:a===Me.id,onClick:Ee=>{if(a!==Me.id){if(C){Ee.preventDefault(),_();return}E(null),l(Me.id)}},children:[ue&&s.jsx(ue,{size:20}),Me.title]},Me.id)';
const settingsSpecs = [
  {find:'{title:"groups.app",items:["appearance","languageTime","notifications","audio","keybindings","overlay","activities","windows","advanced"]}',replace:'{title:"groups.app",items:["appearance","lolkamod","languageTime","notifications","audio","keybindings","overlay","activities","windows","advanced"]}'},
  {find:'const q=v.useMemo(()=>D$n(M),[M]),J=q.length>0'},
  {find:'items:Ie.items.filter(Ce=>!Y.has(Ce)).filter(Ce=>!J||Z.has(Ce)).map(Ce=>({id:Ce,title:o(Mu[Ce])}))',replace:'items:Ie.items.filter(Ce=>!Y.has(Ce)).filter(Ce=>!J||Z.has(Ce)||Ce==="lolkamod"&&"lolkamod".includes(M.toLowerCase().trim())).map(Ce=>({id:Ce,title:Ce==="lolkamod"?"LolkaMod":o(Mu[Ce])}))'},
  {find:'pe=Mu[a]?o(Mu[a]):""',replace:'pe=a==="lolkamod"?"LolkaMod":Mu[a]?o(Mu[a]):""'},
  {find:'a===Ao.Appearance&&s.jsx(QFn,{})',replace:'a==="lolkamod"&&s.jsx(__lmHostSettings,{}),a===Ao.Appearance&&s.jsx(QFn,{})'},
  {find:'cn=ss((e,t)=>({openModals:[],settingsActiveTab:Ao.Profiles,settingsAudioVideoTab:Ag.Audio'},
  {find:'setSettingsActiveTab:n=>e({settingsActiveTab:n})'},
  {find:'return n===_e.Settings&&(o.settingsActiveTab=Ao.Profiles,o.settingsAudioVideoTab=Ag.Audio'},
  {find:sidebarIconFind,replace:sidebarIconFind.replace('const ue=I$n[Me.id]', 'const ue=Me.id==="lolkamod"?__lmHostBrand:I$n[Me.id]')},
];

// Windows desktop source chooser is opened before the old stream is stopped. Cancel is harmless.
const changeSource = `[t,o,n,r,a,l,e]);return{isScreenSharing:t,handleScreenShare:c,isElectron:o(),changeSource:async u=>{
 if(!o())throw new Error("Источник меняется в desktop Lolka");
 const stop=async()=>{if(fB())await RG();else if(Ht.getState().isScreenSharing){const result=await PE(u);if(result?.success===false)throw new Error("Не удалось остановить текущий стрим")}};
 let selecting=false;
 const select=async(...args)=>{if(selecting)return;selecting=true;try{await stop();await a(args[0],u,...args.slice(1))}catch(error){n(_e.Alert,{message:error instanceof Error?error.message:String(error)})}finally{selecting=false}};
 if($ae()){
  const{sources:d,capabilities:f}=await dgt();
  n(_e.ElectronSourcePicker,{sources:d,native:{codecs:f.codecs,audio:f.audio===!0},onSourceSelect:select,onCancel:()=>r(_e.ElectronSourcePicker),serverLevel:_2()});
 }else{
  const d=await Ryt();
  n(_e.ElectronSourcePicker,{sources:d,onSourceSelect:select,onCancel:()=>r(_e.ElectronSourcePicker),serverLevel:_2()});
 }
}}`;
const toolbarFind='_De()&&s.jsx(nn,{offset:12,content:r(z?"controls.stopScreenShare":"controls.startScreenShare"),placement:"top",children:s.jsx("button",{className:fe(qr.button,qr.buttonAppearanceSuccess,z&&qr.buttonActive),onClick:Ar,"aria-label":r("controls.screenShareToggleAria"),children:z?s.jsx(uW,{size:20}):s.jsx(jg,{size:20})})})';
const controlsSpecs = [
  {find:'[t,o,n,r,a,l,e]);return{isScreenSharing:t,handleScreenShare:c,isElectron:o()}',replace:changeSource},
  {find:'{visualVideoEnabled:j,videoEnabled:R,handleVideoToggle:P}=fDe(),{isScreenSharing:z,handleScreenShare:L}=hDe()',replace:'{visualVideoEnabled:j,videoEnabled:R,handleVideoToggle:P}=fDe(),{isScreenSharing:z,handleScreenShare:L,changeSource:__lmChangeSource}=hDe()'},
  {find:'Ar=v.useCallback(()=>{L(he?Number(he):void 0)},[L,he])'},
  {find:toolbarFind,replace:toolbarFind+',_De()&&s.jsx(__lmHostToolbar,{active:z,onStop:Ar,onSource:()=>__lmChangeSource(Ht.getState().currentVoiceChannel?.channelId)})'},
  {find:'const o=v.useCallback(()=>typeof window.electronAPI<"u",[]),a=v.useCallback(async(u,d,f,h,m,g)=>{if(r(_e.ElectronSourcePicker),$ae()){try{await pgt({sourceId:u,channelId:d,resolution:h,fps:m,codec:g,audio:f===!1});const _=Y2e();_&&Sxe(_,!0,bxe(u))}catch(_){n(_e.Alert,{message:_ instanceof Error?_.message:String(_)})}return}const y=await Iyt(u,d,f,h,m,g);y.success||console.error("[ScreenShare] JS screen share failed:",y.error)},[r,n])'},
  {find:'if(fB()){await RG();return}'},
  {find:'const{sources:d,capabilities:f}=await dgt();n(_e.ElectronSourcePicker,{sources:d,native:{codecs:f.codecs,audio:f.audio===!0},onSourceSelect:(h,m,g,y,_)=>{a(h,u,m,g,y,_)},onCancel:()=>r(_e.ElectronSourcePicker),serverLevel:_2()})'},
  {find:'const d=await Ryt();if(d.length===0)'},
  {find:'aie=async e=>Ht.getState().isScreenSharing?await PE(e):await kyt(e)'},
  {find:'hDe=()=>{const{t:e}=Xe("voice"),t=s2e(),{openModal:n,closeModal:r}=cn()'},
  {find:'Lyt=()=>fB()?Y2e():OZ()?LZ():null'},
  {find:'u_=async e=>{if(fB())return mgt({resolution:e.resolution,fps:e.fps,codec:e.codec})'},
];

const liveFind="Rn&&kr?.type.includes(Ea.SCREEN_SHARE)&&s.jsxs(\"div\",{className:qr.liveStatus,children:[qn&&s.jsx(nn,{content:s.jsxs(\"div\",{children:[s.jsx(\"div\",{children:hs?.ping!==null&&hs?.ping!==void 0?r(\"screenShare.stats.ping\",{ping:hs.ping}):r(\"screenShare.stats.pingMeasuring\")}),s.jsx(\"div\",{children:r(\"screenShare.stats.server\",{server:ms})}),hs?.transportProtocol&&s.jsx(\"div\",{children:r(\"screenShare.stats.transport\",{protocol:jZ(hs.transportProtocol)})})]}),children:s.jsx(\"span\",{className:fe(qr.liveStatusIcon,{[qr.liveStatusIconAverage]:hs?.connectionQuality===\"average\",[qr.liveStatusIconBad]:hs?.connectionQuality===\"bad\"}),children:hs?.connectionQuality===\"bad\"?s.jsx(SY,{size:20}):hs?.connectionQuality===\"average\"?s.jsx(bY,{size:20}):s.jsx(wY,{size:20})})}),s.jsx(rh,{appearance:\"danger\",children:r(\"screenShare.live\")})]})";
const streamToolsSpecs=[
  {find:liveFind,replace:liveFind.replace('s.jsx(rh,{appearance:', 's.jsx(__lmHostStreamTools,{userId:kr.userId,ownScreen:kr.type===Ea.MY_SCREEN_SHARE}),s.jsx(rh,{appearance:')},
  {find:'isMyStream:Sr.type===Ea.MY_SCREEN_SHARE'},
  {find:'PG=new Map,nxe=e=>PG.get(e),rxe=v.memo(({stream:e,name:t,userId:n,viewersCount:r,screenShareId:o'},
];
export const hostContractSpecs={settings:settingsSpecs,controls:controlsSpecs,streamTools:streamToolsSpecs};
export function transformHostFeatures(source:string, hash:string, testKnown=false) {
  let body=source;
  const features:Record<string,string>={settings:"unsupported",controls:"unsupported",streamTools:"unsupported"};
  const settings=optionalContracts(body,settingsSpecs,["v","s","Ao","cn","_e","M"]);
  if(settings){
    const test=optionalContracts(source,[
      {find:'P$n=({isOpen:e,onClose:t,className:n,...r})=>{const{t:o}=Xe("settings"),{settingsActiveTab:a,setSettingsActiveTab:l,settingsAudioVideoTab:c'},
      {find:'Eje.createRoot(document.getElementById("root")).render(s.jsx(Var,{children:s.jsx(vPe,{i18n:At'},
    ],["P$n","Eje","s","vPe","At"]);
    const testReference=test?test.rebind(`,...(globalThis.LolkaModNative?.diagnostics().testMode?{test:{mount:container=>{const root=Eje.createRoot(container);root.render(s.jsx(vPe,{i18n:At,children:s.jsx(P$n,{isOpen:true,onClose:()=>{}})}));return()=>root.unmount()},mountChrome:(container,props)=>{const root=Eje.createRoot(container);root.render(s.jsxs("div",{style:{position:"fixed",bottom:20,left:60,width:100,height:50,overflow:"hidden",transform:"translateZ(0)"},children:[typeof __lmHostToolbar==="function"&&s.jsx(__lmHostToolbar,props),typeof __lmHostStreamTools==="function"&&s.jsx(__lmHostStreamTools,props)]}));return()=>root.unmount()}}}:{})`):"";
    body=settings.body+settings.rebind(`
function __lmHostSettings(){const ref=v.useRef(null);v.useEffect(()=>globalThis.LolkaMod?.mountSettings(ref.current),[]);return s.jsx("div",{ref,"data-lolkamod-host-settings":true})}
function __lmHostBrand(){const id="lolkamod-host-brand-"+v.useId();return s.jsxs("svg",{width:24,height:24,viewBox:"0 0 1024 1024",fill:"currentColor",style:{flexShrink:0},"aria-hidden":true,focusable:false,"data-lolkamod-brand":"sidebar",children:[s.jsx("defs",{children:s.jsxs("mask",{id,maskUnits:"userSpaceOnUse",x:0,y:0,width:1024,height:1024,children:[s.jsx("rect",{width:1024,height:1024,fill:"white"}),...${JSON.stringify(BRAND_CUTOUTS.sidebar.paths)}.map(d=>s.jsx("path",{d,fill:"none",stroke:"black",strokeWidth:${BRAND_CUTOUTS.sidebar.width},strokeLinecap:"round",strokeLinejoin:"round"},d))]})}),s.jsx("path",{d:${JSON.stringify(BRAND_HEX_PATH)},mask:"url(#"+id+")"})]})}
;globalThis.LolkaMod?.modules.register("HostSettings",Object.freeze({open:()=>{cn.getState().setSettingsActiveTab("lolkamod");cn.getState().openModal(_e.Settings)}${testReference}}),"${hash}");
`);
    features.settings="available";
  }
  const controls=optionalContracts(body,controlsSpecs,["v","s","he","fB","RG","PE","s2e","Ht","$ae","dgt","Ryt","_e","_2","Lyt","u_"]);
  if(controls){
    body=controls.body+controls.rebind(`
function __lmHostToolbar(props){const ref=v.useRef(null),current=v.useRef(props);current.current=props;v.useEffect(()=>globalThis.LolkaMod?.mountStreamMenu(ref.current,{get active(){return current.current.active},onStop:()=>current.current.onStop(),onSource:()=>current.current.onSource()}),[]);return s.jsx("span",{ref,"data-lolkamod-host-toolbar":true})}
;globalThis.LolkaMod?.modules.register("StreamControls",Object.freeze({active:()=>Lyt(),setQuality:profile=>u_(profile)}),"${hash}");
`);
    features.controls="available";
  }
  const streamTools=optionalContracts(body,streamToolsSpecs,["v","s","kr","Ea","nxe"]);
  if(streamTools){
    body=streamTools.body+streamTools.rebind(`
function __lmHostStreamTools(props){const ref=v.useRef(null),current=v.useRef(props);current.current=props;v.useEffect(()=>globalThis.LolkaMod?.mountStreamTools(ref.current,{get userId(){return current.current.userId},get ownScreen(){return current.current.ownScreen},get video(){return nxe(current.current.userId)}}),[props.userId,props.ownScreen]);return s.jsx("span",{ref,"data-lolkamod-host-stream-tools":true})}
`);
    features.streamTools="available";
  }
  return {body,features,changed:body!==source};
}
