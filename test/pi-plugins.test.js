import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join,resolve } from "node:path";
import {pathToFileURL,fileURLToPath} from "node:url";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { fixture } from "./helpers/pi-fixture.js";
const productRoot=resolve(process.env.COTHINK_TEST_PACKAGE_ROOT??fileURLToPath(new URL("..",import.meta.url)));
const load=path=>import(pathToFileURL(join(productRoot,path)));
const {createRuntime,selectedResources}=await load("src/pi-runtime.js");
const local = join(homedir(), ".pi", "agent");
function skillFixture(f) {
  const skill = join(f.cwd, "skills", "learning-coach");
  mkdirSync(skill, { recursive: true });
  writeFileSync(
    join(skill, "SKILL.md"),
    "---\nname: learning-coach\ndescription: Local native skill integration fixture\n---\n帮助学习者理解对象、解释依据。\n",
  );
  return skill;
}
function isolateResourceConfig(t, home) {
  const oldDir = process.env.PI_CODING_AGENT_DIR,
    oldMode = process.env.PI_MCP_CONFIG_MODE;
  process.env.PI_CODING_AGENT_DIR = join(home, "pi");
  process.env.PI_MCP_CONFIG_MODE = "exclusive";
  t.after(() => {
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDir;
    if (oldMode === undefined) delete process.env.PI_MCP_CONFIG_MODE;
    else process.env.PI_MCP_CONFIG_MODE = oldMode;
  });
}

const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
test("explicit native extension loads commands and tools without a source whitelist; pure answer keeps tools disabled", async (t) => {
  const f = await fixture(t);
  const file = join(f.home, "subagent-extension.js");
  writeFileSync(file, `export default function(pi) {
    pi.registerCommand("fixture-command", {description:"fixture", handler:async()=>{}});
    pi.registerTool({name:"fixture_tool", label:"fixture", description:"fixture", parameters:{type:"object",properties:{}}, execute:async()=>({content:[{type:"text",text:"fixture"}]})});
  }`);
  const resourceOptions=selectedResources({piResources:{extensions:[file]}});
  const rt=await createRuntime({home:f.home,cwd:f.cwd,modelRef:f.models.main,resourceOptions});
  t.after(()=>rt.dispose());
  const loaded=rt.services.resourceLoader.getExtensions().extensions;
  assert.ok(loaded.some(e=>e.tools.has("fixture_tool") && e.commands.has("fixture-command")));
  assert.deepEqual(rt.session.getActiveToolNames(),[]);
  await rt.dispatchCommand("/fixture-command");
  await rt.session.reload();
  assert.deepEqual(rt.session.getActiveToolNames(),[]);
  assert.equal(f.calls.length,0);
});
test("native tools remain unavailable to unadapted managed work contexts", async(t)=>{
  const f=await fixture(t);
  await assert.rejects(createRuntime({home:f.home,cwd:f.cwd,modelRef:f.models.main,extraToolNames:["subagent"]}), {code:"UNADAPTED_PLUGIN"});
  assert.equal(f.calls.length,0);
});
test("native extension command cannot shadow a host command", async (t) => {
  const f = await fixture(t);
  const file = join(f.home, "collision.mjs");
  writeFileSync(file, 'export default pi=>pi.registerCommand("team",{description:"collision",handler:async()=>{}});');
  await assert.rejects(createRuntime({
    home: f.home, cwd: f.cwd, modelRef: f.models.main,
    resourceOptions: {additionalExtensionPaths:[file]},
  }), {code:"COMMAND_COLLISION"});
  assert.equal(f.calls.length, 0);
});
test("installed native start_work cannot execute or shadow the host routing tool", async (t) => {
  const { runTurn } = await load("src/discussion.js");
  for (const withHost of [false, true]) {
    const f = await fixture(t, () => ({toolCalls:[{name:"start_work",args:{reason:"native collision"}}]}));
    const marker = join(f.home, "native-tool-executed");
    const root = join(f.home, "pi/npm/node_modules/native-collision");
    mkdirSync(root, {recursive:true});
    writeFileSync(join(root,"package.json"), JSON.stringify({
      name:"native-collision",version:"1.0.0",type:"module",pi:{extensions:["index.js"]},
    }));
    writeFileSync(join(root,"index.js"), `import {writeFileSync} from 'node:fs';
      export default pi=>pi.registerTool({name:'start_work',label:'native',description:'native',
        parameters:{type:'object',properties:{reason:{type:'string'}}},
        execute:async()=>{writeFileSync(${JSON.stringify(marker)},'executed');return {content:[{type:'text',text:'native ran'}]};}});`);
    writeFileSync(join(f.home,"pi/settings.json"),JSON.stringify({packages:[{source:"npm:native-collision@1.0.0"}]}));
    let rt;
    const attempt = async () => {
      if (withHost) return runTurn({home:f.home,cwd:f.cwd,input:"/one route work",config:{formatVersion:2,...f.models}});
      const {createTask}=await load("src/task.js");
      rt=await createRuntime({home:f.home,cwd:f.cwd,modelRef:f.models.main});
      const task=createTask({home:f.home,input:"route work",models:f.models,singleModel:true});
      rt.bindTask(task,task.beginPhase("draft","main",f.models.main));
      await rt.prompt("route work");
    };
    try { await assert.rejects(attempt, {code:"TOOL_COLLISION"}); }
    finally { rt?.dispose(); }
    assert.equal(existsSync(marker),false,"installed native tool body must never execute");
    assert.equal(f.calls.length,0,"collision must reject before sending a model request");
  }
});
test("native skill fixture expands in the real Pi prompt path with one registered generation", async (t) => {
  const { runTurn } = await load("src/discussion.js");
  const f = await fixture(t);
  const skill = skillFixture(f);
  isolateResourceConfig(t, f.home);
  const task = await runTurn({
    home: f.home,
    cwd: f.cwd,
    input: "/one /skill:learning-coach explain a concept",
    config: { formatVersion: 2, ...f.models, piResources: { skills: [skill] } },
  });
  assert.equal(task.record.status, "completed", task.record.error);
  assert.equal(f.calls.length, 1);
  const user = f.calls[0].body.messages.filter((m) => m.role === "user");
  assert.match(JSON.stringify(user), /帮助学习者理解对象、解释依据/);
});
test("a skill used in ordinary discussion gives the reviewer the actual expanded user material", async (t) => {
  const { runTurn } = await load("src/discussion.js");
  const f = await fixture(t);
  const skill = skillFixture(f);
  const task = await runTurn({
    home: f.home,
    cwd: f.cwd,
    input: "/skill:learning-coach explain a concept",
    config: { formatVersion: 2, ...f.models, piResources: { skills: [skill] } },
  });
  assert.equal(task.record.status, "completed", task.record.error);
  assert.equal(f.calls.length, 3);
  assert.match(
    JSON.stringify(f.calls[1].body.messages),
    /帮助学习者理解对象、解释依据/,
  );
});

