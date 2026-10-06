import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import {build} from 'esbuild';
const compiled=await build({entryPoints:['src/shared/discord-sounds.ts'],bundle:true,write:false,platform:'node',format:'esm'});
const {DISCORD_SOUND_ASSETS:specs,DISCORD_ACTION_MAP:mapping}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const pack=JSON.parse(await fs.readFile('assets/sounds/discord/classic.json','utf8'));
test('the public offline pack contains all pinned classic sounds and all 16 actions',()=>{
 assert.equal(specs.length,15);assert.equal(pack.id,'discord');assert.equal(pack.assets.length,15);
 assert.deepEqual(new Set(pack.assets.map(a=>a.key)),new Set(specs.map(a=>a.key)));
 let total=0;
 for(const spec of specs){
  const asset=pack.assets.find(a=>a.key===spec.key);assert.equal(asset.mimeType,spec.mimeType);
  const bytes=Buffer.from(asset.base64,'base64');assert.equal(bytes.toString('base64'),asset.base64);
  assert.equal(bytes.length,spec.bytes);assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),spec.sha256);
  assert.ok(bytes.subarray(0,3).equals(Buffer.from('ID3'))||(bytes[0]===0xff&&(bytes[1]&0xe0)===0xe0));total+=bytes.length;
 }
 assert.equal(total,720935);assert.equal(Object.keys(mapping).length,16);
 for(const key of Object.values(mapping))assert.ok(specs.some(a=>a.key===key));
});
test('the asset provenance identifies the exact embedded bytes',async()=>{
 const provenance=JSON.parse(await fs.readFile('assets/sounds/discord/provenance.json','utf8'));
 assert.deepEqual(provenance.assets,specs);
 assert.equal(provenance.soundContextModuleId,'696354');
 assert.equal(provenance.bootstrapSha256,'591665b7c86f9f500fa18d1b8c831f75dc628b87540fccffab26ab8fd1e127ab');
});
