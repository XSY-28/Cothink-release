import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fixture } from "./helpers/pi-fixture.js";
import { invoke } from "./helpers/cli-fixture.js";
import { runTurn } from "../src/discussion.js";
import { readTask } from "../src/task.js";
import { createRuntime } from "../src/pi-runtime.js";
import { saveConfig } from "../src/config.js";
import { createTeamConfig, addTeam, selectTeam, resolveTeamConfig, readSessionTeam } from "../src/teams.js";

const a = "7c8094cd-3476-4bfa-8f53-055d87972896";
const b = "7d51ceaf-2b56-4c1d-a34f-dd51da8b36c5";
test("tasks freeze the full team, keep only one reviewer and do not expose names to models", async (t) => {
  const f=await fixture(t);
  const c=createTeamConfig({formatVersion:2,...f.models},"PRIVATE_TEAM_LABEL",a);
  const effective=resolveTeamConfig(c);
  const task=await runTurn({home:f.home,cwd:f.cwd,input:"question",config:effective});
  assert.equal(task.record.status,"completed",task.record.error);
  assert.equal(task.record.team.name,"PRIVATE_TEAM_LABEL");
  assert.equal(task.record.team.secondary.length,3);
  assert.equal(task.record.models.secondary.length,1);
  assert.deepEqual(f.calls.map(x=>x.body.model),["main","r1","main"]);
  assert.doesNotMatch(JSON.stringify(f.calls),/PRIVATE_TEAM_LABEL/);
  effective.team.name="changed";
  assert.equal(readTask(f.home,task.record.id).team.name,"PRIVATE_TEAM_LABEL");
  const raw=readFileSync(task.record.stages[0].sessionFile,"utf8");
  assert.match(raw,/cothink-team/);
  const one=await runTurn({home:f.home,cwd:f.cwd,input:"/one solo",config:resolveTeamConfig(c)});
  assert.equal(one.record.team.secondary.length,3);
  assert.equal(one.record.models.secondary.length,0);
  assert.equal(f.calls.length,4);
});
test("v3 CLI/pipe/JSON use the default team and freeze effective overrides",async(t)=>{
  const f=await fixture(t);let c=createTeamConfig({formatVersion:2,...f.models},"A",a);
  c=addTeam(c,{id:b,name:"B",main:f.models.secondary[0],secondary:[f.models.main]});
  saveConfig(f.home,selectTeam(c,b));
  const answer=await invoke(f,["ask","--json","--max-output-tokens","321","question"]);
  assert.equal(answer.code,0,answer.stderr);
  const result=JSON.parse(answer.stdout);
  assert.equal(result.task.team.id,b);
  assert.equal(result.task.team.main.maxOutputTokens,321);
  assert.deepEqual(f.calls.map(x=>x.body.model),["r1","main","r1"]);
  assert.equal(JSON.parse(readFileSync(join(f.home,"config.json"))).teams[1].main.maxOutputTokens,undefined);
  const history=await invoke(f,["show",result.task.id,"--all"]);
  assert.match(history.stdout,/team.*B/);
  assert.equal(f.calls.length,3);
});
test("branch snapshots are durable only with conversation and fork from the selected ancestry",async(t)=>{
  const f=await fixture(t);const c=createTeamConfig({formatVersion:2,...f.models},"A",a);
  const manager=SessionManager.create(f.cwd,join(f.home,"pi","sessions","main"));
  manager.appendCustomEntry("cothink-team",{team:c.teams[0]});
  const {existsSync}=await import("node:fs");
  assert.equal(existsSync(manager.getSessionFile()),false);
  manager.appendMessage({role:"user",content:"saved user",timestamp:Date.now()});
  const origin=manager.getLeafId();
  const second={...c.teams[0],id:b,name:"B"};
  manager.appendCustomEntry("cothink-team",{team:second});
  const opened=SessionManager.open(manager.getSessionFile());
  assert.equal(readSessionTeam(opened.getBranch()).id,b);
  opened.branch(origin);
  assert.equal(readSessionTeam(opened.getBranch()).id,a);
  assert.equal(f.calls.length,0);
});


test("team lifecycle and recovery through actual CLI/PTY", () => {
  execFileSync("python3", [new URL("./helpers/pi_team_checks.py", import.meta.url).pathname], {
    env: process.env, stdio: "pipe", timeout: 60000,
  });
});
