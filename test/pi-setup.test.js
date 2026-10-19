import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./helpers/pi-fixture.js";
import { createModelRuntime } from "../src/pi-runtime.js";
const setup = await import("../src/setup.js").catch(() => ({}));
test("known provider setup uses Pi secret login and stores ordered references without generation", async (t) => {
  assert.equal(typeof setup.setupModels, "function");
  const f = await fixture(t);
  const runtime = await createModelRuntime(f.home);
  const prompts = [];
  let roles = 0;
  const io = {
    notify() {},
    async select(label, options) {
      prompts.push(label);
      if (label.includes("服务商")) return "openai";
      if (label.includes("认证")) return "api_key";
      if (label.includes("添加副模型")) return ++roles === 1 ? "yes" : "no";
      return options[roles ? 1 : 0].id;
    },
    async prompt(p) {
      prompts.push(p.type);
      return "new-fixture-secret";
    },
  };
  const config = await setup.setupModels({ home: f.home, modelRuntime: runtime, io });
  assert.equal(config.formatVersion, 2);
  assert.equal(config.secondary.length, 1);
  assert.equal(f.calls.length, 0);
  assert.doesNotMatch(readFileSync(join(f.home, "config.json"), "utf8"), /secret|apiKey|baseUrl/);
  assert.ok(prompts.includes("secret"));
  assert.ok(!prompts.some((p) => /endpoint|协议|token 字段/.test(p)));
});
test("cancelled or failed atomic setup preserves previous config", async (t) => {
  assert.equal(typeof setup.setupModels, "function");
  const f = await fixture(t);
  const { saveConfig } = await import("../src/config.js");
  const old = { formatVersion: 2, ...f.models };
  saveConfig(f.home, old);
  const before = readFileSync(join(f.home, "config.json"), "utf8");
  await assert.rejects(
    setup.setupModels({
      home: f.home,
      io: {
        select() {
          throw Error("cancel");
        },
      },
    }),
    /cancel/,
  );
  assert.equal(readFileSync(join(f.home, "config.json"), "utf8"), before);
});
test("explicit legacy import backs up original bytes and never duplicates keys into roles", async (t) => {
  const { writeFileSync } = await import("node:fs");
  const { loadConfig } = await import("../src/config.js");
  const f = await fixture(t);
  const old = {
    main: { baseUrl: f.endpoint, model: "main", apiKey: "old-main-key", maxOutputTokens: 77 },
    reviewer: { baseUrl: f.endpoint, model: "r1", apiKey: "old-review-key" },
  };
  writeFileSync(join(f.home, "config.json"), JSON.stringify(old));
  const before = readFileSync(join(f.home, "config.json"), "utf8");
  const result = await setup.importLegacyConfig({ home: f.home });
  assert.equal(readFileSync(result.backup, "utf8"), before);
  assert.equal(loadConfig(f.home).formatVersion, 2);
  assert.equal(loadConfig(f.home).main.maxOutputTokens, 77);
  assert.doesNotMatch(readFileSync(join(f.home, "config.json"), "utf8"), /old-main-key|old-review-key/);
  assert.equal(f.calls.length, 0);
});
