import { optionalContracts } from "./compatible-quality";

const settingsSpecs = [
  {find:'{title:"groups.app",items:["appearance","languageTime","notifications","audio","keybindings","overlay","activities","windows","advanced"]}',replace:'{title:"groups.app",items:["appearance","lolkamod","languageTime","notifications","audio","keybindings","overlay","activities","windows","advanced"]}'},
  {find:'const q=v.useMemo(()=>D$n(M),[M]),J=q.length>0'},
  {find:'items:Ie.items.filter(Ce=>!Y.has(Ce)).filter(Ce=>!J||Z.has(Ce)).map(Ce=>({id:Ce,title:o(Mu[Ce])}))',replace:'items:Ie.items.filter(Ce=>!Y.has(Ce)).filter(Ce=>!J||Z.has(Ce)||Ce==="lolkamod"&&"lolkamod".includes(M.toLowerCase().trim())).map(Ce=>({id:Ce,title:Ce==="lolkamod"?"LolkaMod":o(Mu[Ce])}))'},
  {find:'pe=Mu[a]?o(Mu[a]):""',replace:'pe=a==="lolkamod"?"LolkaMod":Mu[a]?o(Mu[a]):""'},
  {find:'a===Ao.Appearance&&s.jsx(QFn,{})',replace:'a==="lolkamod"&&s.jsx(__lmHostSettings,{}),a===Ao.Appearance&&s.jsx(QFn,{})'},
  {find:'cn=ss((e,t)=>({openModals:[],settingsActiveTab:Ao.Profiles,settingsAudioVideoTab:Ag.Audio'},
  {find:'setSettingsActiveTab:n=>e({settingsActiveTab:n})'},
  {find:'return n===_e.Settings&&(o.settingsActiveTab=Ao.Profiles,o.settingsAudioVideoTab=Ag.Audio'},
];

// Windows desktop source chooser is opened before the old stream is stopped. Cancel is harmless.
const changeSource = `[t,o,n,r,a,l,e]);return{isScreenSharing:t,handleScreenShare:c,isElectron:o(),changeSource:async u=>{
 if(!o())throw new Error("Источник меняется в desktop Lolka");
 const stop=async()=>{if(fB())await RG();else if(s2e()){const result=await PE(u);if(result?.success===false)throw new Error("Не удалось остановить текущий стрим")}};
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
  {find:toolbarFind,replace:toolbarFind+',_De()&&s.jsx(__lmHostToolbar,{active:z,onStop:Ar,onSource:()=>__lmChangeSource(he?Number(he):void 0)})'},
  {find:'const o=v.useCallback(()=>typeof window.electronAPI<"u",[]),a=v.useCallback(async(u,d,f,h,m,g)=>{if(r(_e.ElectronSourcePicker),$ae()){try{await pgt({sourceId:u,channelId:d,resolution:h,fps:m,codec:g,audio:f===!1});const _=Y2e();_&&Sxe(_,!0,bxe(u))}catch(_){n(_e.Alert,{message:_ instanceof Error?_.message:String(_)})}return}const y=await Iyt(u,d,f,h,m,g);y.success||console.error("[ScreenShare] JS screen share failed:",y.error)},[r,n])'},
  {find:'if(fB()){await RG();return}'},
  {find:'const{sources:d,capabilities:f}=await dgt();n(_e.ElectronSourcePicker,{sources:d,native:{codecs:f.codecs,audio:f.audio===!0},onSourceSelect:(h,m,g,y,_)=>{a(h,u,m,g,y,_)},onCancel:()=>r(_e.ElectronSourcePicker),serverLevel:_2()})'},
  {find:'const d=await Ryt();if(d.length===0)'},
  {find:'aie=async e=>Ht.getState().isScreenSharing?await PE(e):await kyt(e)'},
  {find:'hDe=()=>{const{t:e}=Xe("voice"),t=s2e(),{openModal:n,closeModal:r}=cn()'},
  {find:'Lyt=()=>fB()?Y2e():OZ()?LZ():null'},
  {find:'IE.requestPip({userId:wr,sourceType:"screenshare",displayName:yo,videoElement:nxe(wr)})'},
  {find:'PG=new Map,nxe=e=>PG.get(e),rxe=v.memo(({stream:e,name:t,userId:n,viewersCount:r,screenShareId:o'},
  {find:'if(f6()){j1.getState().open({userId:t,sourceType:n,displayName:r});return}'},
  {find:'exitPipForUser(t,n){f6()&&j1.getState().closeFor(t,n)'},
  {find:'u_=async e=>{if(fB())return mgt({resolution:e.resolution,fps:e.fps,codec:e.codec})'},
];

export const hostContractSpecs={settings:settingsSpecs,controls:controlsSpecs};
export function transformHostFeatures(source:string, hash:string, testKnown=false) {
  let body=source;
  const features:Record<string,string>={settings:"unsupported",controls:"unsupported"};
  const settings=optionalContracts(body,settingsSpecs,["v","s","Ao","cn","_e","M"]);
  if(settings){
    const test=optionalContracts(source,[
      {find:'P$n=({isOpen:e,onClose:t,className:n,...r})=>{const{t:o}=Xe("settings"),{settingsActiveTab:a,setSettingsActiveTab:l,settingsAudioVideoTab:c'},
      {find:'Eje.createRoot(document.getElementById("root")).render(s.jsx(Var,{children:s.jsx(vPe,{i18n:At'},
    ],["P$n","Eje","s","vPe","At"]);
    const testReference=test?test.rebind(`,...(globalThis.LolkaModNative?.diagnostics().testMode?{test:{mount:container=>{const root=Eje.createRoot(container);root.render(s.jsx(vPe,{i18n:At,children:s.jsx(P$n,{isOpen:true,onClose:()=>{}})}));return()=>root.unmount()}}}:{})`):"";
    body=settings.body+settings.rebind(`
