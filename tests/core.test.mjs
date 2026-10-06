import assert from "node:assert/strict";
import test from "node:test";

import { PluginManager, Scope } from "../dist/lifecycle.mjs";
import { DEFAULT_SETTINGS, MAX_CSS_LENGTH, validateSettings } from "../dist/settings.mjs";

test("plugin start and stop can repeat without leaking scoped resources", () => {
  const manager = new PluginManager();
  let activeResources = 0;
  let starts = 0;
  let cleanups = 0;

  manager.register({
    id: "cycle",
    start(scope) {
      starts += 1;
      activeResources += 1;
      scope.add(() => {
        activeResources -= 1;
        cleanups += 1;
      });
    },
  });

  for (let cycle = 0; cycle < 100; cycle += 1) {
    manager.start("cycle");
    assert.equal(activeResources, 1);
    manager.stop("cycle");
    assert.equal(activeResources, 0);
  }

  assert.equal(starts, 100);
  assert.equal(cleanups, 100);
  assert.deepEqual(manager.status().active, []);
});

test("duplicate start and stop are idempotent", () => {
  const manager = new PluginManager();
  let starts = 0;
  let cleanups = 0;
  manager.register({
    id: "once",
    start(scope) {
      starts += 1;
      scope.add(() => { cleanups += 1; });
    },
  });

  manager.start("once");
  manager.start("once");
  assert.equal(starts, 1);
  manager.stop("once");
  manager.stop("once");
  assert.equal(cleanups, 1);
});

test("failed start cleans its scope and does not prevent another plugin starting", () => {
  const manager = new PluginManager();
  let resources = 0;
  let healthyStarted = false;
  manager.register({
    id: "broken",
    start(scope) {
      resources += 1;
      scope.add(() => { resources -= 1; });
      throw new Error("start failed");
    },
  });
  manager.register({
    id: "healthy",
    start(scope) {
      healthyStarted = true;
      scope.add(() => { healthyStarted = false; });
    },
  });

  manager.start("broken");
  assert.equal(resources, 0);
  assert.deepEqual(manager.status().failed, ["broken"]);

  manager.start("healthy");
  assert.equal(healthyStarted, true);
  assert.deepEqual(manager.status().active, ["healthy"]);
  manager.stopAll();
  assert.equal(healthyStarted, false);
});

test("a cleanup exception does not stop remaining cleanup and dispose is idempotent", () => {
  const scope = new Scope();
  const cleaned = [];
  scope.add(() => { cleaned.push("first"); });
  scope.add(() => { cleaned.push("throws"); throw new Error("cleanup failed"); });
  scope.add(() => { cleaned.push("last"); });

  scope.dispose();
  scope.dispose();

  assert.deepEqual(cleaned, ["last", "throws", "first"]);
  assert.equal(scope.size, 0);
});

test("manager rejects unknown and duplicate plugin registrations", () => {
  const manager = new PluginManager();
  const plugin = { id: "known", start() {} };
  manager.register(plugin);

  assert.throws(() => manager.start("missing"), /Unknown plugin/);
  assert.throws(() => manager.register(plugin), /Duplicate plugin id/);
  assert.deepEqual(manager.status().registered, ["known"]);
});

test("settings validation rejects malformed, unknown, and oversized values", () => {
  const invalidValues = [
    null,
    [],
    { enabled: false, customCss: "", unexpected: true },
    { enabled: "yes", customCss: "" },
    { enabled: false, customCss: 42 },
    { enabled: false, customCss: "x".repeat(MAX_CSS_LENGTH + 1) },
    { customCss: "" },
    { enabled: false },
  ];

  for (const value of invalidValues) {
    assert.throws(() => validateSettings(value), /Invalid settings/);
  }
  assert.throws(() => validateSettings({ enabled: false, customCss: "", qualityEnabled: "yes" }), /Invalid quality toggle/);
  assert.throws(() => validateSettings({ enabled: false, customCss: "", profile: [] }), /Invalid stream profile/);
});

test("legacy CSS-only settings migrate to quality disabled with a copied default profile", () => {
  const legacy = { enabled: true, customCss: "body { color: purple; }" };
  const migrated = validateSettings(legacy);

  assert.deepEqual(migrated, {
    ...DEFAULT_SETTINGS,
    ...legacy,
    qualityEnabled: false,
    profile: DEFAULT_SETTINGS.profile,
  });
  assert.notStrictEqual(migrated.profile, DEFAULT_SETTINGS.profile);
  assert.deepEqual(legacy, { enabled: true, customCss: "body { color: purple; }" });
});
test("feature settings reject non-string themes and non-boolean toggles",()=>{
  for(const themeId of [["native"],null,{},0]) assert.throws(()=>validateSettings({...DEFAULT_SETTINGS,themeId}),/Invalid theme/);
  for(const key of ["indicatorEnabled","indicatorDetailed","miniPlayerEnabled","streamMenuEnabled","soundThemeEnabled"])
    for(const value of [1,"true",null]) assert.throws(()=>validateSettings({...DEFAULT_SETTINGS,[key]:value}),/Invalid feature toggle/);
});

test("settings validation returns detached top-level and nested profile copies", () => {
  const original = {
    enabled: true,
    customCss: "body { color: purple; }",
    qualityEnabled: true,
    profile: { resolution: "1080p", fps: 30, codec: "VP8", bitrateMbps: 10 },
  };
  const validated = validateSettings(original);
  const secondCopy = validateSettings(original);

  assert.deepEqual(validated, {...DEFAULT_SETTINGS,...original});
  assert.notStrictEqual(validated, original);
  assert.notStrictEqual(validated.profile, original.profile);
  assert.notStrictEqual(secondCopy.profile, validated.profile);
  validated.enabled = false;
  validated.customCss = "changed";
  validated.profile.resolution = "720p";
  validated.profile.bitrateMbps = 2;
  assert.deepEqual(original, {
    enabled: true,
    customCss: "body { color: purple; }",
    qualityEnabled: true,
    profile: { resolution: "1080p", fps: 30, codec: "VP8", bitrateMbps: 10 },
  });
  assert.deepEqual(secondCopy.profile, { resolution: "1080p", fps: 30, codec: "VP8", bitrateMbps: 10 });
});
