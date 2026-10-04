import type { FeatureSettingsOptions } from "./feature-settings";

export interface HostStreamControls {
  active(): {resolution:string;fps:number;codec:string}|null;
  setQuality(profile:{resolution:string;fps:number;codec:string}):Promise<{success:boolean;error?:string}>;
  videos(): {id:string;video:HTMLVideoElement;title:string}[];
  pip(id:string):Promise<void>;
  closePip(id:string):void;
  pipAvailable():boolean;
  nativePip():boolean;
}
export interface StreamMenuProps { active:boolean; onStop():void|Promise<void>; onSource():Promise<void> }
export interface StreamMenuOptions {
  features:FeatureSettingsOptions;
  adapter():HostStreamControls|undefined;
  openMini(id:string):Promise<void>;
}

export function mountStreamMenu(container:HTMLElement, props:StreamMenuProps, options:StreamMenuOptions) {
  const doc=container.ownerDocument, events=new AbortController(), signal=events.signal;
  const host=doc.createElement("span");host.className="lolkamod-stream-menu";
  const shadow=host.attachShadow({mode:"open"});
  const style=doc.createElement("style");style.textContent=`:host{display:inline-flex;font:14px 'Segoe UI',sans-serif;color:#f4f1ff}:host([hidden]){display:none}button,select{font:inherit;color:inherit;background:#25212e;border:1px solid #5a5269;border-radius:8px;padding:8px;cursor:pointer}button:focus-visible,select:focus-visible{outline:2px solid #a78bfa}button:disabled{opacity:.5;cursor:default}.arrow{height:40px;min-width:28px}.menu{position:fixed;z-index:2147482990;width:280px;max-height:calc(100vh - 30px);overflow:auto;display:grid;gap:8px;padding:14px;border:1px solid #51465f;border-radius:12px;background:#17121f;box-shadow:0 8px 32px #0009}.menu[hidden]{display:none}label{display:grid;gap:4px}.row{display:flex;gap:8px}.row select{min-width:0;flex:1}.stop{color:#ff8da9}p{font-size:12px;color:#bdb6cd;margin:0}`;
  const arrow=doc.createElement("button");arrow.type="button";arrow.className="arrow";arrow.textContent="⌃";arrow.setAttribute("aria-label","Меню стрима LolkaMod");arrow.setAttribute("aria-expanded","false");
  const menu=doc.createElement("div");menu.className="menu";menu.hidden=true;menu.setAttribute("aria-label","Управление стримом");
  const status=doc.createElement("p");status.setAttribute("role","status");
  let disposed=false,busy=false;
  function button(label:string, fn:()=>void, cls="") {const b=doc.createElement("button");b.type="button";b.textContent=label;b.className=cls;b.addEventListener("click",fn,{signal});menu.append(b);return b;}
  function close(){menu.hidden=true;arrow.setAttribute("aria-expanded","false");}
  function position(){const rect=arrow.getBoundingClientRect();menu.style.left=Math.max(8,Math.min(rect.right-280,doc.documentElement.clientWidth-288))+"px";menu.style.top=Math.max(8,rect.top-menu.offsetHeight-8)+"px";}
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
  const apply=button("Применить качество",()=>void optionsAction(async()=>{
    const result=await options.adapter()?.setQuality({resolution:resolution.value,fps:Number(fps.value),codec:codec.value.toLowerCase()});
    if(!result?.success)throw new Error("Не удалось изменить качество активного стрима.");
    localStorage.setItem("screenShareResolution",resolution.value);localStorage.setItem("screenShareFps",fps.value);localStorage.setItem("screenShareCodecV3",codec.value.toLowerCase());
  },"Качество применено и сохранено."));
  const videos=select([],"Видео для мини-плеера");menu.append(videos);
  const mini=button("Мини-плеер",()=>{
    // Keep the native PiP request in the original click call stack.
    const operation=options.openMini(videos.value);close();void operation.catch(()=>{if(!disposed){status.textContent="Мини-плеер недоступен для выбранного видео.";menu.hidden=false;position();}});
  });
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
    source.disabled=stop.disabled=apply.disabled=!props.active||busy||!adapter;
    resolution.disabled=fps.disabled=codec.disabled=!props.active||busy;
    mini.disabled=!settings.miniPlayerEnabled||!adapter?.pipAvailable()||!videos.value;
    indicator.textContent=settings.indicatorEnabled?"Скрыть индикатор":"Показать индикатор";
  }
  arrow.addEventListener("click",()=>{
    if(!menu.hidden){close();return;}
    const adapter=options.adapter(),current=adapter?.active();
    resolution.value=current?.resolution??localStorage.getItem("screenShareResolution")??"720p";
    fps.value=String(current?.fps??localStorage.getItem("screenShareFps")??30);
    const supported=new Set((RTCRtpSender.getCapabilities("video")?.codecs??[]).map(c=>c.mimeType.split("/")[1].toUpperCase()));
    for(const option of codec.options)option.disabled=!supported.has(option.value);
    codec.value=String(current?.codec??localStorage.getItem("screenShareCodecV3")??"VP9").toUpperCase();
    if(!supported.has(codec.value))codec.value=[...codec.options].find(o=>!o.disabled)?.value??"";
    videos.replaceChildren();for(const item of adapter?.videos()??[]){const o=doc.createElement("option");o.value=item.id;o.textContent=item.title;videos.append(o);}
    refresh();menu.hidden=false;arrow.setAttribute("aria-expanded","true");position();
  },{signal});
  doc.addEventListener("pointerdown",event=>{if(!event.composedPath().includes(host))close();},{signal});
  doc.addEventListener("keydown",event=>{if(event.key==="Escape"&&!menu.hidden){close();arrow.focus();}},{signal});
  doc.defaultView?.addEventListener("resize",close,{signal});
  shadow.append(style,arrow,menu);container.append(host);refresh();
  const unsubscribe=options.features.subscribe(refresh);
  return ()=>{disposed=true;events.abort();unsubscribe();host.remove();};
}
