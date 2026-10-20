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
      if (label.includes("确认保存")) return "save";
      if (label.includes("服务商")) return "openai";
      if (label.includes("认证")) return "api_key";
      if (label.includes("添加副模型")) return "no";
      return options[label.includes("副模型") ? 1 : 0].id;
    },
    async prompt(p) {
      prompts.push(p.type);
      return p.type === "secret" ? "new-fixture-secret" : "首个队伍";
    },
  };
  const config = await setup.setupModels({ home: f.home, modelRuntime: runtime, io });
  assert.equal(config.formatVersion, 3);
  assert.equal(config.teams[0].secondary.length, 1);
  assert.equal(config.teams[0].name, "首个队伍");
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


test("model selection reuses configured auth and migration preserves original bytes/settings", async (t) => {
  const f = await fixture(t);
  const runtime = await createModelRuntime(f.home);
  let secrets = 0;
  const io = { notify() {}, async select(label, options) { return label.includes("服务商") ? "fixture" : options[0].id; },
    async prompt(p) { if (p.type === "secret") { secrets++; throw Error("unexpected auth"); } return "迁移队伍"; } };
  await setup.selectModelRef({runtime, home:f.home, io, role:"主"});
  await setup.selectModelRef({runtime, home:f.home, io, role:"副"});
  const { saveConfig } = await import("../src/config.js");
  const old = {formatVersion:2, ...f.models, piResources:{skills:["unchanged"]}, work:{checks:[]}};
  saveConfig(f.home, old);
  const raw = readFileSync(join(f.home,"config.json"),"utf8");
  const next = await setup.migrateTeamConfig({home:f.home, io});
  assert.equal(next.formatVersion,3); assert.equal(next.teams[0].name,"迁移队伍");
  assert.deepEqual(next.teams[0].secondary,old.secondary);
  assert.deepEqual(next.piResources,old.piResources); assert.deepEqual(next.work,old.work);
  const {readdirSync} = await import("node:fs");
  assert.ok(readdirSync(join(f.home,"backups")).some(name => readFileSync(join(f.home,"backups",name),"utf8")===raw));
  assert.deepEqual(await setup.migrateTeamConfig({home:f.home,io}),next);
  assert.equal(secrets,0); assert.equal(f.calls.length,0);
});

test("cancelling migration or changing config while naming cannot overwrite the original", async (t) => {
  const f=await fixture(t); const {saveConfig}=await import("../src/config.js");
  const old={formatVersion:2,...f.models}; saveConfig(f.home,old);
  const path=join(f.home,"config.json"), raw=readFileSync(path,"utf8");
  await assert.rejects(setup.migrateTeamConfig({home:f.home,io:{async prompt(){return undefined;}}}),/取消/);
  assert.equal(readFileSync(path,"utf8"),raw);
  await assert.rejects(setup.migrateTeamConfig({home:f.home,io:{async prompt(){saveConfig(f.home,{...old,secondary:old.secondary.slice(0,1)});return "stale";}}}),/变化|刷新/);
  assert.equal(JSON.parse(readFileSync(path,"utf8")).secondary.length,1);
  assert.equal(f.calls.length,0);
});


test("single-model legacy one remains usable; a named team requires adding a reviewer", async(t)=>{
  const f=await fixture(t);const {saveConfig}=await import("../src/config.js");
  const {invoke}=await import("./helpers/cli-fixture.js");
  saveConfig(f.home,{formatVersion:2,main:f.models.main,secondary:[]});
  const one=await invoke(f,["ask","--one","question"]);assert.equal(one.code,0,one.stderr);
  const ordinary=await invoke(f,["ask","question"]);assert.notEqual(ordinary.code,0);assert.equal(f.calls.length,1);
  const c=await setup.migrateTeamConfig({home:f.home,io:{notify(){},async select(label,options){if(label.includes("服务商"))return "fixture";if(label.includes("副模型"))return "r1";return options[0].id;},async prompt(p){assert.notEqual(p.type,"secret");return "补齐队伍";}}});
  assert.equal(c.teams[0].secondary.length,1);assert.equal(c.teams[0].secondary[0].modelId,"r1");
  assert.equal(f.calls.length,1);
});

test("setup on v3 appends a team without resetting global settings or existing rosters",async(t)=>{
  const f=await fixture(t);const {saveConfig}=await import("../src/config.js");
  const {createTeamConfig}=await import("../src/teams.js");
  const old=createTeamConfig({formatVersion:2,...f.models,piResources:{skills:["preserved"]}},"original","7c8094cd-3476-4bfa-8f53-055d87972896");
  saveConfig(f.home,old);
  const next=await setup.setupModels({home:f.home,io:{notify(){},async select(label,options){if(label.includes("服务商"))return "fixture";if(label.includes("副模型"))return label.includes("添加")?"no":"r1";return options[0].id;},async prompt(p){assert.notEqual(p.type,"secret");return "new";}}});
  assert.equal(next.teams.length,2);assert.deepEqual(next.teams[0],old.teams[0]);assert.deepEqual(next.piResources,old.piResources);
  assert.equal(f.calls.length,0);
});
