import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fixture } from "./helpers/pi-fixture.js";
import { loadConfig, saveConfig, updateConfig } from "../src/config.js";
import { acquireSessionWriter } from "../src/storage.js";
import {
  normalizeTeamName, validateTeam, validateTeamConfig, createTeamConfig,
  addTeam, removeTeam, selectTeam, snapshotTeam, resolveTeamConfig, readSessionTeam,
} from "../src/teams.js";

const a = "7c8094cd-3476-4bfa-8f53-055d87972896";
const b = "7d51ceaf-2b56-4c1d-a34f-dd51da8b36c5";
const legacy = () => ({ formatVersion: 2, main: { provider: "fixture", modelId: "main" }, secondary: [{ provider: "fixture", modelId: "r1", maxOutputTokens: 123 }] });
const config = () => createTeamConfig(legacy(), "日常", a);

test("team names preserve Chinese/emoji, normalize NFC and reject invalid names", () => {
  assert.equal(normalizeTeamName("  中文 🐱  "), "中文 🐱");
  assert.equal(normalizeTeamName("e\u0301"), "é");
  for (const name of [null, "", "  ", "a\nb", "a\u001bb", "x".repeat(81)])
    assert.throws(() => normalizeTeamName(name), /名称/);
});
test("team creation preserves settings/global configuration and validates membership", () => {
  const old = { ...legacy(), piResources: { skills: ["local"] }, work: { checks: [] } };
  const c = createTeamConfig(old, "日常", a);
  assert.equal(c.main, undefined); assert.equal(c.secondary, undefined);
  assert.deepEqual(c.piResources, old.piResources); assert.deepEqual(c.work, old.work);
  assert.deepEqual(c.teams[0].secondary, old.secondary);
  assert.throws(() => validateTeam({ ...c.teams[0], secondary: [] }), /至少/);
  assert.throws(() => validateTeam({ ...c.teams[0], secondary: [c.teams[0].main] }), /重复/);
  assert.throws(() => validateTeam({ ...c.teams[0], apiKey: "secret" }), /字段|凭据/);
  assert.throws(() => validateTeam({ ...c.teams[0], main: { ...c.teams[0].main, apiKey: "secret" } }), /凭据/);
  assert.doesNotThrow(() => validateTeam({ ...c.teams[0], secondary: [{ provider: "other", modelId: "main" }] }));
  assert.throws(() => addTeam(c, { ...c.teams[0], id: b, name: "日常" }), /重名|名称/);
  assert.throws(() => addTeam(c, { ...c.teams[0], name: "备选" }), /ID/);
  assert.deepEqual(old.main, legacy().main);
});
test("deletion allows 2→1, protects current/last and repairs the default", () => {
  const one = config(); const current = one.teams[0];
  const two = addTeam(one, { ...current, id: b, name: "备选" });
  const before = structuredClone(two);
  assert.throws(() => removeTeam(two, { targetId: a, currentTeam: current }), /当前/);
  const next = removeTeam(selectTeam(two, b), { targetId: b, currentTeam: current });
  assert.equal(next.teams.length, 1); assert.equal(next.lastUsedTeamId, a);
  assert.throws(() => removeTeam(next, { targetId: a, currentTeam: current }), /至少保留/);
  assert.throws(() => removeTeam(two, { targetId: "missing", currentTeam: current }), /不存在|已删除/);
  assert.deepEqual(two, before);
});
test("deleted snapshots stay usable and same-name recreation never reuses identity", () => {
  const two = addTeam(config(), { ...config().teams[0], id: b, name: "备选" });
  const detached = snapshotTeam(two.teams[1]);
  const next = removeTeam(two, { targetId: b, currentTeam: two.teams[0] });
  assert.equal(resolveTeamConfig(next, detached).team.id, b);
  assert.equal(next.teams.length, 1);
  assert.throws(() => selectTeam(next, b), /不存在|已删除/);
  const other = "72b8663f-a049-42ea-9695-d0632d639fee";
  const recreated = addTeam(next, { ...detached, id: other });
  assert.equal(recreated.teams[1].name, detached.name);
  assert.notEqual(recreated.teams[1].id, detached.id);
});
test("registry and branch snapshots reject damage without silently falling back", () => {
  const c = config();
  for (const bad of [{ ...c, teams: [] }, { ...c, lastUsedTeamId: b }, { ...c, main: c.teams[0].main }])
    assert.throws(() => validateTeamConfig(bad));
  const entries = [{ type: "custom", customType: "cothink-team", data: { team: c.teams[0] } }];
  const snapshot = readSessionTeam(entries); snapshot.main.modelId = "changed";
  assert.equal(entries[0].data.team.main.modelId, "main");
  assert.equal(readSessionTeam([]), null);
  assert.throws(() => readSessionTeam([...entries, { type: "custom", customType: "cothink-team", data: {} }]), /team|快照/);
  const effective = resolveTeamConfig(c);
  assert.equal(effective.formatVersion, 2); assert.equal(effective.teams, undefined);
  effective.main.modelId = "changed";
  assert.equal(c.teams[0].main.modelId, "main");
});
test("v3 config writes are atomic, preserve current bytes on rejected mutations and use a writer", async (t) => {
  const f = await fixture(t); saveConfig(f.home, config());
  const path = join(f.home, "config.json"), before = readFileSync(path, "utf8");
  assert.throws(() => updateConfig(f.home, () => { throw Error("injected"); }), /injected/);
  assert.equal(readFileSync(path, "utf8"), before);
  updateConfig(f.home, (c) => addTeam(c, { ...c.teams[0], id: b, name: "备选" }));
  assert.equal(loadConfig(f.home).teams.length, 2);
  const writer = acquireSessionWriter(join(f.home, "config-write"), "184df297-b389-43af-8635-e71dfac90f52");
  try { assert.throws(() => updateConfig(f.home, (c) => c), /其他实例|配置/); }
  finally { writer.release(); }
  updateConfig(f.home, (c) => removeTeam(c, { targetId: b, currentTeam: c.teams[0] }));
  assert.equal(loadConfig(f.home).teams.length, 1);
  assert.ok(!readdirSync(f.home).some((x) => x.endsWith(".tmp")));
  writeFileSync(path, "broken");
  assert.throws(() => updateConfig(f.home, () => config()), /JSON/);
  assert.equal(readFileSync(path, "utf8"), "broken");
});
test("independent config writers re-read the latest registry and recover dead writer claims", async (t) => {
  const f = await fixture(t); saveConfig(f.home, config());
  const script = `import { updateConfig } from './src/config.js'; import { addTeam } from './src/teams.js';
    updateConfig(process.argv[1], c => addTeam(c, {...c.teams[0], id:process.argv[2], name:process.argv[3]}));`;
  for (const [id, name] of [[b, "B"], ["72b8663f-a049-42ea-9695-d0632d639fee", "C"]]) {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script, f.home, id, name], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  }
  assert.deepEqual(loadConfig(f.home).teams.map((x) => x.name), ["日常", "B", "C"]);
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `import {acquireSessionWriter} from './src/storage.js'; import {join} from 'node:path'; acquireSessionWriter(join(process.argv[1],'config-write'),'184df297-b389-43af-8635-e71dfac90f52'); process.exit(0);`, f.home]);
  assert.equal(r.status, 0);
  assert.doesNotThrow(() => updateConfig(f.home, (c) => c));
});