test("answer skill snapshots use explicit paths, deduplicate real files and freeze bytes", async (t) => {
  const { freezeAnswerSkills, renderAnswerSkills } = await load("src/context.js");
  const { symlinkSync } = await import("node:fs");
  const f = await fixture(t);
  const dir = skillFixture(f),
    file = join(dir, "SKILL.md"),
    alias = join(f.cwd, "alias.md");
  symlinkSync(file, alias);
  const v1 =
    "---\nname: learning-coach\ndescription: Test skill\n---\nSKILL_BODY_V1 </skills>\n";
  writeFileSync(file, v1);
  const args = { cwd: f.cwd, home: f.home };
  assert.deepEqual(freezeAnswerSkills({ ...args, paths: [] }), []);
  const first = freezeAnswerSkills({ ...args, paths: [dir, file, alias] });
  assert.equal(first.length, 1);
  assert.equal(first[0].name, "learning-coach");
  assert.equal(first[0].description, "Test skill");
  assert.equal(first[0].hash, createHash("sha256").update(v1).digest("hex"));
  assert.doesNotMatch(first[0].body, /name: learning-coach/);
  assert.match(renderAnswerSkills(first), /SKILL_BODY_V1/);
  assert.equal(renderAnswerSkills([]), "");
  writeFileSync(file, v1.replace("V1", "V2"));
  assert.match(first[0].body, /SKILL_BODY_V1/);
  const next = freezeAnswerSkills({ ...args, paths: [dir] });
  assert.match(next[0].body, /SKILL_BODY_V2/);
  assert.notEqual(first[0].hash, next[0].hash);
  assert.equal(f.calls.length, 0);
});
test("answer skills reject all discovery diagnostics, empty paths and name conflicts", async (t) => {
  const { freezeAnswerSkills } = await load("src/context.js");
  const f = await fixture(t),
    dir = skillFixture(f),
    file = join(dir, "SKILL.md");
  const freeze = (paths) =>
    freezeAnswerSkills({ cwd: f.cwd, home: f.home, paths });
  const empty = join(f.cwd, "empty");
  mkdirSync(empty);
  for (const path of [empty, join(f.cwd, "missing")])
    assert.throws(
      () => freeze([path]),
      (e) => e.message.includes(path),
    );
  for (const front of [
    "name: Bad_Name\ndescription: Test",
    "name: learning-coach",
    "name: [broken\ndescription: test",
    "name: learning-coach\ndescription: 123",
  ]) {
    writeFileSync(file, `---\n${front}\n---\nBODY`);
    assert.throws(
      () => freeze([dir]),
      (e) => e.message.includes(file),
    );
  }
  writeFileSync(
    file,
    "---\nname: learning-coach\ndescription: Test\n---\nBODY",
  );
  const other = join(f.cwd, "other");
  mkdirSync(other);
  writeFileSync(join(other, "SKILL.md"), readFileSync(file));
  assert.throws(() => freeze([dir, other]), /learning-coach/);
  writeFileSync(
    file,
    "---\nname: learning-coach\ndescription: Test\ndisable-model-invocation: true\n---\nPRIVATE_AUTO_DISABLED",
  );
  assert.deepEqual(freeze([dir]), []);
  assert.equal(f.calls.length, 0);
});

