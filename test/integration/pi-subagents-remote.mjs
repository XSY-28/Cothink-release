import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fixture} from '../helpers/pi-fixture.js';
import {repository} from '../helpers/git-fixture.js';
import {invoke} from '../helpers/cli-fixture.js';
import {saveConfig} from '../../src/config.js';
import {execution} from '../helpers/agent-sync-fixture.js';
const tool=(name,args={})=>({toolCalls:[{name,args}]});
const fixtureRoot=resolve(process.env.COTHINK_NATIVE_REMOTE_FIXTURE??'work/native-plugin-routes/remote-fixture');
const remote=JSON.parse(readFileSync(join(fixtureRoot,'integration-profile.json'),'utf8'));

test('host CLI uses real native SSH Herdr Pi remote copy and public parent acceptance',{timeout:120000},async t=>{
 assert.equal(existsSync('/fixture'),false,'remote-only cwd must not be mirrored on host');
 const repo=repository(t);let phase=0,helperId,remoteCalls=0,skillRoot;
 const f=await fixture(t,(call,n)=>{
  const system=String(call.body.messages.find(message=>message.role==='system')?.content??'');
  if(system.includes('You are helper ')){remoteCalls++;
   if(remoteCalls===1){const skills=JSON.parse(system.match(/Frozen skills: ([^\n]+)\nTask resources:/)[1]);const skill=skills.find(s=>s.name==='remote-skill');assert.ok(skill);assert.match(skill.path,/\/resources\/remote-skill\/SKILL\.md$/);assert.ok(!skill.path.startsWith(f.home));assert.ok(skill.body.includes('Body literal: /keep/this/text unchanged.'));writeFileSync(join(skillRoot,'references/value.txt'),'MUTATED_ORIGINAL');writeFileSync(join(skillRoot,'scripts/probe.mjs'),'throw Error("mutated original")');return tool('read',{path:skill.path.replace(/SKILL\.md$/,'references/value.txt')});}
   if(remoteCalls===2){assert.match(JSON.stringify(call.body.messages.at(-1)),/RESOURCE_FROZEN/);return tool('write',{path:'native-remote.txt',content:'ACTUAL_REMOTE_FILE'});}
   if(remoteCalls===3)return tool('bash',{command:`node /resources/remote-skill/scripts/probe.mjs && node -e 'const f=require("fs");if(process.platform!=="linux"||f.existsSync("/var/run/docker.sock")||f.existsSync("/fixture"))process.exit(2);if(f.readFileSync("native-remote.txt","utf8")!=="ACTUAL_REMOTE_FILE")process.exit(3);f.appendFileSync("native-remote.txt","\\nDOCKER");f.writeFileSync("binary.dat",Buffer.from([0,255,1]));f.writeFileSync("mode.sh","echo owned\\n");f.chmodSync("mode.sh",493);f.unlinkSync("a.txt");console.log("REMOTE_DOCKER_LINUX")'`});
   if(remoteCalls===4){assert.match(JSON.stringify(call.body.messages.at(-1)),/REMOTE_SKILL_SCRIPT/);console.log('REMOTE_DOCKER_TOOL',JSON.stringify(call.body.messages.at(-1)));return tool('read',{path:'native-remote.txt'});}
   assert.match(JSON.stringify(call.body.messages.at(-1)),/DOCKER/);return {text:'Remote native file and Docker results done'};
  }
  if(n===1)return tool('start_work',{reason:'Use actual native remote helper',scope:['native-remote.txt','binary.dat','mode.sh','a.txt'],readScope:['.']});
  phase++;
  if(phase===1)return tool('subagents_enable');
  if(phase===2)return tool('subagent',{agent:'native-remote',task:'Write native-remote.txt with ACTUAL_REMOTE_FILE',model:'fixture/main',async:false,options:{machine:'native-test',context:'fresh',mission:false},artifacts:false});
  if(phase===3){console.log('REMOTE_TOOL_RESULT',JSON.stringify(call.body.messages.at(-1)));for(const line of String(call.body.messages.at(-1).content).split('\n'))try{helperId=JSON.parse(line).nativeHostResults?.[0]?.helperId??helperId;}catch{}if(!helperId)return {text:'Remote failed; preserve original evidence.'};return tool('cothink_helper_result',{helperId,decision:'inspect'});}
  if(phase===4)return tool('cothink_helper_result',{helperId,decision:'adopt',reason:'Reviewed actual remote file bytes and task'});
  if(phase===5||phase===6)return tool('accept_change');
  return {text:'Remote child reviewed and formally accepted'};
 });
 const installed=await invoke(f,['install','npm:pi-subagents@0.84.0','--json']);assert.equal(installed.code,0,installed.stdout+installed.stderr);
 mkdirSync(join(f.home,'pi/agents'),{recursive:true});writeFileSync(join(f.home,'pi/agents/native-remote.md'),'---\nname: native-remote\ndescription: native remote fixture\nmodel: fixture/main\ntools: read, write, edit, ls, bash\nsystemPromptMode: replace\ninheritProjectContext: false\ninheritGlobalContext: false\ninheritSkills: false\n---\nPerform the requested file work.\n');
 skillRoot=join(f.home,'selected-skill');mkdirSync(join(skillRoot,'references'),{recursive:true});mkdirSync(join(skillRoot,'scripts'));
 writeFileSync(join(skillRoot,'SKILL.md'),'---\nname: remote-skill\ndescription: Frozen remote reference and script fixture\n---\nBody literal: /keep/this/text unchanged.\nRead [the reference](references/value.txt), then run `scripts/probe.mjs` in the fixed Docker resources mount.\n');
 writeFileSync(join(skillRoot,'references/value.txt'),'RESOURCE_FROZEN');writeFileSync(join(skillRoot,'scripts/probe.mjs'),'import fs from "node:fs";if(fs.readFileSync("/resources/remote-skill/references/value.txt","utf8")!=="RESOURCE_FROZEN")throw Error("resource changed");console.log("REMOTE_SKILL_SCRIPT");');
 saveConfig(f.home,{formatVersion:2,...f.models,piResources:{skills:[join(skillRoot,'SKILL.md')]},work:{remoteMachines:{'native-test':remote},execution,checks:[{command:'node',args:['-e',"if(require('fs').readFileSync('native-remote.txt','utf8')!=='ACTUAL_REMOTE_FILE\\nDOCKER'||require('fs').existsSync('a.txt')||require('fs').readFileSync('binary.dat').toString('hex')!=='00ff01'||!(require('fs').statSync('mode.sh').mode&64))process.exit(1)"]}]}});
 const result=await invoke(f,['ask','--json','/one use native remote helper to write native-remote.txt'],'',repo.project);
 writeFileSync('work/native-plugin-routes/remote-r2-actual-result.json',JSON.stringify({result,remoteCalls},null,2));
 console.log('REMOTE_END',result.code,remoteCalls,result.stderr);assert.equal(result.code,0,result.stdout+result.stderr);
 const task=JSON.parse(result.stdout).task;assert.equal(task.work.helpers.length,1);const child=task.work.helpers[0];
 assert.equal(child.status,'completed',JSON.stringify(child));assert.equal(child.treatment?.decision,'adopted');assert.equal(remoteCalls,5);assert.equal(child.executions[0].stopConfirmed,true);assert.equal(child.executions[0].resultTransferred,true);assert.equal(child.executions[0].location.mode,'fixture-copy-volume');
 assert.equal(task.work.acceptance.at(-1).status,'accepted');assert.equal(readFileSync(join(task.work.resultWorkspace,'native-remote.txt'),'utf8'),'ACTUAL_REMOTE_FILE\nDOCKER');assert.equal(readFileSync(join(repo.project,'a.txt'),'utf8'),'base A\n');assert.equal(existsSync(join(repo.project,'native-remote.txt')),false);
});

