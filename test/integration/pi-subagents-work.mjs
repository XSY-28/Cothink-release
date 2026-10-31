import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,writeFileSync,existsSync,unlinkSync } from 'node:fs';
import { join,resolve } from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import { fixture } from '../helpers/pi-fixture.js';
import { repository, git } from '../helpers/git-fixture.js';
import { invoke } from '../helpers/cli-fixture.js';
import {restorePinnedPlugin} from '../helpers/pi-plugin-fixture.js';
const productRoot=resolve(process.env.COTHINK_TEST_PACKAGE_ROOT??fileURLToPath(new URL('../..',import.meta.url)));
const load=path=>import(pathToFileURL(join(productRoot,path)));
const {saveConfig}=await load('src/config.js');
import { execution } from '../helpers/agent-sync-fixture.js';
const tool=(name,args={})=>({toolCalls:[{name,args}]});
function last(body){for(const m of body.messages.filter(m=>m.role==='tool').toReversed()){try{return JSON.parse(m.content);}catch{}}}
for(const entry of ['CLI','GUI'])test(`normal ONE ${entry} work uses real plugin helper then creator review and kernel acceptance`, {timeout:60000}, async t=>{
 const repo=repository(t);let helperId;
 const checks=[{command:'node',args:['-e',"if(require('fs').readFileSync('new.txt','utf8')!=='HELPER_FILE')process.exit(1);console.log('checked real plugin output')"]}];
 const f=await fixture(t,(c,n)=>{
  console.log('localhost request',n,c.body.messages.at(-1)?.role,c.body.tools?.map(x=>x.function?.name));
  if(n===1)return tool('start_work',{reason:'Use installed helper',scope:['new.txt'],readScope:['.']});
  if(n===2)return tool('cothink_helper',{assignment:'Write new.txt containing HELPER_FILE then return evidence'});
  if(n===3)return {toolCalls:[{name:'write',args:{path:'new.txt',content:'HELPER_FILE'}},{name:'write',args:{path:join(repo.project,'a.txt'),content:'FORBIDDEN_ORIGINAL_WRITE'}},{name:'write',args:{path:'b.txt',content:'FORBIDDEN_SCOPE_WRITE'}},{name:'subagent',args:{agent:'delegate',task:'Bypass managed routing'}}]};
  if(n===4){assert.match(JSON.stringify(c.body.messages),/HELPER_PATH/);assert.match(JSON.stringify(c.body.messages),/SCOPE/);return {text:'Helper wrote authorized new.txt; escape/out-of-scope/native bypass calls were rejected'};}
  if(n===5){helperId=last(c.body).helperId;return tool('cothink_helper_result',{helperId,decision:'adopt',reason:'Checked task and exact actual new.txt diff'});}
  if(n===6||n===7)return tool('accept_change');
  return {text:'Delivered actual helper file via existing formal acceptance'};
 });
 const installed=await invoke(f,['install','npm:pi-subagents@0.84.0','--json']);assert.equal(installed.code,0,installed.stderr+installed.stdout);
 const patch=JSON.parse(readFileSync(new URL('../../vendor/pi-patches/pi-subagents-0.84.0-foreground-unlimited-v1.json',import.meta.url)));
 const plugin=join(f.home,'pi/npm/node_modules/pi-subagents');
 // Reconstruct exact registered upstream bytes to represent a genuine pre-patch same-version installation.
 restorePinnedPlugin(f,plugin,patch);
 const migration=await invoke(f,['install','npm:pi-subagents@0.84.0','--json']);assert.equal(migration.code,0,migration.stdout+migration.stderr);
 assert.equal(JSON.parse(readFileSync(join(plugin,'cothink-compatibility.json'))).revision,patch.revision);
 const projectInstall=await invoke(f,['install','npm:pi-subagents@0.84.0','--local','--json'],'',repo.project);assert.equal(projectInstall.code,0,projectInstall.stdout+projectInstall.stderr);
 const originalStatus=git(repo.project,'status','--porcelain');
 saveConfig(f.home,{formatVersion:2,...f.models,work:{checks,execution}});
 let run;
 if(entry==='CLI')run=await invoke(f,['ask','--json','/one create new.txt with installed helper'],'',repo.project);
 else {
  const {createTeamConfig}=await load('src/teams.js');const {createGuiController}=await load('src/gui-controller.js');const {readTask}=await load('src/task.js');
  saveConfig(f.home,createTeamConfig({formatVersion:2,...f.models,work:{checks,execution}},'GUI pinned plugin','7c8094cd-3476-4bfa-8f53-055d87972896'));
  const controller=await createGuiController({home:f.home,cwd:repo.project});t.after(()=>controller.close());
  const session=await controller.action('session.create',{project:repo.project});await controller.action('session.mode',{sessionId:session.id,mode:'one'});
  const submitted=await controller.action('task.submit',{sessionId:session.id,input:'create new.txt with installed helper',submissionId:'pinned-gui'});
  let final;for(let n=0;n<1500;n++){final=await controller.task(submitted.taskId);if(final.status!=='running')break;await new Promise(r=>setTimeout(r,10));}
  const ui=(await controller.bootstrap()).extensionUI;assert.equal(ui.prompts.length,0);
  run={code:final.status==='completed'?0:1,stdout:JSON.stringify({task:readTask(f.home,submitted.taskId)}),stderr:final.error??''};
  await controller.close();
 }
 if(run.code)console.log('CLI failure',run.stderr);
 assert.equal(run.code,0,run.stdout+run.stderr);
 const result=JSON.parse(run.stdout),record=result.task??result;
 console.log('helper facts',JSON.stringify(record.work.helpers.map(h=>({id:h.helperId,status:h.status,exit:h.exit,edits:h.result?.edits?.length,error:h.error,stderr:existsSync(join(h.directory,'stderr.log'))?readFileSync(join(h.directory,'stderr.log'),'utf8'):null}))));
 assert.equal(record.work.helpers[0].result.edits.length,1);
 assert.equal(record.work.acceptance.at(-1)?.status,'accepted');
 assert.equal(record.work.finalCheck.verification,'passed');
 assert.equal(record.work.finalCheck.checks[0].exitCode,0);
 assert.equal(readFileSync(join(record.work.resultWorkspace,'new.txt'),'utf8'),'HELPER_FILE');
 assert.equal(git(repo.project,'status','--porcelain'),originalStatus);assert.equal(git(repo.project,'rev-parse','HEAD'),repo.baseVersion);assert.equal(existsSync(join(repo.project,'new.txt')),false);
 assert.equal(f.calls.length,8);
 assert.ok(f.calls.every(c=>!('max_tokens' in c.body)&&!('max_completion_tokens' in c.body)), 'no optional output cap is silently sent');
 const {createTask}=await load('src/task.js');const {createPluginWork}=await load('src/plugin-work.js');
 const disabled=createTask({home:f.home,input:'disabled plugin resource',models:f.models,workRequest:{}});disabled.record.work={};
 disabled.packageSnapshot={packages:[{name:'pi-subagents',version:'0.84.0'}],extensions:[]};
 assert.deepEqual((await createPluginWork({task:disabled,versioning:null,execution})).tools({}),[]);
 disabled.packageSnapshot={packages:[],extensions:[join(f.home,'pi/npm/node_modules/pi-subagents/bundle/index.js')]};
 assert.deepEqual((await createPluginWork({task:disabled,versioning:null,execution})).tools({}),[]);disabled.finish('completed');
});

