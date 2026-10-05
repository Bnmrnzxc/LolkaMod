import type { FeatureSettingsOptions } from "./feature-settings";

export interface HostStreamControls {
  active(): {resolution:string;fps:number;codec:string}|null;
  setQuality(profile:{resolution:string;fps:number;codec:string}):Promise<{success:boolean;error?:string}>;
}
export interface StreamMenuProps { active:boolean; own?:boolean; onStop():void|Promise<void>; onSource():Promise<void> }
export interface StreamMenuOptions {
  features:FeatureSettingsOptions;
  adapter():HostStreamControls|undefined;
}

export function mountStreamMenu(container:HTMLElement, props:StreamMenuProps, options:StreamMenuOptions) {
  const doc=container.ownerDocument, events=new AbortController(), signal=events.signal;
  const host=doc.createElement("span");host.className="lolkamod-stream-menu";
  const shadow=host.attachShadow({mode:"open"});
  const style=doc.createElement("style");style.textContent=`:host{display:inline-flex;font:14px 'Segoe UI',sans-serif;color:var(--color-text-primary,#f4f1ff);color-scheme:var(--lolkamod-color-scheme,dark)}:host([hidden]){display:none}button,select{font:inherit;color:inherit;background:var(--color-bg-input,#25212e);border:1px solid var(--color-border-button,#5a5269);border-radius:8px;padding:8px;cursor:pointer}button:focus-visible,select:focus-visible{outline:2px solid var(--color-brand-primary,#a78bfa)}button:disabled{opacity:.5;cursor:default}.arrow{height:40px;min-width:28px}.menu{box-sizing:border-box;position:fixed;z-index:2147482990;width:min(280px,calc(100vw - 16px));max-height:calc(100vh - 30px);overflow:auto;display:grid;gap:8px;padding:14px;border:1px solid var(--color-border-primary,#51465f);border-radius:12px;background:var(--color-bg-elevated,#17121f);box-shadow:0 8px 32px #0009}.menu[hidden]{display:none}label{display:grid;gap:4px}.row{display:flex;gap:8px}.row select{min-width:0;flex:1}[hidden]{display:none}.stop{color:var(--color-status-danger,#ff8da9)}p{font-size:12px;color:var(--color-text-secondary,#bdb6cd);margin:0}`;
  const arrow=doc.createElement("button");arrow.type="button";arrow.className="arrow";arrow.textContent="⌃";arrow.setAttribute("aria-label","Меню стрима LolkaMod");arrow.setAttribute("aria-expanded","false");
  const menu=doc.createElement("div");menu.className="menu";menu.hidden=true;menu.setAttribute("aria-label","Управление стримом");
  // A fixed descendant still belongs to transformed/overflowing native controls.
  // Keep the trigger in the toolbar and own the popup in a top-level portal.
  const portal=doc.createElement("span");portal.className="lolkamod-stream-menu-portal";
  const popup=portal.attachShadow({mode:"open"});
  popup.append(style.cloneNode(true),menu);doc.body.append(portal);
  const status=doc.createElement("p");status.setAttribute("role","status");
  let disposed=false,busy=false;
  function button(label:string, fn:()=>void, cls="") {const b=doc.createElement("button");b.type="button";b.textContent=label;b.className=cls;b.addEventListener("click",fn,{signal});menu.append(b);return b;}
  function close(){menu.hidden=true;arrow.setAttribute("aria-expanded","false");}
  let menuAnchor:HTMLElement=arrow;
  function position(){const rect=menuAnchor.getBoundingClientRect();menu.style.left=Math.max(8,Math.min(rect.right-menu.offsetWidth,doc.documentElement.clientWidth-menu.offsetWidth-8))+"px";menu.style.top=Math.max(8,rect.top-menu.offsetHeight-8)+"px";}
  const source=button("Изменить источник",()=>{
    close();void optionsAction(()=>props.onSource(),"Откроется штатный выбор. После выбора стрим кратко перезапустится.");
  });
  const hint=doc.createElement("p");hint.textContent="Смена источника перезапускает стрим после выбора. Отмена сохраняет текущий.";menu.append(hint);
  const row=doc.createElement("div");row.className="row";
  function select(values:string[],label:string){const e=doc.createElement("select");e.setAttribute("aria-label",label);for(const value of values){const o=doc.createElement("option");o.value=value;o.textContent=value;e.append(o);}return e;}
  const resolution=select(["720p","1080p","1440p"],"Разрешение стрима");
  const fps=select(["30","60"],"Частота кадров стрима");
  const codec=select(["VP8","VP9","H264","AV1"],"Кодек стрима");
  row.append(resolution,fps);menu.append(row,codec);
  const changeQuality=()=>void optionsAction(async()=>{
    const profile={resolution:resolution.value,fps:Number(fps.value),codec:codec.value.toLowerCase()};
    const result=await options.adapter()?.setQuality(profile);
    if(!result?.success)throw new Error("Не удалось изменить качество активного стрима.");
    localStorage.setItem("screenShareResolution",profile.resolution);localStorage.setItem("screenShareFps",String(profile.fps));localStorage.setItem("screenShareCodecV3",profile.codec);
  },"Качество изменено.");
  for(const control of [resolution,fps,codec])control.addEventListener("change",changeQuality,{signal});
  const indicator=button("Показать индикатор",()=>void optionsAction(()=>options.features.save({indicatorEnabled:!options.features.settings().indicatorEnabled}),"Настройка индикатора сохранена."));
  const stop=button("Прекратить стрим",()=>{close();void optionsAction(async()=>{await props.onStop();},"Стрим остановлен.");},"stop");
  menu.append(status);
  async function optionsAction(fn:()=>Promise<void>,success:string){
    if(busy)return;busy=true;refresh();
    try{await fn();if(!disposed)status.textContent=success;}
    catch{if(!disposed){status.textContent="Действие не удалось. Проверь активный стрим и попробуй снова.";menu.hidden=false;position();}}
    finally{busy=false;if(!disposed)refresh();}
  }
  function refresh(){
    const adapter=options.adapter(), settings=options.features.settings();
    host.hidden=!settings.streamMenuEnabled;
    if(host.hidden)close();
    source.disabled=stop.disabled=!props.active||busy||!adapter;
    const remote=props.own===false;source.hidden=stop.hidden=hint.hidden=row.hidden=codec.hidden=remote;
    resolution.disabled=fps.disabled=codec.disabled=!props.active||busy;
    indicator.textContent=settings.indicatorEnabled?"Скрыть индикатор":"Показать индикатор";
  }
  function open(anchor:HTMLElement=arrow){
    menuAnchor=anchor;
    const adapter=options.adapter(),current=adapter?.active();
    resolution.value=current?.resolution??localStorage.getItem("screenShareResolution")??"720p";
    fps.value=String(current?.fps??localStorage.getItem("screenShareFps")??30);
    // Native encoders can expose more codecs than Chromium. Missing browser
    // capabilities must never prevent opening a menu for the native engine.
    let supported:Set<string>|undefined;
    try{const capabilities=doc.defaultView?.RTCRtpSender?.getCapabilities?.("video");if(capabilities)supported=new Set(capabilities.codecs.map(c=>c.mimeType.split("/")[1].toUpperCase()));}catch{/* Native host without browser codec capabilities. */}
    for(const option of codec.options)option.disabled=!!supported&&!supported.has(option.value)&&option.value!==current?.codec.toUpperCase();
    codec.value=String(current?.codec??localStorage.getItem("screenShareCodecV3")??"VP9").toUpperCase();
    if([...codec.options].find(o=>o.value===codec.value)?.disabled)codec.value=[...codec.options].find(o=>!o.disabled)?.value??"";
    refresh();menu.hidden=false;arrow.setAttribute("aria-expanded","true");position();
  }
  function toggle(anchor:HTMLElement=arrow){if(!menu.hidden&&menuAnchor===anchor)close();else open(anchor);}
  arrow.addEventListener("click",event=>{event.stopPropagation();toggle();},{signal});
  doc.addEventListener("pointerdown",event=>{const path=event.composedPath();if(!path.includes(host)&&!path.includes(portal)&&!path.includes(menuAnchor))close();},{signal});
  doc.addEventListener("keydown",event=>{if(event.key==="Escape"&&!menu.hidden){close();arrow.focus();}},{signal});
  doc.defaultView?.addEventListener("resize",close,{signal});
  shadow.append(style,arrow);container.append(host);refresh();
  const unsubscribe=options.features.subscribe(refresh);
  return Object.assign(()=>{disposed=true;events.abort();unsubscribe();host.remove();portal.remove();},{open,toggle,close});
}
