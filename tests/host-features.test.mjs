import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { build, transform } from 'esbuild';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = path.join(workspace, 'research/public-frontend/pinned-entry.js');
const hasFixture = existsSync(fixturePath);
const privateTest = (name, callback) => test(name, { skip: !hasFixture && 'Private pinned vendor fixture is not distributed' }, callback);
async function sourceModule(relative) {
  const result = await build({ entryPoints: [path.join(workspace, `src/main/${relative}.ts`)], bundle: true,
    platform: 'node', format: 'esm', target: 'es2022', write: false, logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
const [{ transformHostFeatures, hostContractSpecs }, { optionalContracts, contractMatchCounts }] = await Promise.all([
  sourceModule('host-features'), sourceModule('compatible-quality'),
]);
let cachedFixture, cachedBaseResult, cachedRenamed;
async function fixture() { return cachedFixture ??= await fs.readFile(fixturePath, 'utf8'); }
async function baseResult() { return cachedBaseResult ??= transformHostFeatures(await fixture(), 'test-fixture-hash', true); }
async function renamedFixture() {
  return cachedRenamed ??= (await transform(await fixture(), { loader: 'js', format: 'esm', minifyIdentifiers: true,
    minifySyntax: false, minifyWhitespace: false })).code;
}
const syntax = source => parse(source, { ecmaVersion: 'latest', sourceType: 'module' });

function findArrowReturningChangeSource(source) {
  const found = [];
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ArrowFunctionExpression' && node.body.type === 'BlockStatement'
      && node.body.body.some(statement => statement.type === 'ReturnStatement'
        && statement.argument?.type === 'ObjectExpression'
        && statement.argument.properties.some(property => property.key?.name === 'changeSource'))) found.push(node);
    for (const [key, child] of Object.entries(node)) {
      if (key === 'start' || key === 'end') continue;
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === 'object') visit(child);
    }
  };
  visit(syntax(source)); assert.equal(found.length, 1, 'one hook owns the newly exposed source-change callback');
  return source.slice(found[0].start, found[0].end);
}

const hookContracts = new Map();
async function sourceHook(source, { native = true, desktop = true } = {}) {
  let contract = hookContracts.get(source);
  if (!contract) {
    const transformed = transformHostFeatures(source, 'test-hook-hash');
    assert.equal(transformed.features.controls, 'available');
    const names = ['Xe', 's2e', 'Ht', 'cn', 'v', '$ae', 'pgt', 'Y2e', 'Sxe', 'bxe', 'Iyt', '_e', 'dgt', '_2', 'Ryt', 'fB', 'RG', 'PE'];
    const match = optionalContracts(source, hostContractSpecs.controls, names);
    assert.ok(match, 'all helper aliases are consistently rebound across the same controls contracts');
    contract = { script: new vm.Script(`(${findArrowReturningChangeSource(transformed.body)})`), binding: match.binding };
    hookContracts.set(source, contract);
  }
  const binding = contract.binding;
  let rendering=true;
  const voiceState={isScreenSharing:true};
  const inRender=fn=>(...args)=>{assert.equal(rendering,true,'React hook called from an event/async callback');return fn(...args);};
  const events = [], media = [], modals = [], sources = [{ id: 'window:synthetic', name: 'Synthetic source' }];
  let releaseStop, rejectStop;
  const stop = kind => {
    events.push(`stop:${kind}:begin`);
    return new Promise((resolve, reject) => {
      releaseStop = value => { events.push(`stop:${kind}:done`); resolve(value); };
      rejectStop = error => { events.push(`stop:${kind}:failed`); reject(error); };
    });
  };
  const scope = { console, window: { ...(desktop ? { electronAPI: {} } : {}),
    addEventListener() {}, removeEventListener() {} } };
  const put = (name, value) => { assert.ok(binding[name], `binding ${name} exists`); scope[binding[name]] = value; };
  put('Xe', inRender(() => ({ t: value => value })));
  put('s2e', inRender(() => voiceState.isScreenSharing));
  put('Ht', {getState:()=>voiceState});
  put('cn', inRender(() => ({ openModal: (type, props) => { events.push('picker'); modals.push({ type, props }); },
    closeModal: type => events.push(`close:${type}`) })));
  put('v', { useCallback: inRender(fn => fn), useEffect: inRender(() => {}) });
  put('$ae', () => native);
  put('_e', { ElectronSourcePicker: 'picker', Alert: 'alert' });
  put('pgt', async value => { events.push('start:native'); media.push(value); });
  put('Y2e', () => null); put('Sxe', () => assert.fail('inactive profile should not be propagated'));
  put('bxe', value => value);
  put('Iyt', async (...args) => { events.push('start:legacy'); media.push(args); return { success: true }; });
  put('dgt', async () => ({ sources, capabilities: { codecs: ['AV1'], audio: true } }));
  put('_2', () => 0);
  put('Ryt', async () => sources);
  put('fB', () => native); put('RG', () => stop('native'));
  put('PE', channel => { events.push(`channel:${channel}`); return stop('legacy'); });
  const hook = contract.script.runInNewContext(scope)();
  rendering=false;
  return { hook, events, media, modals, sources, voiceState,
    release: value => { assert.ok(releaseStop); releaseStop(value); },
    fail: error => { assert.ok(rejectStop); rejectStop(error); } };
}