test('real child and grandchild keep separate copies and creator treatment, use selected skill reference and Docker script', {timeout:60000}, async t=>{
 const repo=repository(t);let nestedId,topId;
 const f=await fixture(t,(c,n)=>{
  if(n===1)return tool('start_work',{reason:'Nested actual skill work',scope:['new.txt','creator.txt','binary.bin','a.txt','b.txt'],readScope:['.']});
  if(n===2)return tool('cothink_helper',{assignment:'Write creator.txt then use a nested helper to read it and selected skill reference, run its script, review actual result'});
  if(n===3)return tool('write',{path:'creator.txt',content:'CURRENT_CREATOR_OVERLAY'});
  if(n===4)return tool('cothink_helper',{assignment:'Read creator.txt from creator current copy, selected fixture-skill reference, then run its script to create new.txt'});
  if(n===5)return tool('read',{path:'creator.txt'});
  if(n===6){assert.match(JSON.stringify(c.body.messages),/CURRENT_CREATOR_OVERLAY/);const system=c.body.messages.find(m=>m.role==='system')?.content??'';const path=system.match(/Task resources: ([^\n]+)/)?.[1];assert.ok(path,system);return tool('read',{path:join(path,'fixture-skill/references/instruction.txt')});}
  if(n===7){assert.match(JSON.stringify(c.body.messages),/ACTUAL_SKILL_REFERENCE/);return tool('helper_exec',{command:'node /resources/fixture-skill/scripts/make.cjs'});}
  if(n===8){assert.match(JSON.stringify(c.body.messages),/completed/);return {text:'Nested helper observed current creator overlay and executed frozen skill script'};}
  if(n===9){nestedId=last(c.body).helperId;return tool('cothink_helper_result',{helperId:nestedId,decision:'adopt',reason:'Original task and exact nested file diff checked; adopt into my independent copy'});}
  if(n===10)return {text:'Creator reviewed and adopted nested file into its own candidate'};
  if(n===11){topId=last(c.body).helperId;return tool('cothink_helper_result',{helperId:topId,decision:'adopt',reason:'Reviewed actual top-level file diff after nested creator treatment'});}
  if(n===12||n===13)return tool('accept_change');
  return {text:'Nested skill workflow delivered'};
 });
 const {mkdirSync}=await import('node:fs');const skill=join(f.home,'fixture-skill');
 mkdirSync(join(skill,'references'),{recursive:true});mkdirSync(join(skill,'scripts'));
 writeFileSync(join(skill,'SKILL.md'),'---\nname: fixture-skill\ndescription: Create a deterministic fixture file when explicitly requested.\n---\nRead references/instruction.txt and execute scripts/make.cjs using helper_exec.\n');
 writeFileSync(join(skill,'references/instruction.txt'),'ACTUAL_SKILL_REFERENCE: expected file is new.txt');
 writeFileSync(join(skill,'scripts/make.cjs'),"const fs=require('fs');fs.writeFileSync('new.txt','FROM_FROZEN_SKILL_SCRIPT');fs.writeFileSync('binary.bin',Buffer.from([0,255,7]));fs.unlinkSync('a.txt');fs.chmodSync('b.txt',0o755)");
 const installed=await invoke(f,['install','npm:pi-subagents@0.84.0','--json']);assert.equal(installed.code,0,installed.stderr+installed.stdout);
 saveConfig(f.home,{formatVersion:2,...f.models,piResources:{skills:[skill]},work:{checks:[],execution}});
 const run=await invoke(f,['ask','--json','/one create new.txt and creator.txt, add binary.bin, delete a.txt and make b.txt executable using selected skill and nested plugin helper'],'',repo.project);
 if(run.code)console.log(run.stderr,run.stdout.slice(-3000));assert.equal(run.code,0,run.stderr);
 const record=JSON.parse(run.stdout).task;
 assert.equal(f.calls.length,14);assert.equal(record.work.helpers.length,2);
 const [top,nested]=record.work.helpers;assert.equal(top.helperId,topId);assert.equal(nested.helperId,nestedId);assert.equal(nested.parentHelperId,top.helperId);
 assert.notEqual(top.cwd,nested.cwd);assert.equal(nested.treatment.destinationHelperId,top.helperId);
 assert.equal(nested.snapshot.files['creator.txt'].contentBase64,Buffer.from('CURRENT_CREATOR_OVERLAY').toString('base64'));
 assert.equal(top.exit.code,0);assert.equal(nested.exit.code,0);assert.equal(top.status,'completed');assert.equal(nested.status,'completed');
 assert.equal(readFileSync(join(record.work.resultWorkspace,'new.txt'),'utf8'),'FROM_FROZEN_SKILL_SCRIPT');
 assert.equal(record.work.acceptance.at(-1).status,'accepted');
 assert.deepEqual(readFileSync(join(record.work.resultWorkspace,'binary.bin')),Buffer.from([0,255,7]));assert.equal(existsSync(join(record.work.resultWorkspace,'a.txt')),false);
 assert.ok(top.result.edits.some(e=>e.path==='b.txt'&&e.mode===(process.platform==='win32'?'100644':'100755')));
 assert.equal(readFileSync(join(repo.project,'a.txt'),'utf8'),'base A\n');
 console.log('nested workflow:',JSON.stringify(record.work.helpers.map(h=>({helperId:h.helperId,parent:h.parentActorId,cwd:h.cwd,exit:h.exit,usage:h.usage,treatment:h.treatment,executions:h.executions}))));
});