function __lmHostSettings(){const ref=v.useRef(null);v.useEffect(()=>globalThis.LolkaMod?.mountSettings(ref.current),[]);return s.jsx("div",{ref,"data-lolkamod-host-settings":true})}
;globalThis.LolkaMod?.modules.register("HostSettings",Object.freeze({open:()=>{cn.getState().setSettingsActiveTab("lolkamod");cn.getState().openModal(_e.Settings)}${testReference}}),"${hash}");
`);
    features.settings="available";
  }
  const controls=optionalContracts(body,controlsSpecs,["v","s","he","fB","RG","PE","s2e","$ae","dgt","Ryt","_e","_2","Lyt","IE","nxe","PG","u_","f6"]);
  if(controls){
    body=controls.body+controls.rebind(`
function __lmHostToolbar(props){const ref=v.useRef(null),current=v.useRef(props);current.current=props;v.useEffect(()=>globalThis.LolkaMod?.mountStreamMenu(ref.current,{get active(){return current.current.active},onStop:()=>current.current.onStop(),onSource:()=>current.current.onSource()}),[]);return s.jsx("span",{ref,"data-lolkamod-host-toolbar":true})}
;globalThis.LolkaMod?.modules.register("StreamControls",Object.freeze({active:()=>Lyt(),setQuality:profile=>u_(profile),videos:()=>[...PG.entries()].filter(([,video])=>video?.tagName==="VIDEO"&&video.isConnected).map(([id,video],index)=>({id,video,title:"Стрим "+(index+1)})),nativePip:()=>f6(),pipAvailable:()=>f6()||document.pictureInPictureEnabled,pip:id=>IE.requestPip({userId:id,sourceType:"screenshare",displayName:"Стрим",videoElement:nxe(id)}),closePip:id=>IE.exitPipForUser(id,"screenshare")}),"${hash}");
`);
    features.controls="available";
  }
  return {body,features,changed:body!==source};
}
