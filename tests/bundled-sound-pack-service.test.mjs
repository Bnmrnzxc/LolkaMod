import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { transform } from "esbuild";

const source = await readFile(new URL("../src/main/bundled-sound-pack-service.ts", import.meta.url), "utf8");
const { code } = await transform(source, { loader: "ts", format: "esm", target: "node22" });
const { createBundledSoundPackService } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

function fixture(count = 15) {
  const bytes = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0, 0, 0, 0, 0]);
  const specs = Array.from({ length: count }, (_, i) => ({
    key: `sound_${i}`, sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length, mimeType: "audio/mpeg",
  }));
  const pack = { id: "discord", assets: specs.map(({ key }) => ({ key, mimeType: "audio/mpeg", base64: bytes.toString("base64") })) };
  return { specs, pack, bytes };
}

test("validates all bundled assets on first load without using fetch", async () => {
  const { specs, pack } = fixture();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("fetch must not be called"); };
  try {
    const service = createBundledSoundPackService(specs, pack);
    assert.deepEqual(service.status(), { state: "idle" });
    const loaded = await service.load();
    assert.equal(loaded.assets.length, 15);
    assert.deepEqual(loaded.assets.map(({ key }) => key), specs.map(({ key }) => key));
    assert.deepEqual(service.status(), { state: "ready" });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("rejects malformed catalogs and payloads with bounded public status", async (t) => {
  const cases = [
    ["checksum", (f) => { f.specs[0].sha256 = "0".repeat(64); }, "sound_0"],
    ["unknown", (f) => { f.specs.push({ ...f.specs[0] }); }, "sound_0"],
    ["unknown", (f) => { f.pack.assets[1].key = "missing"; }],
    ["format", (f) => { f.pack.assets[0].base64 = "!".repeat(16); }, "sound_0"],
    ["format", (f) => { const raw = Buffer.alloc(f.bytes.length, 1); f.pack.assets[0].base64 = raw.toString("base64"); f.specs[0].sha256 = createHash("sha256").update(raw).digest("hex"); }, "sound_0"],
    ["unknown", (f) => { delete f.specs[0]; }],
    ["unknown", (f) => { delete f.pack.assets[0]; }],
    ["size", (f) => { f.specs[0].bytes = 2 * 1024 * 1024 + 1; }, "sound_0"],
    ["unknown", (f) => { f.specs = Array.from({ length: 33 }, (_, i) => ({ ...f.specs[0], key: `asset_${i}` })); }],
    ["size", (f) => { f.specs = Array.from({ length: 17 }, (_, i) => ({ ...f.specs[0], key: `asset_${i}`, bytes: 2 * 1024 * 1024 })); }, "asset_16"],
    ["type", (f) => { f.pack.assets[0].mimeType = "application/octet-stream"; }, "sound_0"],
  ];
  for (const [expectedCode, mutate, asset] of cases) await t.test(expectedCode, async () => {
    const f = fixture(2);
    mutate(f);
    const service = createBundledSoundPackService(f.specs, f.pack);
    await assert.rejects(service.load(), /validation failed/);
    assert.deepEqual(service.status(), { state: "error", stage: "verify", ...(asset ? { asset } : {}), code: expectedCode });
  });
});

test("caller mutations cannot poison the captured snapshot or returned copies", async () => {
  const f = fixture(2);
  const service = createBundledSoundPackService(f.specs, f.pack);
  f.specs[0].sha256 = "0".repeat(64);
  f.pack.assets[0].base64 = "bad";
  const first = await service.load();
  first.assets[0].base64 = "corrupted";
  first.assets.pop();
  const exposedStatus = service.status();
  exposedStatus.code = "unknown";
  const next = await service.load();
  assert.equal(next.assets.length, 2);
  assert.equal(next.assets[0].base64, f.bytes.toString("base64"));
  assert.deepEqual(service.status(), { state: "ready" });
});

test("stop is irreversible and cancels loads", async () => {
  const f = fixture(1);
  const service = createBundledSoundPackService(f.specs, f.pack);
  service.stop();
  assert.deepEqual(service.status(), { state: "error", stage: "verify", code: "cancelled" });
  await assert.rejects(service.load(), /cancelled/);
  assert.deepEqual(service.status(), { state: "error", stage: "verify", code: "cancelled" });
});