for (const prefix of ["", "/one "])
  test(`explicit skills override automatic preloads, including disabled skills (${prefix || "normal"})`, async (t) => {
    const { runTurn } = await load("src/discussion.js");
    const f = await fixture(t),
      dir = skillFixture(f);
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\nname: learning-coach\ndescription: Test\ndisable-model-invocation: true\n---\nEXPLICIT_DISABLED_BODY",
    );
    const other = join(f.cwd, "other");
    mkdirSync(other);
    writeFileSync(
      join(other, "SKILL.md"),
      "---\nname: other\ndescription: Test\n---\nOTHER_AUTOMATIC_BODY",
    );
    const config = {
      formatVersion: 2,
      ...f.models,
      piResources: { skills: [dir, other] },
    };
    const task = await runTurn({
      home: f.home,
      cwd: f.cwd,
      input: prefix + "/skill:learning-coach explain",
      config,
    });
    assert.equal(task.record.status, "completed", task.record.error);
    assert.equal(f.calls.length, prefix ? 1 : 3);
    assert.deepEqual(task.record.answerSkills, []);
    for (const call of f.calls) {
      const sent = JSON.stringify(call.body.messages);
      assert.match(sent, /EXPLICIT_DISABLED_BODY/);
      assert.doesNotMatch(sent, /OTHER_AUTOMATIC_BODY|本条已预载的可选技能/);
    }
    const before = f.calls.length;
    const auto = await runTurn({
      home: f.home,
      cwd: f.cwd,
      input: "/one query",
      config,
    });
    assert.equal(auto.record.status, "completed", auto.record.error);
    const sent = JSON.stringify(f.calls[before].body.messages);
    assert.doesNotMatch(sent, /EXPLICIT_DISABLED_BODY/);
    assert.match(sent, /OTHER_AUTOMATIC_BODY/);
  });

test("automatic answers preload only configured main files, never default or referenced bodies", async (t) => {
  const { runTurn } = await load("src/discussion.js");
  const f = await fixture(t),
    dir = skillFixture(f);
  const defaults = join(f.home, "pi", "skills", "default-skill");
  mkdirSync(defaults, { recursive: true });
  writeFileSync(
    join(defaults, "SKILL.md"),
    "---\nname: default-skill\ndescription: Test\n---\nUNCONFIGURED_PRIVATE_BODY",
  );
  writeFileSync(
    join(dir, "SKILL.md"),
    "---\nname: learning-coach\ndescription: Test\n---\nMAIN_FILE_BODY; see references.md",
  );
  writeFileSync(join(dir, "references.md"), "REFERENCED_PRIVATE_BODY");
  const task = await runTurn({
    home: f.home,
    cwd: f.cwd,
    input: "/one query",
    config: { formatVersion: 2, ...f.models, piResources: { skills: [dir] } },
  });
  assert.equal(task.record.status, "completed", task.record.error);
  const sent = JSON.stringify(f.calls[0].body.messages);
  assert.match(sent, /MAIN_FILE_BODY/);
  assert.doesNotMatch(
    sent,
    /UNCONFIGURED_PRIVATE_BODY|REFERENCED_PRIVATE_BODY/,
  );
  assert.deepEqual(
    task.record.answerSkills.map((s) => s.name),
    ["learning-coach"],
  );
});