test("simultaneous independent updates never discard a committed team", async(t) => {
  const {spawn}=await import('node:child_process');
  const f=await fixture(t);saveConfig(f.home,config());
  const gate=join(f.home,'start-writers');
  const program=`import{existsSync}from'node:fs';import{updateConfig}from'./src/config.js';import{addTeam}from'./src/teams.js';
    console.log('ready');await new Promise(resolve=>{const tick=setInterval(()=>{if(existsSync(process.argv[4])){clearInterval(tick);resolve();}},5);});
    try{updateConfig(process.argv[1],c=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);return addTeam(c,{...c.teams[0],id:process.argv[2],name:process.argv[3]});});process.exitCode=0;}
    catch(e){console.error(e.message);process.exitCode=2;}`;
  const children=[[b,'B'],['72b8663f-a049-42ea-9695-d0632d639fee','C']].map(([id,name])=>{
    const child=spawn(process.execPath,['--input-type=module','-e',program,f.home,id,name,gate],{stdio:['ignore','pipe','pipe']});
    let stderr='';child.stderr.on('data',data=>{stderr+=data;});
    const ready=new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);});
    const closed=new Promise(resolve=>child.once('close',code=>resolve({code,stderr,name})));
    return {child,ready,closed};
  });
  t.after(()=>children.forEach(({child})=>{if(child.exitCode===null)child.kill();}));
  await Promise.all(children.map(c=>c.ready));writeFileSync(gate,'go');
  const results=await Promise.all(children.map(c=>c.closed));
  const successes=results.filter(r=>r.code===0);
  assert.ok(successes.length>=1);
  for(const r of results.filter(r=>r.code!==0))assert.match(r.stderr,/配置正在被其他实例/);
  const saved=loadConfig(f.home);
  assert.equal(saved.teams.length,successes.length+1);
  for(const r of successes)assert.ok(saved.teams.some(t=>t.name===r.name));
});