test('task cancellation revokes remote admission but still confirms original Pi child shutdown',{timeout:90000},async t=>{
 const {runTurn}=await import('../../src/discussion.js');const controller=new AbortController(),repo=repository(t);let active,phase=0,remoteCalls=0,startedResolve,closedResolve;
 const started=new Promise(resolve=>startedResolve=resolve),closed=new Promise(resolve=>closedResolve=resolve);
 const f=await fixture(t,(call,n,req,res)=>{
  const system=String(call.body.messages.find(message=>message.role==='system')?.content??'');
  if(system.includes('You are helper ')){remoteCalls++;res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: '+JSON.stringify({id:'held',object:'chat.completion.chunk',created:1,model:'main',choices:[{index:0,delta:{role:'assistant',content:'held'},finish_reason:null}]})+'\n\n');res.on('close',closedResolve);startedResolve();return null;}
  if(n===1)return tool('start_work',{reason:'Cancel actual native remote stream',scope:['cancelled.txt'],readScope:['.']});phase++;
  if(phase===1)return tool('subagents_enable');if(phase===2)return tool('subagent',{agent:'native-remote',task:'Wait for response',async:false,model:'fixture/main',options:{machine:'native-test',context:'fresh',mission:false},artifacts:false});
  return {text:'Cancelled task; no retry.'};
 });
 const installed=await invoke(f,['install','npm:pi-subagents@0.84.0','--json']);assert.equal(installed.code,0,installed.stderr);
 mkdirSync(join(f.home,'pi/agents'),{recursive:true});writeFileSync(join(f.home,'pi/agents/native-remote.md'),'---\nname: native-remote\ndescription: cancellation fixture\nmodel: fixture/main\ntools: read, write\nsystemPromptMode: replace\ninheritProjectContext: false\ninheritGlobalContext: false\ninheritSkills: false\n---\nWait for the assigned response.\n');
 const running=runTurn({home:f.home,cwd:repo.project,input:'/one start the native remote helper then cancel',config:{formatVersion:2,...f.models,work:{remoteMachines:{'native-test':remote},execution,checks:[{command:'node',args:['-e','process.exit(0)']}]}},signal:controller.signal,onProgress:event=>{active=event.task??active;}});running.catch(()=>{});
 t.after(async()=>{if(active?.record.status==='running')controller.abort();await running.catch(()=>{});});
 await Promise.race([started,running.then(task=>{throw Error('Remote did not start: '+JSON.stringify(task.record.error));})]);controller.abort(new Error('Explicit fixture cancellation'));
 const task=await running;await closed;const child=task.record.work.helpers[0];writeFileSync('work/native-plugin-routes/remote-r3-cancel-record.json',JSON.stringify(task.record,null,2));
 console.log('REMOTE_CANCEL',JSON.stringify({status:task.record.status,child:child.status,stoppedAt:child.stoppedAt,shutdown:child.shutdownEvidence,start:child.native.remote.processStart,exit:child.native.remote.processExit,calls:remoteCalls,error:task.record.error}));
 assert.equal(task.record.status,'cancelled');assert.equal(child.import,undefined);assert.equal(task.record.work.acceptance.length,0);assert.equal(child.usage,null);assert.equal(remoteCalls,1);assert.ok(child.stoppedAt);assert.equal(child.status,'cancelled');assert.equal(child.shutdownEvidence.shutdownCompleted,true);assert.equal(child.native.remote.processExit.pid,child.native.remote.processStart.pid);assert.ok(child.native.remote.processExit.childStartTime);
 assert.equal(existsSync(join(repo.project,'cancelled.txt')),false);
});

test('actual native bridge reconnect retains original identity and does not resend the model prompt',{timeout:90000},async t=>{
 const {runTurn}=await import('../../src/discussion.js'),{execFileSync}=await import('node:child_process');const repo=repository(t);let active,phase=0,remoteCalls=0,helperId,release,enteredResolve;
 const held=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>enteredResolve=resolve);t.after(()=>release());
 const f=await fixture(t,async(call,n)=>{
  const system=String(call.body.messages.find(message=>message.role==='system')?.content??'');
  if(system.includes('You are helper ')){remoteCalls++;if(remoteCalls===1){enteredResolve();await held;return tool('write',{path:'reconnect.txt',content:'ONE_NATIVE_PROMPT'});}return {text:'Native reconnect retained original work'};}
  if(n===1)return tool('start_work',{reason:'Actual native bridge recovery',scope:['reconnect.txt'],readScope:['.']});phase++;
  if(phase===1)return tool('subagents_enable');if(phase===2)return tool('subagent',{agent:'native-remote',task:'Write reconnect.txt once',async:false,model:'fixture/main',options:{machine:'native-test',context:'fresh',mission:false},artifacts:false});
  if(phase===3){helperId=active.record.work.helpers[0].helperId;return tool('cothink_helper_result',{helperId,decision:'inspect'});}
  if(phase===4)return tool('cothink_helper_result',{helperId,decision:'adopt',reason:'Reviewed actual unchanged remote identity and one original request result'});
  if(phase===5||phase===6)return tool('accept_change');return {text:'Recovered original remote work without duplicate prompt'};
 });
 const installed=await invoke(f,['install','npm:pi-subagents@0.84.0','--json']);assert.equal(installed.code,0,installed.stderr);
 mkdirSync(join(f.home,'pi/agents'),{recursive:true});writeFileSync(join(f.home,'pi/agents/native-remote.md'),'---\nname: native-remote\ndescription: bridge recovery fixture\nmodel: fixture/main\ntools: read, write\nsystemPromptMode: replace\ninheritProjectContext: false\ninheritGlobalContext: false\ninheritSkills: false\n---\nWrite the requested file once.\n');
 const controller=new AbortController(),running=runTurn({home:f.home,cwd:repo.project,input:'/one recover the existing native remote transport without resending work',config:{formatVersion:2,...f.models,work:{remoteMachines:{'native-test':remote},execution,checks:[{command:'node',args:['-e',"if(require('fs').readFileSync('reconnect.txt','utf8')!=='ONE_NATIVE_PROMPT')process.exit(1)"]}]}},signal:controller.signal,onProgress:event=>{active=event.task??active;}});running.catch(()=>{});t.after(async()=>{release();if(active?.record.status==='running')controller.abort();await running.catch(()=>{});});
 await Promise.race([entered,running.then(task=>{throw Error('No remote request: '+JSON.stringify(task.record.error));})]);
 const before=structuredClone(active.record.work.helpers[0].native.remoteIdentity);assert.ok(before?.runtimeDir);const suffix=':'+before.runtimeDir+'/bridge.sock';
 const tunnels=()=>execFileSync('ps',['-axo','pid=,ppid=,command='],{encoding:'utf8'}).split('\n').map(line=>line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/)).filter(row=>row&&Number(row[2])===process.pid&&row[3].includes(suffix)&&row[3].includes('ssh')&&row[3].includes(' -L ')).map(row=>Number(row[1]));
 const original=tunnels();assert.equal(original.length,1,'exact owned native bridge tunnel');process.kill(original[0],'SIGTERM');
 let replacement;const deadline=Date.now()+15000;for(;;){replacement=tunnels().find(pid=>pid!==original[0]);if(replacement)break;if(Date.now()>deadline)throw Error('Native replacement transport not established');await new Promise(resolve=>setTimeout(resolve,20));}
 release();const task=await running,child=task.record.work.helpers[0],after=child.shutdownEvidence?.remoteIdentity;
 const evidence={status:task.record.status,before,after,oldTunnelPid:original[0],newTunnelPid:replacement,remoteCalls,readyReceipts:child.native.remote.requests.filter(x=>x.action==='ready').length,error:task.record.error};console.log('REMOTE_RECONNECT',JSON.stringify(evidence));writeFileSync('work/native-plugin-routes/remote-r3-reconnect-evidence.json',JSON.stringify(evidence,null,2));
 assert.equal(task.record.status,'completed');assert.equal(remoteCalls,2);assert.equal(evidence.readyReceipts,1);
 for(const key of ['runId','terminalId','nativeSessionId','cwd'])assert.equal(after[key],before[key]);assert.ok(after.cursor>=before.cursor);assert.ok(after.cursor>0);assert.equal(child.native.remote.processExit.pid,child.native.remote.ready.pid);assert.equal(task.record.work.acceptance.at(-1).status,'accepted');assert.equal(existsSync(join(repo.project,'reconnect.txt')),false);
});