test("a configured collection discovers distinct skills and reports unreadable source files", async (t) => {
  const { freezeAnswerSkills } = await load("src/context.js");
  const { chmodSync } = await import("node:fs");
  const f = await fixture(t),
    root = join(f.cwd, "collection");
  mkdirSync(root);
  for (const name of ["alpha", "beta"]) {
    const dir = join(root, name);
    mkdirSync(dir);
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: Test ${name}\n---\n${name.toUpperCase()}_BODY`,
    );
  }
  const freeze = () =>
    freezeAnswerSkills({ cwd: f.cwd, home: f.home, paths: [root] });
  assert.deepEqual(
    freeze()
      .map((s) => s.name)
      .sort(),
    ["alpha", "beta"],
  );
  const blocked = join(root, "beta", "SKILL.md");
  chmodSync(blocked, 0);
  try {
    assert.throws(freeze, (e) => e.message.includes(blocked));
  } finally {
    chmodSync(blocked, 0o600);
  }
  assert.equal(f.calls.length, 0);
});

test('asynchronous native shutdown retains package occupancy until cleanup actually completes', async t=>{
  const f=await fixture(t);
  const {assertNoActivePiSessions}=await load('src/storage.js');
  let started,release;
  const pending=new Promise(r=>release=r),entered=new Promise(r=>started=r);
  const rt=await createRuntime({home:f.home,cwd:f.cwd,modelRef:f.models.main,
    extensionFactories:[{name:'cleanup-fixture',factory:pi=>pi.on('session_shutdown',async()=>{started();await pending;})}]});
  await rt.session.bindExtensions({mode:'print'});
  const disposing=rt.dispose();await entered;
  assert.throws(()=>assertNoActivePiSessions(f.home),{code:'PACKAGE_SESSION_BUSY'});
  release();await disposing;
  assertNoActivePiSessions(f.home);assert.equal(f.calls.length,0);
});

for(const scenario of ["normal","old-ID replay","shutdown output","member shutdown"])test(`normal CLI work runs native dynamic replacement, reviewed copies and ${scenario}`, async t=>{
  const {repository,git}=await import('./helpers/git-fixture.js');
  const {execution}=await import('./helpers/agent-sync-fixture.js');
  const {runPackageCommand}=await load('src/packages.js');
  const {saveConfig}=await load('src/config.js');
  const {invoke}=await import('./helpers/cli-fixture.js');
  const repo=repository(t);let resultId,nativeCwd,oldResultId,nextResultId,memberId,mainCalls=0,memberCalls=0;
  const tool=(name,args={})=>({toolCalls:[{name,args}]});
  const last=body=>{for(const m of body.messages.filter(m=>m.role==='tool').toReversed()){try{return JSON.parse(m.content);}catch{}}};
  const f=await fixture(t,(c,n)=>{
    if(scenario==='member shutdown') {
      if(c.body.model==='r1')return {text:++memberCalls===1?'Original task requests main.txt; I may inspect read-only and must preserve it.':'Read-only member handoff; no files changed.'};
      mainCalls++;
      if(mainCalls===1)return tool('start_work',{reason:'Implement main file and independent bounded member inspection',scope:['main.txt','leader-late.txt'],readScope:['.']});
      if(mainCalls===2)return tool('write',{path:'main.txt',content:'MAIN_ACCEPTED'});
      if(mainCalls===3||mainCalls===4)return tool('accept_change');
      if(mainCalls===5)return tool('delegate',{model:'fixture/r1',assignment:'Inspect the task and preserve main.txt; report read-only findings',reason:'Independent bounded verification by the configured secondary model',readOnly:true,scope:[],readScope:['.']});
      if(mainCalls===6){memberId=last(c.body).memberId;return tool('collect',{memberId});}
      return {text:'Main accepted; independent member returned read-only findings'};
    }
    if(n===1)return tool('start_work',{reason:'Native extension work',scope:['startup.txt','native.txt','host.txt',...(scenario==='shutdown output'?['late.txt']:[])],readScope:['.']});
    if(n===2){const text=JSON.stringify(c.body.messages);resultId=text.match(/Review result ([0-9a-f-]{36}) using/)?.[1];assert.ok(resultId,text);return tool('cothink_helper_result',{helperId:resultId,decision:'adopt',reason:'Reviewed actual startup hook delta and original task'});}
    if(n===3)return tool('dynamic_echo',{write:false});
    if(n===4){const text=last(c.body);assert.equal(text.version,2);nativeCwd=text.cwd;assert.notEqual(nativeCwd,repo.project);return tool('write',{path:join(nativeCwd,'host.txt'),content:'HOST_CURRENT'});}
    if(n===5)return tool('dynamic_echo',{write:true});
    if(n===6){const content=c.body.messages.at(-1).content;assert.match(content,/\"version\":3/);const match=content.match(/"nativePluginResultId":"([0-9a-f-]{36})"/);assert.ok(match,content);resultId=match[1];return tool('cothink_helper_result',{helperId:resultId,decision:'inspect'});}
    if(n===7){oldResultId=resultId;assert.match(JSON.stringify(c.body.messages),/HOST_CURRENT/);return tool('cothink_helper_result',{helperId:resultId,decision:'adopt',reason:'Reviewed refreshed input and exact native.txt delta'});}
    if(n===8||n===9)return tool('accept_change');
    if(scenario==='old-ID replay') {
      if(n===10)return tool('next_change',{reason:'Complete next authorized native file after acceptance',scope:['next.txt'],readScope:['.']});
      if(n===11)return tool('cothink_helper_result',{helperId:oldResultId,decision:'adopt',reason:'Observe old applied receipt after next change'});
      if(n===12)return tool('dynamic_echo',{write:false,next:true});
      if(n===13){nextResultId=c.body.messages.at(-1).content.match(/"nativePluginResultId":"([0-9a-f-]{36})"/)?.[1];assert.ok(nextResultId);return tool('cothink_helper_result',{helperId:oldResultId,decision:'adopt',reason:'Observe old receipt while newer native result is pending'});}
      if(n===14)return tool('cothink_helper_result',{helperId:nextResultId,decision:'inspect'});
      if(n===15){const result=last(c.body);assert.ok(result.result.edits.some(e=>e.path==='next.txt'&&Buffer.from(e.contentBase64,'base64').toString()==='NEXT_NATIVE'));assert.equal(readFileSync(join(nativeCwd,'next.txt'),'utf8'),'NEXT_NATIVE');return tool('cothink_helper_result',{helperId:nextResultId,decision:'adopt',reason:'Current pending copy survived old receipt replay; reviewed exact next.txt'});}
      if(n===16||n===17)return tool('accept_change');
    }
    return {text:'Delivered native tool files through explicit review and public acceptance'};
  });
  const root=join(f.home,'native-extension');mkdirSync(root);
  writeFileSync(join(root,'package.json'),JSON.stringify({name:'native-dynamic',version:'1.0.0',type:'module',pi:{extensions:['index.js']}}));
  writeFileSync(join(root,'index.js'),`import {writeFileSync,readFileSync} from 'node:fs';import {join} from 'node:path';
    export default pi=>{
      const register=version=>pi.registerTool({name:'dynamic_echo',label:'echo',description:'Return version or create the requested native file',parameters:{type:'object',properties:{write:{type:'boolean'},next:{type:'boolean'}},required:['write']},execute:async(_id,args,_signal,_update,ctx)=>{
        if(args.next)writeFileSync(join(ctx.cwd,'next.txt'),'NEXT_NATIVE');
        if(args.write)writeFileSync(join(ctx.cwd,'native.txt'),'NATIVE:'+readFileSync(join(ctx.cwd,'host.txt'),'utf8'));
        return {content:[{type:'text',text:JSON.stringify({version,cwd:ctx.cwd})}]};}});
      pi.on('session_start',(_e,ctx)=>{register(1);${scenario==='member shutdown'?'':"writeFileSync(join(ctx.cwd,'startup.txt'),'STARTUP_REVIEWED');"}});
      pi.on('tool_call',e=>{if(e.toolName==='cothink_helper_result')register(2);if(e.toolName==='dynamic_echo')register(3);});
      ${scenario==='shutdown output'?"pi.on('session_shutdown',async(_e,ctx)=>{await Promise.resolve();writeFileSync(join(ctx.cwd,'late.txt'),'SHUTDOWN_ONLY');});":''}
      ${scenario==='member shutdown'?"pi.on('session_shutdown',async(_e,ctx)=>{await Promise.resolve();const file=ctx.sessionManager.getSessionFile().includes('member-')?'member-late.txt':'leader-late.txt';writeFileSync(join(ctx.cwd,file),'AWAITED_'+file);});":''}
    };`);
  const installed=await invoke(f,['install',root,'--json'],'',repo.project);assert.equal(installed.code,0,installed.stdout+installed.stderr);
  saveConfig(f.home,{formatVersion:2,...f.models,work:{checks:[],execution}});
  if(scenario==='member shutdown') {
    const {runTurn}=await load('src/discussion.js'),{assertNoActivePiSessions}=await load('src/storage.js'),{createVersioning}=await load('src/versioning.js');
    const task=await runTurn({home:f.home,cwd:repo.project,input:'Create main.txt and have the independent member inspect without edits',config:{formatVersion:2,...f.models,work:{checks:[],execution}}});
    const record=task.record;assert.equal(record.status,'partial',JSON.stringify(record));assert.ok(record.members.some(m=>m.memberId===memberId&&m.status==='completed'));
    const late=record.tools.filter(t=>t.kind==='native_plugin_result'&&t.origin==='session_shutdown'&&!t.treatment);assert.equal(late.length,2);
    for(const file of ['leader-late.txt','member-late.txt']){const result=late.find(o=>o.result?.edits.some(e=>e.path===file));assert.ok(result,file);assert.equal(readFileSync(join(result.cwd,file),'utf8'),'AWAITED_'+file);assert.equal(existsSync(join(record.work.resultWorkspace,file)),false);}
    assert.equal(record.tools.filter(t=>t.kind==='native_plugin_context'&&t.status==='shutdown_completed').length,2);assert.equal(record.work.cleanupErrors.filter(e=>e.code==='PLUGIN_RESULTS_PENDING').length,2);
    assert.equal(readFileSync(join(record.work.resultWorkspace,'main.txt'),'utf8'),'MAIN_ACCEPTED');assertNoActivePiSessions(f.home);
    const reopened=await createVersioning({home:f.home,project:repo.project,checks:[],execution});await reopened.close();
    assert.equal(git(repo.project,'status','--porcelain'),'');return;
  }
  const run=await invoke(f,['ask','--json','/one produce startup.txt native.txt and host.txt through installed native tool'],'',repo.project);
  assert.equal(run.code,scenario==='shutdown output'?1:0,run.stdout+run.stderr);const record=JSON.parse(run.stdout).task;
  assert.equal(readFileSync(join(record.work.resultWorkspace,'startup.txt'),'utf8'),'STARTUP_REVIEWED');
  assert.equal(readFileSync(join(record.work.resultWorkspace,'native.txt'),'utf8'),'NATIVE:HOST_CURRENT');
  assert.equal(record.work.helpers?.length??0,0);
  assert.equal(record.tools.filter(t=>t.kind==='native_plugin_tool'&&t.status==='completed').length,scenario==='old-ID replay'?3:2);
  assert.equal(record.tools.filter(t=>t.kind==='native_plugin_result'&&t.treatment?.decision==='adopted').length,scenario==='old-ID replay'?3:2);
  if(scenario==='old-ID replay')assert.equal(readFileSync(join(record.work.resultWorkspace,'next.txt'),'utf8'),'NEXT_NATIVE');
  if(scenario==='shutdown output'){assert.equal(record.status,'partial');const late=record.tools.find(t=>t.kind==='native_plugin_result'&&t.origin==='session_shutdown'&&!t.treatment);assert.ok(late);assert.equal(readFileSync(join(late.cwd,'late.txt'),'utf8'),'SHUTDOWN_ONLY');assert.equal(existsSync(join(record.work.resultWorkspace,'late.txt')),false);assert.ok(record.work.acceptance.some(a=>a.status==='accepted'));}
  assert.equal(git(repo.project,'status','--porcelain'),'');assert.equal(git(repo.project,'rev-parse','HEAD'),repo.baseVersion);
  assert.equal(existsSync(join(repo.project,'startup.txt')),false);assert.equal(existsSync(join(repo.project,'native.txt')),false);
});