test('normal formal member uses actual plugin helper after independent preparation', {timeout:60000},async t=>{
 const repo=repository(t);let memberId,helperId,memberCalls=0,mainCalls=0;let skill;
 const script="require('fs').writeFileSync(process.argv[1],'SCRIPT_FROM_FROZEN_RESOURCE')";
 const quote=text=>"'"+text.replaceAll("'","'\\''")+"'";
 const f=await fixture(t,(c,n)=>{
  if(n===1)return tool('start_work',{reason:'Member implementation comparison',scope:['main-skill.txt'],readScope:['.']});
  // Helpers use the member model too; distinguish by managed-helper system role.
  if(c.body.messages.some(m=>m.role==='system'&&m.content.includes('You are helper '))) {
    if(c.body.messages.at(-1).role==='user')return tool('write',{path:'new.txt',content:'MEMBER_HELPER'});
    return {text:'Actual helper file produced'};
  }
  if(c.body.model==='r1') {
    memberCalls++;
    if(memberCalls===1){assert.ok(!c.body.tools.some(t=>t.function.name==='cothink_helper'));return {text:'Original task is to create new.txt, preserve all other content; scope allows only new.txt.'};}
    if(memberCalls===2)return tool('read',{path:join(skill,'references/instruction.txt')});
    if(memberCalls===3)return tool('read',{path:join(skill,'scripts/make.cjs')});
    if(memberCalls===4){assert.match(JSON.stringify(c.body.messages),/SCRIPT_FROM_FROZEN_RESOURCE/);return tool('bash',{command:'node -e '+quote(script)+' new.txt'});}
    if(memberCalls===5)return tool('cothink_helper',{assignment:'Write new.txt with MEMBER_HELPER in the assigned scope'});
    if(memberCalls===6){helperId=last(c.body).helperId;return tool('cothink_helper_result',{helperId,decision:'adopt',reason:'Independent original task check and actual helper new.txt diff reviewed'});}
    return {text:'Member created and checked new.txt using its owned helper'};
  }
  mainCalls++;
  if(mainCalls===1)return tool('read',{path:join(skill,'references/instruction.txt')});
  if(mainCalls===2)return tool('read',{path:join(skill,'scripts/make.cjs')});
  if(mainCalls===3){assert.match(JSON.stringify(c.body.messages),/SCRIPT_FROM_FROZEN_RESOURCE/);return tool('bash',{command:'node -e '+quote(script)+' main-skill.txt'});}
  if(mainCalls===4||mainCalls===5)return tool('accept_change');
  if(mainCalls===6)return tool('delegate',{model:'fixture/r1',assignment:'Create new.txt using installed helper, inspect and adopt its actual result',reason:'Routine bounded implementation assigned to available member',scope:['new.txt'],readScope:['.']});
  if(mainCalls===7){memberId=last(c.body).memberId;return tool('collect',{memberId});}
  if(mainCalls===8||mainCalls===9)return tool('accept_change',{memberId});
  return {text:'Member helper candidate accepted and delivered'};
 });
 const {mkdirSync}=await import('node:fs');skill=join(f.home,'actor-skill');mkdirSync(join(skill,'references'),{recursive:true});mkdirSync(join(skill,'scripts'));
 writeFileSync(join(skill,'SKILL.md'),'---\nname: actor-skill\ndescription: Write fixture outputs when explicitly requested.\n---\nRead references/instruction.txt and scripts/make.cjs, execute that exact code through Docker bash.\n');
 writeFileSync(join(skill,'references/instruction.txt'),'ACTOR_SKILL_REFERENCE');writeFileSync(join(skill,'scripts/make.cjs'),script);
 const installed=await invoke(f,['install','npm:pi-subagents@0.84.0','--json']);assert.equal(installed.code,0,installed.stderr+installed.stdout);
 saveConfig(f.home,{formatVersion:2,...f.models,piResources:{skills:[skill]},work:{checks:[],execution}});
 const run=await invoke(f,['ask','--json','create new.txt with a formal member and plugin helper'],'',repo.project);
 if(run.code)console.log(run.stderr,run.stdout.slice(-2500));assert.equal(run.code,0,run.stderr);
 const record=JSON.parse(run.stdout).task;
 assert.equal(record.work.helpers.length,1);assert.equal(record.work.helpers[0].parentActorId,'member:'+memberId);
 assert.equal(record.work.helpers[0].model.modelId,'r1');assert.equal(record.work.helpers[0].exit.code,0);
 assert.equal(readFileSync(join(record.work.resultWorkspace,'new.txt'),'utf8'),'MEMBER_HELPER');
 assert.equal(record.work.acceptance.at(-1).status,'accepted');
 assert.equal(readFileSync(join(record.work.resultWorkspace,'main-skill.txt'),'utf8'),'SCRIPT_FROM_FROZEN_RESOURCE');
 assert.equal(record.tools.filter(t=>t.resourcePath?.includes('actor-skill')).length,4);
});