test('remote result B cannot overwrite parent C from the registered A snapshot',{timeout:90000},async t=>{
 const {runTurn}=await import('../../src/discussion.js');const repo=repository(t);let active,phase=0,remoteCalls=0,helperId,enteredResolve,release,staleRefused=false,acceptanceAtRefusal;
 const entered=new Promise(resolve=>enteredResolve=resolve),held=new Promise(resolve=>release=resolve);t.after(()=>release());
 const f=await fixture(t,async(call,n)=>{
  const system=String(call.body.messages.find(message=>message.role==='system')?.content??'');
  if(system.includes('You are helper ')){remoteCalls++;if(remoteCalls===1){enteredResolve();await held;return tool('write',{path:'a.txt',content:'REMOTE_B\n'});}return {text:'Remote B based on registered A'};}
  if(n===1)return tool('start_work',{reason:'Preserve newer parent C against remote B',scope:['a.txt'],readScope:['.']});phase++;
  if(phase===1)return tool('subagents_enable');if(phase===2)return tool('read',{path:'a.txt'});
  if(phase===3){assert.match(JSON.stringify(call.body.messages.at(-1)),/base A/);return {toolCalls:[{name:'subagent',args:{agent:'native-remote',task:'Change the isolated a.txt to REMOTE_B',async:false,model:'fixture/main',options:{machine:'native-test',context:'fresh',mission:false},artifacts:false}},{name:'write',args:{path:'a.txt',content:'PARENT_C\n'}}]};}
  if(phase===4){helperId=active.record.work.helpers[0].helperId;return tool('cothink_helper_result',{helperId,decision:'inspect'});}
  if(phase===5)return tool('cothink_helper_result',{helperId,decision:'adopt',reason:'Attempt to adopt remote B must compare its original A basis'});
  if(phase===6){const response=JSON.stringify(call.body.messages.at(-1));assert.match(response,/STALE_PRIVATE|Helper input A differs from current parent C/);staleRefused=true;acceptanceAtRefusal=active.record.work.acceptance.length;return tool('cothink_helper_result',{helperId,decision:'reject',reason:'Parent C changed the same file; preserve remote B separately without replacing its expected version'});}
  if(phase===7||phase===8)return tool('accept_change');return {text:'Remote stale B refused; current parent C checked and accepted'};
 });
 const installed=await invoke(f,['install','npm:pi-subagents@0.84.0','--json']);assert.equal(installed.code,0,installed.stderr);
 mkdirSync(join(f.home,'pi/agents'),{recursive:true});writeFileSync(join(f.home,'pi/agents/native-remote.md'),'---\nname: native-remote\ndescription: stale remote fixture\nmodel: fixture/main\ntools: read, write\nsystemPromptMode: replace\ninheritProjectContext: false\ninheritGlobalContext: false\ninheritSkills: false\n---\nWrite the assigned independent file result.\n');
 const controller=new AbortController(),running=runTurn({home:f.home,cwd:repo.project,input:'/one preserve parent C when remote B used the older A source',config:{formatVersion:2,...f.models,work:{remoteMachines:{'native-test':remote},execution,checks:[{command:'node',args:['-e',"if(require('fs').readFileSync('a.txt','utf8')!=='PARENT_C\\n')process.exit(1)"]}]}},signal:controller.signal,onProgress:event=>{active=event.task??active;}});running.catch(()=>{});t.after(async()=>{release();if(active?.record.status==='running')controller.abort();await running.catch(()=>{});});
 await Promise.race([entered,running.then(task=>{throw Error('Remote did not start: '+JSON.stringify(task.record.error));})]);
 const deadline=Date.now()+10000;for(;;){if(active.record.tools.some(x=>x.name==='write'&&x.sourcePath==='a.txt'&&x.status==='completed'))break;if(Date.now()>deadline)throw Error('Parallel parent C did not complete while remote response held');await new Promise(resolve=>setTimeout(resolve,10));}
 const childBefore=active.record.work.helpers[0];assert.equal(Buffer.from(childBefore.snapshot.files['a.txt'].contentBase64,'base64').toString(),'base A\n');assert.equal(active.record.work.acceptance.length,0);release();
 const task=await running,child=task.record.work.helpers[0];const evidence={status:task.record.status,error:task.record.error,inputVersion:child.inputVersion,snapshotVersion:child.snapshot.inputVersion,parentEdit:task.record.tools.find(x=>x.name==='write'&&x.sourcePath==='a.txt'),staleRefused,acceptanceAtRefusal,remoteCalls,import:child.import??null,treatment:child.treatment,result:child.result?.edits};writeFileSync('work/native-plugin-routes/remote-r3-stale-evidence.json',JSON.stringify(evidence,null,2));console.log('REMOTE_STALE',JSON.stringify(evidence));
 assert.equal(task.record.status,'completed');assert.equal(remoteCalls,2);assert.ok(staleRefused);assert.equal(acceptanceAtRefusal,0);assert.equal(child.import,undefined);assert.equal(child.inputVersion,child.snapshot.inputVersion);assert.equal(child.treatment.decision,'rejected');assert.equal(Buffer.from(child.result.files['a.txt'].contentBase64,'base64').toString(),'REMOTE_B\n');assert.equal(readFileSync(join(task.record.work.resultWorkspace,'a.txt'),'utf8'),'PARENT_C\n');assert.equal(readFileSync(join(repo.project,'a.txt'),'utf8'),'base A\n');
});
