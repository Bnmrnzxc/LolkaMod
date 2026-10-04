import { parse, tokenizer, tokTypes, type Token as AcornToken } from "acorn";
import { nativeQualityPatches, type SourcePatch } from "./native-quality-patches";

type Node = any;
type Token = AcornToken & { value?: unknown };
type Binding = Record<string, string>;
interface Match { start: number; end: number; binding: Binding }
type TokenIndex = Map<string, number[]>;
const options = { ecmaVersion: "latest", sourceType: "module" } as const;
const fixedNames = new Set(["async", "getDisplayMedia"]);
const sharedNames = ["my", "xg", "vR", "Q1", "uM", "Dt", "mS", "wxe", "_xe", "V2e", "_2", "$tr", "Btr"];
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;

function tokens(source: string): Token[] {
  return normalizeTokens([...tokenizer(source, options)]);
}
function normalizeTokens(list: Token[]): Token[] {
  const canonical:Token[]=[];
  for(let i=0;i<list.length;i++){
    if(list[i].type.label==="!/~"&&list[i].value==="!"&&list[i+1]?.type.label==="num"&&(list[i+1].value===0||list[i+1].value===1)){
      const value=list[i+1].value===0;
      canonical.push({...list[i],type:value?tokTypes._true:tokTypes._false,value:value?"true":"false",end:list[i+1].end});i++;
    }else canonical.push(list[i]);
  }
  list=canonical;
  const skip = new Set<number>();
  for (let i = 0; i + 3 < list.length; i++) if (list[i].type.label === "(" && list[i + 1].type.label === "name" && list[i + 2].type.label === ")" && list[i + 3].type.label === "=>") { skip.add(i); skip.add(i + 2); }
  for(let i=0;i+3<list.length;i++)if(list[i].type.label==="new"&&list[i+1].type.label==="name"&&list[i+2].type.label==="("&&list[i+3].type.label===")"){skip.add(i+2);skip.add(i+3);}
  return list.filter((token, index) => !skip.has(index) && token.type.label !== ";" && token.type.label !== "eof");
}
function variableToken(list: Token[], index: number) {
  const token = list[index];
  if (token.type.label !== "name" || fixedNames.has(String(token.value))) return false;
  // Properties/API names are contracts, while lexical names can change on every build.
  const before = list[index - 1]?.type.label, after = list[index + 1]?.type.label;
  const propertyKey = after === ":" && (before === "{" || before === ",");
  return before !== "." && before !== "?." && !propertyKey;
}
function tokenKey(token: Token) { return `${token.type.label}:${typeof token.value === "object" ? "" : String(token.value)}`; }
function indexTokens(all: Token[]): TokenIndex {
  const index: TokenIndex = new Map();
  for (let i = 0; i < all.length; i++) { const key = tokenKey(all[i]); const positions = index.get(key); if (positions) positions.push(i); else index.set(key, [i]); }
  return index;
}
function findMatches(all: Token[], template: string, index: TokenIndex): Match[] {
  const expected = tokens(template), results: Match[] = [];
  let anchor = 0, candidates: number[] = [];
  let count = Infinity;
  for (let i = 0; i < expected.length; i++) if (!variableToken(expected, i)) {
    const positions = index.get(tokenKey(expected[i])) ?? [];
    if (positions.length < count) { anchor = i; candidates = positions; count = positions.length; }
  }
  for (const position of candidates) {
    const start = position - anchor;
    if (start < 0 || start + expected.length > all.length) continue;
    if (all[start].type.label !== expected[0].type.label) continue;
    const binding: Binding = {}, reverse: Binding = {};
    let valid = true;
    for (let offset = 0; offset < expected.length; offset++) {
      const a = expected[offset], b = all[start + offset];
      if (a.type.label !== b.type.label) { valid = false; break; }
      if (variableToken(expected, offset)) {
        const from = String(a.value), to = String(b.value);
        if ((binding[from] && binding[from] !== to) || (reverse[to] && reverse[to] !== from)) { valid = false; break; }
        binding[from] = to; reverse[to] = from;
      } else if (a.value !== b.value) { valid = false; break; }
    }
    if (valid) results.push({ start: all[start].start, end: all[start + expected.length - 1].end, binding });
    if (results.length > 1) break;
  }
  return results;
}
function rebind(source: string, binding: Binding) {
  const list = tokens(source);
  let result = source;
  for (let i = list.length - 1; i >= 0; i--) {
    const token = list[i], name = String(token.value);
    if (variableToken(list, i) && binding[name]) result = result.slice(0, token.start) + binding[name] + result.slice(token.end);
  }
  return result;
}
// Optional host groups are independent of the quality group. Every contract must match once.
export function optionalContracts(source: string, specs: {find:string; replace?:string}[], globals:string[]) {
  const all=tokens(source), index=indexTokens(all), shared:Binding={};
  const edits:{start:number;end:number;value:string;binding:Binding}[]=[];
  for(const spec of specs){
    const matches=findMatches(all,spec.find,index);
    if(matches.length!==1) return null;
    const match=matches[0];
    for(const name of globals) if(match.binding[name]){
      if(shared[name] && shared[name]!==match.binding[name]) return null;
      shared[name]=match.binding[name];
    }
    if(spec.replace!==undefined) edits.push({start:match.start,end:match.end,value:spec.replace,binding:match.binding});
  }
  for(const name of globals) if(!shared[name]) return null;
  let body=source;
  for(const edit of edits.sort((a,b)=>b.start-a.start)) body=body.slice(0,edit.start)+rebind(edit.value,{...shared,...edit.binding})+body.slice(edit.end);
  return {body,binding:shared,rebind:(value:string)=>rebind(value,shared)};
}
export function contractMatchCounts(source:string,specs:{find:string}[]){const all=tokens(source),index=indexTokens(all);return specs.map(spec=>({find:spec.find,count:findMatches(all,spec.find,index).length}));}
function walk(root: Node, visit: (node: Node, scope: Node) => void, scope: Node = root) {
  if (!root || typeof root !== "object") return;
  if (root.type === "FunctionDeclaration" || root.type === "FunctionExpression" || root.type === "ArrowFunctionExpression") scope = root;
  if (root.type) visit(root, scope);
  for (const [key, child] of Object.entries(root)) {
    if (key === "start" || key === "end") continue;
    if (Array.isArray(child)) { for (const item of child) walk(item, visit, scope); }
    else if (child && typeof child === "object") walk(child, visit, scope);
  }
}
function declarationMap(ast: Node): Map<string, Node> {
  const map = new Map<string, Node>();
  for (const statement of ast.body) {
    const node = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (node?.type === "VariableDeclaration") {
      for (const entry of node.declarations) if (entry.id.type === "Identifier") map.set(entry.id.name, entry.init);
    } else if (node?.type === "FunctionDeclaration") map.set(node.id.name, node);
  }
  return map;
}
function literal(node: Node) { return node?.type === "Literal" ? node.value : undefined; }
function properties(node: Node): Map<string, Node> {
  return new Map(node?.type === "ObjectExpression" ? node.properties.filter((p: Node) => p.type === "Property").map((p: Node) => [p.key.name ?? p.key.value, p.value]) : []);
}