test('two real plugin siblings overlap independently, stale output is preserved and explicitly replaced after feedback', {timeout:60000}, async t=>{
 const repo=repository(t);let phase=0,arrivals=0,release;
 const both=new Promise(r=>release=r);const children=new Map();let a,b,fresh;
 const f=await fixture(t,async(c,n)=>{
  const system=c.body.messages.find(m=>m.role==='system')?.content??'';
  if(system.includes('You are helper ')) {
    const assignment=JSON.stringify(c.body.messages.find(m=>m.role==='user')?.content??'');
    const name=assignment.includes('lane-A')?'a-result.txt':'b-result.txt';
    if(c.body.messages.at(-1).role==='user') {
      arrivals++;if(arrivals===2)release();if(arrivals<=2)await both;
      return tool('write',{path:name,content:name==='a-result.txt'?'A':'B'});
    }
    return {text:'Actual independent sibling file result'};
  }
  if(n===1)return tool('start_work',{reason:'Parallel sibling work',scope:['a-result.txt','b-result.txt'],readScope:['.']});
  phase++;console.log('parallel parent phase',phase);
  if(phase===1)return {toolCalls:[{name:'cothink_helper',args:{assignment:'lane-A create a-result.txt'}},{name:'cothink_helper',args:{assignment:'lane-B create b-result.txt'}}]};
  if(phase===2){for(const m of c.body.messages.filter(m=>m.role==='tool')){try{const h=JSON.parse(m.content);if(h.helperId)children.set(h.helperId,h);}catch{}}const all=[...children.values()];a=all.find(h=>h.diff?.some(e=>e.path==='a-result.txt')).helperId;b=all.find(h=>h.diff?.some(e=>e.path==='b-result.txt')).helperId;return tool('cothink_helper_result',{helperId:a,decision:'adopt',reason:'Reviewed lane-A actual diff against original task'});}
  if(phase===3)return tool('cothink_helper_result',{helperId:b,decision:'adopt',reason:'Review lane-B; conservative input version must be checked'});
  if(phase===4){assert.match(JSON.stringify(c.body.messages.at(-1)),/STALE|differs from current parent/);return tool('cothink_helper_result',{helperId:b,decision:'reject',reason:'Input A lacks accepted draft A-result.txt now in C. Retain B evidence; request explicit fresh lane-B verification against current C.'});}
  if(phase===5)return tool('cothink_helper',{assignment:'Concrete feedback on prior lane-B: parent now has a-result.txt=A; inspect current snapshot and create b-result.txt=B preserving a-result.txt. This is an explicit new request, not replay.'});
  if(phase===6){fresh=last(c.body).helperId;return tool('cothink_helper_result',{helperId:fresh,decision:'adopt',reason:'Fresh C-based result reviewed; preserves A and adds B'});}
  if(phase===7||phase===8)return tool('accept_change');
  return {text:'Parallel siblings resolved with explicit stale feedback and formally accepted'};
 });
 const installed=await invoke(f,['install','npm:pi-subagents@0.84.0','--json']);assert.equal(installed.code,0,installed.stderr+installed.stdout);
 saveConfig(f.home,{formatVersion:2,...f.models,work:{checks:[],execution}});
 const run=await invoke(f,['ask','--json','/one create A and B using two parallel helpers'],'',repo.project);
 if(run.code)console.log(run.stderr,run.stdout.slice(-2000));assert.equal(run.code,0,run.stderr);
 const record=JSON.parse(run.stdout).task;const [one,two]=record.work.helpers;
 assert.equal(record.work.helpers.length,3);assert.notEqual(one.cwd,two.cwd);assert.equal(one.inputVersion,two.inputVersion);
 assert.ok(new Date(two.createdAt)<new Date(one.stoppedAt));assert.ok(new Date(one.createdAt)<new Date(two.stoppedAt));
 assert.equal(record.work.helpers.find(h=>h.helperId===b).treatment.decision,'rejected');
 assert.equal(readFileSync(join(record.work.resultWorkspace,'a-result.txt'),'utf8'),'A');assert.equal(readFileSync(join(record.work.resultWorkspace,'b-result.txt'),'utf8'),'B');
 assert.equal(record.work.acceptance.at(-1).status,'accepted');console.log('actual sibling overlap',one.createdAt,one.stoppedAt,two.createdAt,two.stoppedAt);
});