test('unknown valid renderer preserves original bytes and leaves optional groups unavailable', () => {
  const source = 'export const label = "public source";\r\n';
  const result = transformHostFeatures(source, 'public-hash');
  assert.deepEqual(result.features, { settings: 'unsupported', controls: 'unsupported', streamTools: 'unsupported' });
  assert.equal(result.changed, false); assert.equal(result.body, source);
});

privateTest('pinned host settings and stream controls are independently available with valid generated ESM', async () => {
  const result = await baseResult();
  assert.deepEqual(result.features, { settings: 'available', controls: 'available', streamTools: 'available' });
  assert.equal(result.changed, true); syntax(result.body);
  assert.ok(result.body.includes('modules.register("HostSettings"'));
  assert.ok(result.body.includes('modules.register("StreamControls"'));
  assert.equal((result.body.match(/function __lmHostSettings\(/g) ?? []).length, 1);
  assert.equal((result.body.match(/function __lmHostToolbar\(/g) ?? []).length, 1);
});

privateTest('renamed lexical bindings, whitespace and comments preserve both optional hooks', async () => {
  const renamed = await renamedFixture();
  assert.notEqual(renamed, await fixture());
  for (const source of [renamed, `${await fixture()}\n/* unrelated feature release */\n`]) {
    const result = transformHostFeatures(source, 'renamed-hash');
    assert.deepEqual(result.features, { settings: 'available', controls: 'available', streamTools: 'available' }); syntax(result.body);
    assert.ok(result.body.includes('data-lolkamod-host-settings')); assert.ok(result.body.includes('data-lolkamod-host-toolbar'));
  }
});

privateTest('missing and duplicate settings anchors fail only their optional settings group', async () => {
  const original = await fixture(), spec = hostContractSpecs.settings[0];
  assert.ok(original.includes(spec.find));
  for (const source of [original.replace(spec.find, spec.find.replace('groups.app', 'groups.changed')),
    `${original}\nconst duplicateSettingsGroup=${spec.find};\n`]) {
    const result = transformHostFeatures(source, 'settings-mismatch');
    assert.deepEqual(result.features, { settings: 'unsupported', controls: 'available', streamTools: 'available' }); syntax(result.body);
    assert.equal(result.body.includes('modules.register("HostSettings"'), false);
    assert.equal(result.body.includes('modules.register("StreamControls"'), true);
    assert.equal(result.body.includes('function __lmHostSettings('), false);
  }
});

privateTest('changed or duplicate control contracts fail only their optional controls group', async () => {
  const original = await fixture(), signature = hostContractSpecs.controls[0].find;
  assert.ok(original.includes(signature));
  const duplicate = hostContractSpecs.controls[8].find;
  for (const source of [original.replace(signature, signature.replace('handleScreenShare:c', 'handleScreenShareChanged:c')),
    `${original}\nconst duplicateControls=()=>{let aie;${duplicate};};\n`]) {
    const result = transformHostFeatures(source, 'controls-mismatch');
    assert.deepEqual(result.features, { settings: 'available', controls: 'unsupported', streamTools: 'available' }); syntax(result.body);
    assert.equal(result.body.includes('modules.register("HostSettings"'), true);
    assert.equal(result.body.includes('modules.register("StreamControls"'), false);
    assert.equal(result.body.includes('function __lmHostToolbar('), false);
  }
});

privateTest('stock voice callback and audio expression remain intact; added code does not capture or alter auth', async () => {
  const original = await fixture(), result = await baseResult();
  assert.ok(original.includes(hostContractSpecs.controls[4].find));
  assert.ok(result.body.includes(hostContractSpecs.controls[4].find), 'native/legacy stock start callback bytes are preserved');
  assert.equal(contractMatchCounts(result.body, [hostContractSpecs.controls[4]])[0].count, 1);
  const hookText = findArrowReturningChangeSource(result.body);
  assert.ok(hookText.includes('audio:f===!1'), 'original native audio boolean forwarding is retained');
  const originalHook = original.slice(original.indexOf('hDe=()=>{'), original.indexOf('hDe=()=>{') + hookText.length);
  const originalBody = originalHook.slice(0, originalHook.indexOf(hostContractSpecs.controls[0].find));
  assert.ok(hookText.startsWith(originalBody.replace(/^hDe=/, '')), 'original voice hook body before return contract is unchanged');
  const added = hookText.slice(hookText.indexOf('changeSource:')) + result.body.slice(result.body.indexOf('function __lmHostSettings('));
  assert.doesNotMatch(added, /getUserMedia|getDisplayMedia|premium_level|accessToken|localStorage\.setItem|audioContext|noiseSuppression/);
});

privateTest('source picker cancellation leaves active native and legacy streams untouched', async () => {
  for (const native of [true, false]) {
    const { hook, events, media, modals, sources } = await sourceHook(await fixture(), { native });
    assert.equal(hook.isScreenSharing, true); assert.equal(hook.isElectron, true);
    await hook.changeSource(77); assert.equal(modals.length, 1); assert.strictEqual(modals[0].props.sources, sources);
    assert.equal(events.some(value => value.startsWith('stop:')), false); assert.equal(media.length, 0);
    modals[0].props.onCancel();
    assert.equal(events.some(value => value.startsWith('stop:')), false); assert.equal(media.length, 0);
    assert.deepEqual(events, ['picker', 'close:picker']);
    if (native) assert.equal(modals[0].props.native.audio, true, 'existing native capability is forwarded unchanged');
    else assert.equal(modals[0].props.native, undefined);
  }
});

privateTest('native source selection awaits stop then forwards original channel, quality, codec and audio boolean', async () => {
  for (const source of [await fixture(), await renamedFixture()]) {
    const { hook, events, media, modals, release } = await sourceHook(source, { native: true });
    await hook.changeSource(77);
    const selecting = modals[0].props.onSourceSelect('window:replacement', false, '1440p', 60, 'av1');
    assert.deepEqual(events, ['picker', 'stop:native:begin']); assert.equal(media.length, 0);
    release(); await selecting;
    assert.deepEqual(events, ['picker', 'stop:native:begin', 'stop:native:done', 'close:picker', 'start:native']);
    assert.equal(media.length, 1);
    assert.equal(JSON.stringify(media[0]), JSON.stringify({ sourceId: 'window:replacement', channelId: 77,
      resolution: '1440p', fps: 60, codec: 'av1', audio: true }));
  }
});

privateTest('legacy selection awaits stop and retains stock positional parameters after name rebinding', async () => {
  for (const source of [await fixture(), await renamedFixture()]) {
    const { hook, events, media, modals, release } = await sourceHook(source, { native: false });
    await hook.changeSource(88);
    const selecting = modals[0].props.onSourceSelect('window:replacement', true, '1080p', 30, 'vp9');
    assert.deepEqual(events, ['picker', 'channel:88', 'stop:legacy:begin']); assert.equal(media.length, 0);
    release(); await selecting;
    assert.deepEqual(events, ['picker', 'channel:88', 'stop:legacy:begin', 'stop:legacy:done', 'close:picker', 'start:legacy']);
    assert.equal(JSON.stringify(media[0]), JSON.stringify(['window:replacement', 88, true, '1080p', 30, 'vp9']));
  }
});

privateTest('source selection uses imperative latest state after stream ended while picker was open', async () => {
  for(const source of [await fixture(),await renamedFixture()]){
    const {hook,events,media,modals,voiceState}=await sourceHook(source,{native:false});
    await hook.changeSource(88);voiceState.isScreenSharing=false;
    await modals[0].props.onSourceSelect('window:replacement',true,'1080p',30,'vp9');
    assert.equal(events.some(event=>event.startsWith('stop:')),false);
    assert.equal(media.length,1);
  }
});

privateTest('source change refuses a non-desktop host before opening picker or stopping existing streams', async () => {
  const { hook, events, media, modals } = await sourceHook(await fixture(), { desktop: false });
  assert.equal(hook.isElectron, false);
  await assert.rejects(hook.changeSource(77), /desktop Lolka/);
  assert.deepEqual(events, []); assert.equal(media.length, 0); assert.equal(modals.length, 0);
});

privateTest('repeated source selection while stop is pending starts only one replacement stream', async () => {
  const { hook, events, media, modals, release } = await sourceHook(await fixture());
  await hook.changeSource(77);
  const callback = modals[0].props.onSourceSelect;
  const selecting = callback('window:first', false, '1440p', 60, 'av1');
  await callback('window:second', false, '720p', 30, 'vp9');
  assert.deepEqual(events, ['picker', 'stop:native:begin']);
  release(); await selecting;
  assert.equal(media.length, 1); assert.equal(media[0].sourceId, 'window:first');
});

privateTest('native stop rejection or legacy stop failure alerts without starting a replacement stream', async () => {
  for (const native of [true, false]) {
    const { hook, events, media, modals, release, fail } = await sourceHook(await fixture(), { native });
    await hook.changeSource(77);
    const selecting = modals[0].props.onSourceSelect('window:replacement', false, '1440p', 60, 'av1');
    if (native) fail(new Error('Synthetic stop failure')); else release({ success: false });
    await selecting;
    assert.equal(media.length, 0); assert.equal(events.some(value => value.startsWith('start:')), false);
    assert.equal(modals.at(-1).type, 'alert'); assert.equal(typeof modals.at(-1).props.message, 'string');
  }
});

privateTest('missing and duplicate selected-stream anchors fail only the stream tools group', async () => {
  const original=await fixture(), spec=hostContractSpecs.streamTools[0];
  for(const source of [original.replace(spec.find,spec.find.replace('screenShare.live','screenShare.changed')), original+'\nconst extra=()=>'+spec.find+';' ]) {
    const result=transformHostFeatures(source,'tools-mismatch');
    assert.equal(result.features.settings,'available');assert.equal(result.features.controls,'available');
    assert.equal(result.features.streamTools,'unsupported');assert.equal(result.body.includes('function __lmHostStreamTools('),false);
  }
});