/** Match complete contracts, never execute the vendor bundle. Changes are committed as one group. */
export function compatibleQuality(body: string) {
  const fail = (reason: string, failedPatch?: string, status = "unsupported-structure") => ({ changed: false as const, body, status, reason, failedPatch, patches: [] as string[], binding: {} as Binding });
  if (Buffer.byteLength(body, "utf8") > MAX_SOURCE_BYTES) return fail("Размер интерфейса превышает поддерживаемый лимит");
  let ast: Node, all: Token[];
  try { const parsed: Token[] = []; ast = parse(body, { ...options, onToken: parsed }); all = normalizeTokens(parsed); } catch { return fail("Интерфейс не проходит проверку синтаксиса", undefined, "syntax-error"); }
  const ranges = new Map<string, { patch: SourcePatch; match: Match; scope?: Node }>();
  const shared: Binding = {};
  const index = indexTokens(all);
  for (const patch of nativeQualityPatches) {
    const matches = findMatches(all, patch.find, index);
    if (matches.length !== 1) return fail(matches.length ? "Найдено несколько участков для одного патча" : "Структура нужного участка изменилась", patch.id, matches.length ? "ambiguous-patch" : "unsupported-structure");
    const match = matches[0];
    for (const name of sharedNames) if (match.binding[name]) {
      if (shared[name] && shared[name] !== match.binding[name]) return fail("Связи между участками интерфейса изменились", patch.id);
      shared[name] = match.binding[name];
    }
    ranges.set(patch.id, { patch, match });
  }
  const collision = all.some(token => token.type.label === "name" && token.value === "__lmStockProfile");
  walk(ast, (node, scope) => {
    if (node !== scope) return;
    for (const entry of ranges.values()) if (node.start <= entry.match.start && node.end >= entry.match.end) {
      if (!entry.scope || scope.end - scope.start < entry.scope.end - entry.scope.start) entry.scope = scope;
    }
  });
  if (collision) return fail("Обнаружена уже применённая или конфликтующая модификация");
  const pickerScope = ranges.get("picker-resolution-options")!.scope;
  if (!pickerScope || pickerScope.type === "Program" || ["picker-fallback-options", "picker-fps-options"].some(id => ranges.get(id)!.scope !== pickerScope)) return fail("Пункты качества находятся в разных компонентах");
  const declarations = declarationMap(ast);
  const pickerCalls = new Set<string>();
  walk(pickerScope, node => { if (node.type === "CallExpression" && node.callee.type === "Identifier") pickerCalls.add(node.callee.name); });
  for (const name of ["$tr", "Btr"]) if (!pickerCalls.has(shared[name]) || declarations.get(shared[name])?.type !== "FunctionDeclaration") return fail("Компонент выбора больше не использует проверенные списки качества", name);
  const encoder = declarations.get(shared.V2e);
  let appliesParameters = false;
  const encoderBinding = ranges.get("screen-encoder-resolution")!.match.binding;
  if (encoder) walk(encoder, node => {
    if (node.type === "CallExpression" && node.callee.type === "MemberExpression" && node.callee.object.name === encoderBinding.t && node.callee.property.name === "setParameters" && node.arguments[0]?.name === encoderBinding.n) appliesParameters = true;
  });
  if (!appliesParameters) return fail("Изменился контракт применения параметров кодирования", "screen-encoder-resolution");
  const constants: Record<string, string | number> = { my: "720p", xg: "1080p", vR: "1440p", Q1: 30, uM: 60 };
  for (const [key, value] of Object.entries(constants)) if (literal(declarations.get(shared[key])) !== value) return fail("Изменились значения разрешений или частоты кадров", key);
  const table = declarations.get(shared.mS);
  if (table?.type !== "ObjectExpression") return fail("Не найдена таблица размеров экрана");
  for (const [key, width, height] of [["my", 1280, 720], ["xg", 1920, 1080], ["vR", 2560, 1440]] as const) {
    const entry = table.properties.find((p: Node) => p.computed && p.key.type === "Identifier" && p.key.name === shared[key]);
    const values = properties(entry?.value), bitrate = literal(values.get("freeBitrate"));
    if (literal(values.get("width")) !== width || literal(values.get("height")) !== height || typeof bitrate !== "number" || bitrate <= 0) return fail("Таблица размеров или битрейта изменилась", "screen-size-table");
  }
  // Bind the active-profile getter through its use in the same native live menu.
  const live = ranges.get("live-menu-options")!;
  const active = findMatches(all, 'const Er=Ir?Lyt():null,xo=typeof window.electronAPI<"u",', index);
  if (active.length === 1 && live.scope && active[0].start >= live.scope.start && active[0].end <= live.scope.end && declarations.has(active[0].binding.Lyt)) shared.Lyt = active[0].binding.Lyt;
  let result = body;
  for (const { patch, match } of [...ranges.values()].sort((a, b) => b.match.start - a.match.start)) result = result.slice(0, match.start) + rebind(patch.replace, match.binding) + result.slice(match.end);
  return { changed: true as const, body: result, status: "transformed", reason: "Структура патчей совместима", patches: [...ranges.keys()], binding: shared };
}

export function validateModule(source: string) { parse(source, options); }