test('cancel during nested Docker work waits for tracked writers and never imports late files', {timeout:60000},async t=>{
 const repo=repository(t);const controller=new AbortController();let activeTask;
 const f=await fixture(t,(c,n)=>{
  const system=c.body.messages.find(m=>m.role==='system')?.content??'';
  if(n===1)return tool('start_work',{reason:'Cancellation trace',scope:['late.txt'],readScope:['.']});
  if(n===2)return tool('cothink_helper',{assignment:'Use a nested helper for cancellation sample'});
  if(system.includes('You are helper ')&&JSON.stringify(c.body.messages.find(m=>m.role==='user')).includes('nested helper'))return tool('cothink_helper',{assignment:'Run delayed file command for cancellation sample'});
  if(system.includes('You are helper '))return tool('helper_exec',{command:'sleep 60; printf LATE > late.txt'});
  throw Error('No parent continuation is permitted after cancellation');
 });
 const installed=await invoke(f,['install','npm:pi-subagents@0.84.0','--json']);assert.equal(installed.code,0,installed.stderr+installed.stdout);
 const {runTurn}=await load('src/discussion.js');
 const running=runTurn({home:f.home,cwd:repo.project,input:'/one run cancellable nested work',config:{formatVersion:2,...f.models,work:{checks:[],execution}},signal:controller.signal,onProgress:e=>{activeTask=e.task??activeTask;}});
 const deadline=Date.now()+20000;
 while(!activeTask?.record.work?.helpers?.some(h=>h.executions?.some(e=>e.status==='running'))) {if(Date.now()>deadline)throw Error('Nested Docker command did not start');await new Promise(r=>setTimeout(r,20));}
 const {execFileSync:inspectDocker}=await import('node:child_process');
 const container=activeTask.record.work.helpers.flatMap(h=>h.executions??[])[0].id;
 for(;;){try{if(inspectDocker('docker',['inspect','--format','{{.State.Running}}',container],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()==='true')break;}catch{}if(Date.now()>deadline)throw Error('Docker container never entered running');await new Promise(r=>setTimeout(r,20));}
 controller.abort();const task=await running;
 assert.equal(task.record.status,'cancelled',task.record.error);
 assert.equal(task.record.work.helpers.length,2);
 for(const h of task.record.work.helpers){assert.ok(h.stoppedAt,JSON.stringify(h));assert.equal(h.exit.code,0);assert.equal(h.import,undefined);}
 assert.equal(task.record.work.acceptance.length,0);assert.equal(f.calls.length,4);
 const {execFileSync}=await import('node:child_process');
 for(const h of task.record.work.helpers)for(const e of h.executions??[]){assert.notEqual(e.status,'running');assert.throws(()=>execFileSync('docker',['inspect',e.id],{stdio:'pipe'}));}
 console.log('cancel stopped descendants',JSON.stringify(task.record.work.helpers.map(h=>({id:h.helperId,parent:h.parentActorId,status:h.status,stoppedAt:h.stoppedAt,exit:h.exit,executions:h.executions}))));
});

test('source .pi retry/compaction/resources cannot override isolated child policy; a failed child is not retried', {timeout:60000},async t=>{
 const {mkdirSync,existsSync}=await import('node:fs');const {git}=await import('../helpers/git-fixture.js');const repo=repository(t);let mainPhase=0;
 mkdirSync(join(repo.project,'.pi/extensions'),{recursive:true});
 writeFileSync(join(repo.project,'.pi/settings.json'),JSON.stringify({retry:{enabled:true,maxRetries:5,provider:{maxRetries:5}},compaction:{enabled:true},extensions:['./extensions/ambient.js']}));
 writeFileSync(join(repo.project,'.pi/extensions/ambient.js'),"import {writeFileSync} from 'node:fs'; export default function(){writeFileSync('AMBIENT_IMPORTED','bad')}");
 git(repo.project,'status','--porcelain');git(repo.project,'add','--','.pi');git(repo.project,'commit','-m','malicious project settings fixture');
 const f=await fixture(t,(c,n)=>{
  const system=c.body.messages.find(m=>m.role==='system')?.content??'';
  if(system.includes('You are helper '))return {error:503};
  if(n===1)return tool('start_work',{reason:'Isolated failure case',scope:['new.txt'],readScope:['.']});
  mainPhase++;
  if(mainPhase===1)return tool('cothink_helper',{assignment:'Investigate without retry or compaction'});
  if(mainPhase===2)return tool('cothink_helper_result',{helperId:last(c.body).helperId,decision:'reject',reason:'Provider failed; preserve failed evidence and unknown usage, no replay'});
  return {text:'Helper failed once; no generated file or acceptance claimed'};
 });
 const installed=await invoke(f,['install','npm:pi-subagents@0.84.0','--json']);assert.equal(installed.code,0,installed.stderr+installed.stdout);
 saveConfig(f.home,{formatVersion:2,...f.models,work:{checks:[],execution}});
 const run=await invoke(f,['ask','--json','/one investigate isolated failure'],'',repo.project);if(run.code)console.log(run.stderr);assert.equal(run.code,0,run.stderr);
 const task=JSON.parse(run.stdout).task,h=task.work.helpers[0];
 assert.equal(f.calls.length,5,'one child HTTP attempt only');assert.equal(h.status,'failed');assert.equal(h.usage,null);
 assert.equal(h.treatment.decision,'rejected');assert.ok(h.stoppedAt);assert.equal(h.exit.code,0);
 assert.equal(existsSync(join(h.cwd,'AMBIENT_IMPORTED')),false);assert.equal(existsSync(join(repo.project,'AMBIENT_IMPORTED')),false);
});

test('cancel before runner startup cannot launch a public plugin model request', {timeout:60000},async t=>{
 const repo=repository(t),controller=new AbortController();let active;
 const f=await fixture(t,(_c,n)=>n===1?tool('start_work',{reason:'Startup cancel',scope:['new.txt'],readScope:['.']}):n===2?tool('cothink_helper',{assignment:'Must not launch after startup cancellation'}):assert.fail('No helper model request permitted after early cancel'));
 const installed=await invoke(f,['install','npm:pi-subagents@0.84.0','--json']);assert.equal(installed.code,0,installed.stderr);
 const {runTurn}=await load('src/discussion.js');
 const running=runTurn({home:f.home,cwd:repo.project,input:'/one startup cancellation sample',config:{formatVersion:2,...f.models,work:{checks:[],execution}},signal:controller.signal,onProgress:e=>{active=e.task??active;}});
 const deadline=Date.now()+15000;
 while(!active?.record.work?.helpers?.[0]?.process){if(Date.now()>deadline)throw Error('Runner did not fork');await new Promise(r=>setTimeout(r,1));}
 controller.abort();const task=await running,h=task.record.work.helpers[0];
 assert.equal(f.calls.length,2);assert.equal(h.cancelledBeforeLaunch,true);assert.equal(h.status,'cancelled');assert.ok(h.stoppedAt);assert.equal(h.exit.code,0);assert.equal(h.import,undefined);
});

test('abandon_member stops its real helper subtree while an unrelated main helper completes and accepts', {timeout:60000},async t=>{
 const repo=repository(t);let phase=0,memberCalls=0,memberId,mainHelperId,active,started,closed;
 const memberStarted=new Promise(r=>started=r),memberClosed=new Promise(r=>closed=r);
 const f=await fixture(t,async(c,n,_req,res)=>{
  const system=c.body.messages.find(m=>m.role==='system')?.content??'';
  if(system.includes('You are helper ')) {
    if(c.body.model==='r1'){res.on('close',closed);started();return null;}
    if(c.body.messages.at(-1).role==='user'){
      await memberClosed;
      const main=active.record.work.helpers.find(h=>h.parentActorId==='main');assert.equal(main.status,'running');assert.equal(main.cancelRequestedAt,undefined);
      return tool('write',{path:'main.txt',content:'UNRELATED_MAIN_RESULT'});
    }
    return {text:'Unrelated main helper completed normally'};
  }
  if(n===1)return tool('start_work',{reason:'Scoped owner cancellation',scope:['main.txt'],readScope:['.']});
  if(c.body.model==='r1'){
    memberCalls++;
    if(memberCalls===1)return {text:'I independently understand member.txt is the only writable member path; original task includes independent main work.'};
    if(memberCalls===2)return tool('cothink_helper',{assignment:'member-held: prepare member.txt then await cancellation sample'});
    assert.fail('Cancelled member must not continue model requests');
  }
  phase++;
  if(phase===1)return tool('delegate',{model:'fixture/r1',assignment:'Use own helper for member.txt; it may be explicitly abandoned',reason:'Independent bounded member work alongside main.txt',scope:['member.txt'],readScope:['.']});
  if(phase===2){memberId=last(c.body).memberId;await memberStarted;return {toolCalls:[{name:'cothink_helper',args:{assignment:'unrelated-main: write main.txt with UNRELATED_MAIN_RESULT'}},{name:'abandon_member',args:{memberId,reason:'Cancel only this member and all its helpers; preserve independent main work'}}]};}
  if(phase===3){for(const m of c.body.messages.filter(m=>m.role==='tool')){try{const value=JSON.parse(m.content);if(value.helperId&&value.parentActorId==='main')mainHelperId=value.helperId;}catch{}}assert.ok(mainHelperId);return tool('cothink_helper_result',{helperId:mainHelperId,decision:'adopt',reason:'Reviewed independent main result after member stop confirmation'});}
  if(phase===4||phase===5)return tool('accept_change');
  return {text:'Member subtree explicitly abandoned; unrelated main helper result accepted'};
 });
 const installed=await invoke(f,['install','npm:pi-subagents@0.84.0','--json']);assert.equal(installed.code,0,installed.stderr);
 const {runTurn}=await load('src/discussion.js');
 const task=await runTurn({home:f.home,cwd:repo.project,input:'Create main.txt and member.txt with independent plugin helpers; allow abandoning only the member',config:{formatVersion:2,...f.models,work:{checks:[],execution}},onProgress:e=>{active=e.task??active;}});
 assert.equal(task.record.status,'completed',task.record.error);
 const owned=task.record.work.helpers.find(h=>h.parentActorId==='member:'+memberId),main=task.record.work.helpers.find(h=>h.parentActorId==='main');
 assert.equal(owned.status,'cancelled');assert.ok(owned.stoppedAt);assert.equal(owned.exit.code,0);assert.equal(owned.treatment.decision,'rejected');assert.equal(owned.import,undefined);
 assert.equal(main.status,'completed');assert.equal(main.cancelRequestedAt,undefined);assert.equal(main.treatment.decision,'adopted');
 assert.equal(task.record.members[0].status,'abandoned');assert.equal(readFileSync(join(task.record.work.resultWorkspace,'main.txt'),'utf8'),'UNRELATED_MAIN_RESULT');assert.equal(existsSync(join(task.record.work.resultWorkspace,'member.txt')),false);
});

test('main abandon_change cannot clear an applied unknown helper import before original-ID inspection', {timeout:60000},async t=>{
 const repo=repository(t);let active,helperId,phase=0;
 const f=await fixture(t,(c,n)=>{
  const system=c.body.messages.find(m=>m.role==='system')?.content??'';
  if(system.includes('You are helper '))return c.body.messages.at(-1).role==='user'?tool('write',{path:'new.txt',content:'APPLIED_BUT_RECEIPT_LOST'}):{text:'Actual candidate file produced'};
  if(n===1)return tool('start_work',{reason:'Explicit old receipt recovery before abandonment',scope:['new.txt'],readScope:['.']});
  phase++;
  if(phase===1)return tool('cothink_helper',{assignment:'Create new.txt as a candidate, do not formally accept'});
  if(phase===2){helperId=last(c.body).helperId;return tool('cothink_helper_result',{helperId,decision:'adopt',reason:'Actual candidate diff reviewed'});}
  if(phase===3){const h=active.record.work.helpers[0];assert.equal(h.import.status,'applied');h.import.status='outcome_unknown';delete h.import.receipt;delete h.treatment;active.save();return tool('abandon_change',{reason:'Attempt discard while original import outcome is unresolved'});}
  if(phase===4){assert.match(JSON.stringify(c.body.messages.at(-1)),/HELPERS_PENDING/);assert.equal(active.record.work.requests.filter(r=>r.action==='abandonChange').length,0);return tool('cothink_helper_result',{helperId,decision:'inspect'});}
  if(phase===5){assert.equal(active.record.work.helpers[0].import.status,'applied');return tool('abandon_change',{reason:'Original ID now proves applied private edit; explicitly discard this known draft'});}
  return {text:'Known candidate explicitly discarded after original import receipt recovery; no formal acceptance'};
 });
 const installed=await invoke(f,['install','npm:pi-subagents@0.84.0','--json']);assert.equal(installed.code,0,installed.stderr);
 const {runTurn}=await load('src/discussion.js');
 const task=await runTurn({home:f.home,cwd:repo.project,input:'/one create then intentionally discard a candidate only after its original import outcome is known',config:{formatVersion:2,...f.models,work:{checks:[],execution}},onProgress:e=>{active=e.task??active;}});
 assert.equal(task.record.status,'completed',task.record.error);assert.equal(task.record.work.helpers[0].import.status,'applied');assert.equal(task.record.work.helpers[0].treatment.decision,'adopted');assert.equal(task.record.work.acceptance.length,0);
 assert.equal(task.record.work.changes.find(c=>c.changeId===task.record.work.helpers[0].changeId).status,'abandoned');assert.equal(existsSync(join(repo.project,'new.txt')),false);
});
