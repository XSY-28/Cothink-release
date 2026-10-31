import {readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/pi-fixture.js";
import { repository } from "./helpers/git-fixture.js";
import { invoke } from "./helpers/cli-fixture.js";
import { saveConfig } from "../src/config.js";
const tool = (name, args = {}) => ({ toolCalls: [{ name, args }] });
test("work ask/pipe/print/JSON/show/history use the same checked completion and zero-call queries", async (t) => {
  for (const args of [
    ["ask", "--json", "/one work"],
    ["--print"],
    ["ask", "/one work"],
  ]) {
    const repo = repository(t);
    const f = await fixture(t, (c, n) =>
      n === 1
        ? tool("start_work", { reason: "edit", scope: ["a.txt"] })
        : n === 2
          ? tool("read", { path: "a.txt" })
          : n === 3
            ? tool("edit", {
                path: "a.txt",
                edits: [{ oldText: "base A", newText: "done" }],
              })
            : n === 4
              ? tool("accept_change")
              : { text: "work final" },
    );
    saveConfig(f.home, { formatVersion: 2, ...f.models });
    const run = await invoke(
      f,
      args,
      args.includes("--print") ? "/one work" : "",
      repo.project,
    );
    assert.equal(run.code, 0, run.stderr);
    let id;
    if (args.includes("--json")) {
      const r = JSON.parse(run.stdout);
      assert.equal(r.taskEnd, "completed");
      assert.equal(r.requests.length, 5);
      id = r.task.id;
    } else {
      assert.match(run.stdout, /work final/);
      assert.match(run.stdout, /未验证/);
      id = JSON.parse((await invoke(f, ["history", "--json"])).stdout)[0].id;
    }
    const before = f.calls.length;
    const show = await invoke(f, ["show", id, "--all"]);
    assert.match(show.stdout, /Pi 工具原文/);
    assert.match(show.stdout, /candidateVersion|candidate/);
    const saved = JSON.parse((await invoke(f, ["show", id, "--json"])).stdout);
    assert.equal(saved.taskEnd, "completed");
    assert.equal(f.calls.length, before);
  }
});
test("failed work print/JSON return nonzero without presenting model assertion as final", async (t) => {
  const repo = repository(t);
  const f = await fixture(t, (c, n) =>
    n === 1
      ? tool("start_work", { reason: "edit" })
      : n === 2
        ? tool("write", { path: "a.txt", content: "unfinished" })
        : { text: "I finished all work" },
  );
  saveConfig(f.home, { formatVersion: 2, ...f.models });
  const r = await invoke(f, ["ask", "--json", "/one edit"], "", repo.project);
  assert.equal(r.code, 1);
  const saved = JSON.parse(r.stdout);
  assert.equal(saved.taskEnd, "partial");
  assert.equal(saved.task.finalCallId, null);
  assert.match(r.stderr, /未完成/);
});
test("CLI announces an explicit output cap and timeout that match the actual provider wire", async (t) => {
  const f = await fixture(t);
  saveConfig(f.home, { formatVersion: 2, ...f.models });
  const run = await invoke(f, [
    "ask",
    "--one",
    "--max-output-tokens",
    "99",
    "--timeout",
    "2000",
    "q",
  ]);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(
    f.calls[0].body.max_completion_tokens ?? f.calls[0].body.max_tokens,
    99,
  );
  assert.match(run.stderr, /输出额度 99 tokens/);
  assert.match(run.stderr, /模型超时 2000ms/);
  assert.equal(f.calls.length, 1);
});

test('check-update runs before invalid/legacy model configuration; pure JSON and failure exit codes', async t => {
  const {mkdtempSync,writeFileSync,readFileSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');
  const {join,resolve}=await import('node:path');
  const {spawnSync}=await import('node:child_process');
  const home=mkdtempSync(join(tmpdir(),'cothink-check-update-'));
  t.after(()=>rmSync(home,{recursive:true,force:true}));
  writeFileSync(join(home,'config.json'),'{ broken config');
  const log=join(home,'requests');
  const env={...process.env,COTHINK_HOME:home,COTHINK_NO_TTY:'1',PI_OFFLINE:'0',COTHINK_TEST_UPDATE_LOG:log};
  const run=(args,extra={})=>spawnSync(process.execPath,['--import',resolve('test/helpers/update-fetch.mjs'),resolve('bin/cothink.js'),...args],{env:{...env,...extra},encoding:'utf8',timeout:8000});
  const ok=run(['check-update','--json']);
  assert.equal(ok.status,0,ok.stderr);assert.equal(ok.stderr,'');
  assert.equal(JSON.parse(ok.stdout).status,'available');
  const failure=run(['check-update','--json'],{COTHINK_TEST_UPDATE_STATUS:'500'});
  assert.equal(failure.status,1);const s=JSON.parse(failure.stdout);
  assert.equal(s.status,'unavailable');assert.equal(s.stale,true);
  const before=readFileSync(log,'utf8');
  const offline=run(['check-update','--json'],{PI_OFFLINE:'1'});
  assert.equal(offline.status,1);assert.equal(JSON.parse(offline.stdout).status,'disabled');
  assert.equal(readFileSync(log,'utf8'),before);
  for(const args of [['--help'],['history','--json'],['check-update','--help']]) assert.equal(run(args).status,0);
  assert.equal(readFileSync(log,'utf8'),before);
});

test('valid ask and pipe/JSON entries never auto-check even with network enabled', async t=>{
  const f=await fixture(t);
  const {createTeamConfig}=await import('../src/teams.js');
  saveConfig(f.home,createTeamConfig({formatVersion:2,...f.models},'Fixture','7c8094cd-3476-4bfa-8f53-055d87972896'));
  const {spawn}=await import('node:child_process');
  const {resolve,join}=await import('node:path');
  const {existsSync}=await import('node:fs');
  const log=join(f.home,'update-requests');
  for(const [args,input] of [[['ask','--json','/one question'],''],[['--json'],'/one piped question']]) {
    const result=await new Promise((yes,no)=>{
      const c=spawn(process.execPath,['--import',resolve('test/helpers/update-fetch.mjs'),resolve('bin/cothink.js'),...args],{
        cwd:f.cwd,env:{...process.env,COTHINK_HOME:f.home,COTHINK_NO_TTY:'1',COTHINK_NO_UPDATE_CHECK:'0',PI_OFFLINE:'0',COTHINK_TEST_UPDATE_LOG:log},stdio:['pipe','pipe','pipe']});
      let out='',err='';c.stdout.on('data',x=>out+=x);c.stderr.on('data',x=>err+=x);c.once('error',no);c.once('close',code=>yes({code,out,err}));c.stdin.end(input);
    });
    assert.equal(result.code,0,result.err);assert.equal(JSON.parse(result.out).taskEnd,'completed');
    assert.equal(existsSync(log),false);assert.equal(existsSync(join(f.home,'update-state.json')),false);
  }
  assert.equal(f.calls.length,2);
});

test('make-html CLI pipe preserves multiline task bytes and uses the same ONE work and final-image gate',async t=>{
 const f=await fixture(t,(c,n)=>c.body.tools?.some(x=>x.function.name==='submit_visual_review')?tool('submit_visual_review',{verdict:'match',observation:'Blue heading',reasons:'Visible HTML matches the task'}):n===1?tool('write',{path:'index.html',content:'<h1>Blue</h1>'}):n===2?tool('accept_change'):{text:'HTML delivered'});
 const catalogPath=join(f.home,'pi/models.json'),catalog=JSON.parse(readFileSync(catalogPath));for(const m of catalog.providers.fixture.models)m.input=['text','image'];writeFileSync(catalogPath,JSON.stringify(catalog));
 const {execution}=await import('./helpers/agent-sync-fixture.js');
 saveConfig(f.home,{formatVersion:2,...f.models,piResources:{skills:[new URL('./fixtures/visual-skill/SKILL.md',import.meta.url).pathname]},work:{checks:[],execution:{...execution,image:JSON.parse(readFileSync(new URL('../docker/visual-preview-manifest.json',import.meta.url))).image}}});
 const repo=repository(t),input='  Make HTML\nQuoted commands: /one /make-html\n';const result=await invoke(f,['make-html','--one','--json'],input,repo.project);
 assert.equal(result.code,0,result.stderr);const saved=JSON.parse(result.stdout);assert.equal(saved.task.input,input);assert.equal(saved.task.mode,'work');assert.equal(saved.taskEnd,'completed');assert.equal(f.calls.length,4);assert.ok(saved.task.work.visualEvidence[0].imageRequestId);
});

test('actual TUI make-html inherits ONE, then the next plain turn remains ONE answer',async t=>{
 const f=await fixture(t,(c,n)=>c.body.tools?.some(x=>x.function.name==='submit_visual_review')?tool('submit_visual_review',{verdict:'match',observation:'Blue heading',reasons:'Visible HTML matches the task'}):n===1?tool('write',{path:'index.html',content:'<h1>Blue</h1>'}):n===2?tool('accept_change'):{text:'TUI delivered'});
 const path=join(f.home,'pi/models.json'),catalog=JSON.parse(readFileSync(path));for(const m of catalog.providers.fixture.models)m.input=['text','image'];writeFileSync(path,JSON.stringify(catalog));
 const {execution}=await import('./helpers/agent-sync-fixture.js');const {createTeamConfig}=await import('../src/teams.js');
 saveConfig(f.home,createTeamConfig({formatVersion:2,...f.models,piResources:{skills:[new URL('./fixtures/visual-skill/SKILL.md',import.meta.url).pathname]},work:{checks:[],execution:{...execution,image:JSON.parse(readFileSync(new URL('../docker/visual-preview-manifest.json',import.meta.url))).image}}},'Visual','7c8094cd-3476-4bfa-8f53-055d87972896'));
 const repo=repository(t);const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const result=await promisify(execFile)('python3',[new URL('./helpers/visual_pty.py',import.meta.url).pathname,f.home,repo.project,process.env.COTHINK_TEST_CLI??new URL('../bin/cothink.js',import.meta.url).pathname],{timeout:90000,maxBuffer:1024*1024});
 assert.equal(JSON.parse(result.stdout).secondMode,'answer');assert.equal(f.calls.length,5);assert.ok(f.calls.every(c=>c.body.model==='main'));
});
