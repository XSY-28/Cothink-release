import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {fixture} from '../helpers/pi-fixture.js';
import {repository,git} from '../helpers/git-fixture.js';
import {invoke} from '../helpers/cli-fixture.js';
import {saveConfig} from '../../src/config.js';
import {execution} from '../helpers/agent-sync-fixture.js';
import {runTurn} from '../../src/discussion.js';
import {execFileSync} from 'node:child_process';
const tool=(name,args={})=>({toolCalls:[{name,args}]});
function hostResult(body) {
 for(const message of body.messages.filter(message=>message.role==='tool').toReversed()) {
  for(const line of String(message.content).split('\n').toReversed())try{const value=JSON.parse(line);if(value.nativeHostResults?.length)return value.nativeHostResults[0].helperId;}catch{}
 }
 throw Error('No actual native host result in tool output');
}
test('normal ONE CLI uses native subagent tool, independent file result, parent review and Docker acceptance', {timeout:60000},async t=>{
 const repo=repository(t);let phase=0,helperId;
 const f=await fixture(t,(call,n)=>{
  const system=String(call.body.messages.find(message=>message.role==='system')?.content??'');
  if(system.includes('You are helper '))return call.body.messages.at(-1).role==='user'?tool('write',{path:'native.txt',content:'ACTUAL_NATIVE_FILE'}):{text:'Actual native agent wrote native.txt'};
  if(n===1)return tool('start_work',{reason:'Use original native subagent',scope:['native.txt'],readScope:['.']});
  phase++;
  if(phase===1)return tool('subagents_enable');
  if(phase===2)return tool('subagent',{agent:'native-local',task:'Create native.txt with ACTUAL_NATIVE_FILE',model:'fixture/main',async:false,options:{context:'fresh'},artifacts:false});
  if(phase===3){console.log('native tool output',JSON.stringify(call.body.messages.at(-1)));helperId=hostResult(call.body);return tool('cothink_helper_result',{helperId,decision:'inspect'});}
  if(phase===4)return tool('cothink_helper_result',{helperId,decision:'adopt',reason:'Reviewed original native agent task and exact native.txt file diff'});
  if(phase===5||phase===6)return tool('accept_change');
  return {text:'Native original tool file reviewed, checked and formally accepted'};
 });
 const installed=await invoke(f,['install','npm:pi-subagents@0.84.0','--json']);assert.equal(installed.code,0,installed.stdout+installed.stderr);
 mkdirSync(join(f.home,'pi/agents'),{recursive:true});
 writeFileSync(join(f.home,'pi/agents/native-local.md'),'---\nname: native-local\ndescription: actual native local agent\nmodel: fixture/main\ntools: read, write, edit, ls, bash\nsystemPromptMode: replace\ninheritProjectContext: false\ninheritGlobalContext: false\ninheritSkills: false\n---\nPerform the requested file work.\n');
 saveConfig(f.home,{formatVersion:2,...f.models,work:{execution,checks:[{command:'node',args:['-e',"if(require('fs').readFileSync('native.txt','utf8')!=='ACTUAL_NATIVE_FILE')process.exit(1)"]}]}});
 const run=await invoke(f,['ask','--json','/one create native.txt using the original native subagent tool'],'',repo.project);
 if(run.code)console.log(run.stdout,run.stderr);assert.equal(run.code,0,run.stdout+run.stderr);
 const task=JSON.parse(run.stdout).task;
 assert.equal(task.work.helpers.length,1);const child=task.work.helpers[0];
 assert.ok(child.native);assert.equal(child.native.agent,'native-local');assert.equal(child.status,'completed');assert.ok(child.native.sessionId);assert.equal(child.treatment.decision,'adopted');
 assert.equal(task.tools.some(trace=>trace.name==='subagent'),true);
 assert.equal(task.tools.some(trace=>trace.name==='cothink_helper'),false);
 assert.equal(task.work.acceptance.at(-1).status,'accepted');assert.equal(readFileSync(join(task.work.resultWorkspace,'native.txt'),'utf8'),'ACTUAL_NATIVE_FILE');
 assert.equal(readFileSync(join(repo.project,'a.txt'),'utf8'),'base A\n');
});

for(const entry of ['CLI','GUI'])test(`original workflow ${entry} runs dynamic sequential and parallel native children without file adoption between steps`,{timeout:60000},async t=>{
 const repo=repository(t);let phase=0,results=[],reviewIndex=0,arrivals=0,release;
 const parallel=new Promise(resolve=>release=resolve);
 const script='const first=await runs.run("first-"+args.tag,{agent:"native-local",task:"FIRST_TEXT: return FIRST_NATIVE_TEXT",async:false});\nconst pair=await runs.all([{key:"writer-"+args.tag,agent:"native-local",task:"PARALLEL_WRITE: create workflow.txt=WORKFLOW_FILE; text dependency="+first.output,async:false},{key:"reader-"+args.tag,agent:"native-local",task:"PARALLEL_READ: return observed text dependency="+first.output,async:false}]);\nreturn {first:first.output,pair:pair.map(result=>result.output)};';
 writeFileSync(join(repo.project,'native-workflow.js'),script);git(repo.project,'status','--porcelain');git(repo.project,'add','--','native-workflow.js');git(repo.project,'commit','-m','native workflow fixture input');
 const f=await fixture(t,async(call,n)=>{
  const system=String(call.body.messages.find(message=>message.role==='system')?.content??'');
  if(system.includes('You are helper ')) {
    const rawTask=call.body.messages.filter(message=>message.role==='user').at(-1)?.content;const task=typeof rawTask==='string'?rawTask:JSON.stringify(rawTask);console.log('native workflow child input',task);
    if(task.includes('FIRST_TEXT'))return {text:'FIRST_NATIVE_TEXT'};
    if(call.body.messages.at(-1).role==='user') {
      assert.match(task,/FIRST_NATIVE_TEXT/);arrivals++;if(arrivals===2)release();await parallel;
      if(task.includes('PARALLEL_WRITE'))return tool('write',{path:'workflow.txt',content:'WORKFLOW_FILE'});
      return {text:'Parallel reader saw FIRST_NATIVE_TEXT'};
    }
    return {text:'Parallel writer produced actual workflow.txt'};
  }
  if(n===1)return tool('start_work',{reason:'Run original dynamic workflow engine',scope:['workflow.txt'],readScope:['.']});
  phase++;
  if(phase===1)return tool('subagents_enable');
  if(phase===2)return tool('subagent',{workflow:'./native-workflow.js',args:{tag:'dynamic'},model:'fixture/main',async:false});
  if(phase===3){console.log('native workflow output',JSON.stringify(call.body.messages.at(-1)));for(const message of call.body.messages.filter(message=>message.role==='tool').toReversed())for(const line of String(message.content).split('\n').toReversed())try{const value=JSON.parse(line);if(value.nativeHostResults?.length){results=value.nativeHostResults;break;}}catch{}assert.equal(results.length,3);}
  if(reviewIndex<results.length)return tool('cothink_helper_result',{helperId:results[reviewIndex++].helperId,decision:'adopt',reason:'Reviewed dynamic native workflow child result and exact file/text evidence'});
  if(phase===6||phase===7)return tool('accept_change');
  return {text:'Original workflow text dependency and parallel file work reviewed and formally accepted'};
 });
 const installed=await invoke(f,['install','npm:pi-subagents@0.84.0','--json']);assert.equal(installed.code,0,installed.stdout+installed.stderr);
 mkdirSync(join(f.home,'pi/agents'),{recursive:true});writeFileSync(join(f.home,'pi/agents/native-local.md'),'---\nname: native-local\ndescription: actual native workflow child\nmodel: fixture/main\ntools: read, write, edit, ls, bash\nsystemPromptMode: replace\ninheritProjectContext: false\ninheritGlobalContext: false\ninheritSkills: false\n---\nDo the requested native workflow step.\n');
 saveConfig(f.home,{formatVersion:2,...f.models,work:{execution,checks:[{command:'node',args:['-e',"if(require('fs').readFileSync('workflow.txt','utf8')!=='WORKFLOW_FILE')process.exit(1)"]}]}});
 let run;
 if(entry==='CLI')run=await invoke(f,['ask','--json','/one create workflow.txt through the original sequential and parallel native workflow'],'',repo.project);
 else {
   const {createTeamConfig}=await import('../../src/teams.js');const {createGuiController}=await import('../../src/gui-controller.js');const {readTask}=await import('../../src/task.js');
   saveConfig(f.home,createTeamConfig({formatVersion:2,...f.models,work:{execution,checks:[{command:'node',args:['-e',"if(require('fs').readFileSync('workflow.txt','utf8')!=='WORKFLOW_FILE')process.exit(1)"]}]}},'GUI native workflow','7c8094cd-3476-4bfa-8f53-055d87972896'));
   const controller=await createGuiController({home:f.home,cwd:repo.project});t.after(()=>controller.close());
   const session=await controller.action('session.create',{project:repo.project});await controller.action('session.mode',{sessionId:session.id,mode:'one'});
   const submission=await controller.action('task.submit',{sessionId:session.id,input:'create workflow.txt through the original sequential and parallel native workflow',submissionId:'native-workflow-gui'});
   let final;for(let i=0;i<2000;i++){final=await controller.task(submission.taskId);if(final.status!=='running')break;await new Promise(resolve=>setTimeout(resolve,10));}
   run={code:final.status==='completed'?0:1,stdout:JSON.stringify({task:readTask(f.home,submission.taskId)}),stderr:final.error??''};await controller.close();
 }
 if(run.code)console.log(run.stdout,run.stderr);assert.equal(run.code,0,run.stdout+run.stderr);
 const task=JSON.parse(run.stdout).task;assert.equal(task.work.helpers.length,3);assert.equal(arrivals,2);
 assert.equal(new Set(task.work.helpers.map(helper=>helper.cwd)).size,3);
 assert.ok(task.work.helpers.every(helper=>helper.native&&helper.status==='completed'&&helper.stoppedAt&&helper.treatment?.decision==='adopted'));
 assert.ok(task.work.helpers.every(helper=>helper.snapshot.files['workflow.txt']===undefined));
 assert.equal(task.work.acceptance.at(-1).status,'accepted');assert.equal(readFileSync(join(task.work.resultWorkspace,'workflow.txt'),'utf8'),'WORKFLOW_FILE');
});

test('original nested workflow sees creator overlay and child adoption returns through its actual creator',{timeout:60000},async t=>{
 const repo=repository(t);let phase=0,parentCalls=0,grandCalls=0,parentId,grandId;
 writeFileSync(join(repo.project,'nested-workflow.js'),'return runs.run("grand-"+args.key,{agent:"native-local",task:"NESTED_CHILD: read parent.txt then create nested.txt=NESTED_FILE",async:false});');
 git(repo.project,'status','--porcelain');git(repo.project,'add','--','nested-workflow.js');git(repo.project,'commit','-m','nested original workflow fixture input');
 const f=await fixture(t,(call,n)=>{
  const system=String(call.body.messages.find(message=>message.role==='system')?.content??'');
  if(system.includes('You are helper ')) {
    if(system.includes('<active_agent name="native-parent"/>')) {
      parentCalls++;
      if(parentCalls===1)return tool('write',{path:'parent.txt',content:'CREATOR_OVERLAY'});
      if(parentCalls===2)return tool('subagent',{workflow:'./nested-workflow.js',args:{key:'child'},async:false,model:'fixture/main'});
      if(parentCalls===3){grandId=hostResult(call.body);return tool('cothink_helper_result',{helperId:grandId,decision:'adopt',reason:'Actual creator reviewed nested child file diff against its complete overlay input'});}
      return {text:'Creator explicitly adopted actual nested file into own overlay'};
    }
    grandCalls++;
    if(grandCalls===1)return tool('read',{path:'parent.txt'});
    if(grandCalls===2){assert.match(JSON.stringify(call.body.messages),/CREATOR_OVERLAY/);return tool('write',{path:'nested.txt',content:'NESTED_FILE'});}
    return {text:'Grandchild read real creator overlay and wrote nested.txt'};
  }
  if(n===1)return tool('start_work',{reason:'Original nested workflow',scope:['parent.txt','nested.txt'],readScope:['.']});
  phase++;
  if(phase===1)return tool('subagents_enable');
  if(phase===2)return tool('subagent',{agent:'native-parent',task:'Create parent.txt overlay and use original nested workflow, then explicitly review its child result',async:false,model:'fixture/main'});
  if(phase===3){console.log('nested original result',JSON.stringify(call.body.messages.at(-1)));parentId=hostResult(call.body);return tool('cothink_helper_result',{helperId:parentId,decision:'adopt',reason:'Reviewed creator overlay plus explicitly incorporated nested result against original task'});}
  if(phase===4||phase===5)return tool('accept_change');
  return {text:'Original nested native workflow and explicit creator adoption accepted'};
 });
 const installed=await invoke(f,['install','npm:pi-subagents@0.84.0','--json']);assert.equal(installed.code,0,installed.stdout+installed.stderr);
 mkdirSync(join(f.home,'pi/agents'),{recursive:true});
 const agent=(name,nested)=>'---\nname: '+name+'\ndescription: original nested workflow fixture\nmodel: fixture/main\ntools: read, write, edit, ls, bash'+(nested?', subagent':'')+'\nallowNestedSubagents: '+nested+'\nsystemPromptMode: replace\ninheritProjectContext: false\ninheritGlobalContext: false\ninheritSkills: false\n---\nDo assigned work and explicitly review your native child result.\n';
 writeFileSync(join(f.home,'pi/agents/native-parent.md'),agent('native-parent',true));writeFileSync(join(f.home,'pi/agents/native-local.md'),agent('native-local',false));
 saveConfig(f.home,{formatVersion:2,...f.models,work:{execution,checks:[{command:'node',args:['-e',"const f=require('fs');if(f.readFileSync('parent.txt','utf8')!=='CREATOR_OVERLAY'||f.readFileSync('nested.txt','utf8')!=='NESTED_FILE')process.exit(1)"]}]}});
 const run=await invoke(f,['ask','--json','/one create parent.txt and nested.txt through original nested native workflow with creator review'],'',repo.project);
 if(run.code)console.log(run.stdout,run.stderr);assert.equal(run.code,0,run.stdout+run.stderr);
 const task=JSON.parse(run.stdout).task;assert.equal(task.work.helpers.length,2);
 const parent=task.work.helpers.find(helper=>helper.helperId===parentId),grand=task.work.helpers.find(helper=>helper.helperId===grandId);
 assert.equal(grand.parentActorId,parent.helperId);assert.equal(grand.depth,2);assert.equal(grand.treatment.destinationHelperId,parent.helperId);
 assert.equal(Buffer.from(grand.snapshot.files['parent.txt'].contentBase64,'base64').toString(),'CREATOR_OVERLAY');
 assert.equal(parent.snapshot.files['parent.txt'],undefined);assert.equal(task.work.acceptance.at(-1).status,'accepted');
});

test('original named workflow runs.host uses tracked offline Docker and explicit source result review',{timeout:60000},async t=>{
 const repo=repository(t);let phase=0,resultId;
 const f=await fixture(t,(call,n)=>{
  if(n===1)return tool('start_work',{reason:'Named original workflow host command',scope:['host.txt'],readScope:['.']});
  phase++;
  if(phase===1)return tool('subagents_enable');
  if(phase===2)return tool('subagent',{workflow:'native-host-command',async:false});
  if(phase===3){console.log('native host command output',JSON.stringify(call.body.messages.at(-1)));for(const line of String(call.body.messages.at(-1).content).split('\n').toReversed())try{resultId=JSON.parse(line).nativePluginResultId;if(resultId)break;}catch{}assert.ok(resultId);return tool('cothink_helper_result',{helperId:resultId,decision:'inspect'});}
  if(phase===4)return tool('cothink_helper_result',{helperId:resultId,decision:'adopt',reason:'Reviewed actual Docker command-created host.txt and native workflow source diff'});
  if(phase===5||phase===6)return tool('accept_change');
  return {text:'Named native command output reviewed, checked and formally accepted'};
 });
 const installed=await invoke(f,['install','npm:pi-subagents@0.84.0','--json']);assert.equal(installed.code,0,installed.stdout+installed.stderr);
 const plugin=join(f.home,'pi/npm/node_modules/pi-subagents'),extension=join(f.home,'named-workflow.mjs');
 const command='test -f /.dockerenv && printf HOST_DOCKER > host.txt && printf HOST_STDOUT';
 writeFileSync(extension,`import{registerWorkflowResource}from ${JSON.stringify(join(plugin,'bundle/workflow-resources.js'))};export default pi=>{let registration;pi.on('session_start',(_,ctx)=>{registration?.dispose();registration=registerWorkflowResource({sessionId:ctx.sessionManager.getSessionId(),definition:{name:'native-host-command',version:1,resolve:()=>({script:${JSON.stringify('const result=await runs.host("command",{kind:"command",command:'+JSON.stringify(command)+',timeoutMs:10000});return result;')},hostCommands:[{key:'command',command:${JSON.stringify(command)}}]})}});});pi.on('session_shutdown',()=>registration?.dispose());};`);
 saveConfig(f.home,{formatVersion:2,...f.models,piResources:{extensions:[extension]},work:{execution,checks:[{command:'node',args:['-e',"if(require('fs').readFileSync('host.txt','utf8')!=='HOST_DOCKER')process.exit(1)"]}]}});
 const run=await invoke(f,['ask','--json','/one create host.txt through the named native workflow Docker command'],'',repo.project);
 if(run.code)console.log(run.stdout,run.stderr);assert.equal(run.code,0,run.stdout+run.stderr);
 const task=JSON.parse(run.stdout).task,commandFact=task.tools.find(trace=>trace.kind==='native_host_command');
 assert.equal(task.work.helpers.length,0);assert.equal(commandFact.status,'completed');assert.equal(commandFact.executions[0].exitCode,0);assert.match(commandFact.executions[0].stdout,/HOST_STDOUT/);
 assert.equal(task.work.acceptance.at(-1).status,'accepted');assert.equal(readFileSync(join(task.work.resultWorkspace,'host.txt'),'utf8'),'HOST_DOCKER');
});

for(const readOnly of [false,true])test(`native absolute output rejects private/sibling/out-of-scope paths before another model or writer (${readOnly?'readonly':'scoped'})`,{timeout:60000},async t=>{
 const repo=repository(t);let active,phase=0,childCalls=0,helperId,targets=[],baseline=[];
 const f=await fixture(t,(call,n)=>{
  const system=String(call.body.messages.find(message=>message.role==='system')?.content??'');
  if(system.includes('You are helper ')){childCalls++;return {text:'NATIVE_OUTPUT_PROBE'};}
  if(n===1)return tool('start_work',{reason:'Check denied absolute native outputs',scope:readOnly?[]:['allowed.txt'],readScope:['.']});
  phase++;
  if(phase===1)return tool('subagents_enable');
  if(phase===2)return tool('subagent',{agent:'native-local',task:'Return NATIVE_OUTPUT_PROBE',model:'fixture/main',async:false,output:false});
  if(phase===3){
    helperId=hostResult(call.body);const helper=active.record.work.helpers[0],context=active.record.tools.find(trace=>trace.kind==='native_plugin_context');
    targets=[join(helper.directory,'runtime/pi/auth.json'),join(helper.cwd,'a.txt'),join(context.cwd,'a.txt')];
    baseline=targets.map(path=>readFileSync(path));
  }
  const index=phase-3;
  if(index>0&&index<=targets.length){assert.match(String(call.body.messages.at(-1).content),/Native output/);assert.equal(childCalls,1);}
  if(index<targets.length)return tool('subagent',{agent:'native-local',task:'Return unapproved replacement text',model:'fixture/main',async:false,output:targets[index]});
  if(index===targets.length)return tool('cothink_helper_result',{helperId,decision:'adopt',reason:'Read-only probe text reviewed; forbidden outputs were rejected without a launch'});
  return {text:'Absolute native private/sibling/out-of-scope outputs were refused'};
 });
 const installed=await invoke(f,['install','npm:pi-subagents@0.84.0','--json']);assert.equal(installed.code,0,installed.stdout+installed.stderr);
 mkdirSync(join(f.home,'pi/agents'),{recursive:true});writeFileSync(join(f.home,'pi/agents/native-local.md'),'---\nname: native-local\ndescription: native output probe\nmodel: fixture/main\ntools: read, ls\nsystemPromptMode: replace\ninheritProjectContext: false\ninheritGlobalContext: false\ninheritSkills: false\n---\nReturn the requested text.\n');
 const task=await runTurn({home:f.home,cwd:repo.project,input:'/one inspect forbidden native output paths without changing source',config:{formatVersion:2,...f.models,work:{execution,checks:[]}},onProgress:event=>{active=event.task??active;}});
 assert.equal(task.record.status,'completed',task.record.error);assert.equal(childCalls,1);assert.equal(task.record.work.helpers.length,1);
 for(let i=0;i<targets.length;i++)assert.deepEqual(readFileSync(targets[i]),baseline[i],targets[i]);
});

test('native child stop aborts its Docker tool signal while unrelated helper and parent stay live',{timeout:60000},async t=>{
 const repo=repository(t),controller=new AbortController();let active,phase=0,releaseUnrelated;
 const held=new Promise(resolve=>releaseUnrelated=resolve);
 const f=await fixture(t,async(call,n)=>{
   const system=String(call.body.messages.find(message=>message.role==='system')?.content??'');
   if(system.includes('You are helper ')) {
     if(system.includes('<active_agent name="native-slow"/>'))return tool('bash',{command:'printf READY > native-stop-ready; sleep 60; printf FORBIDDEN_LATE > late.txt'});
     if(call.body.messages.at(-1).role==='user'){await held;return tool('write',{path:'unrelated.txt',content:'UNRELATED_SURVIVED'});}
     return {text:'Unrelated helper completed after scoped native child stop'};
   }
   if(n===1)return tool('start_work',{reason:'Scoped native child stop',scope:['late.txt','unrelated.txt','native-stop-ready'],readScope:['.']});
   phase++;
   if(phase===1)return tool('subagents_enable');
   if(phase===2)return {toolCalls:[{name:'subagent',args:{agent:'native-slow',task:'Run delayed owned Docker command',model:'fixture/main',async:false,output:false}},{name:'cothink_helper',args:{assignment:'UNRELATED: create unrelated.txt after independent native stop'}}]};
   if(phase===3)return tool('cothink_helper_result',{helperId:active.record.work.helpers.find(helper=>helper.native).helperId,decision:'reject',reason:'Native child deliberately stopped; no late file result is adopted'});
   if(phase===4)return tool('cothink_helper_result',{helperId:active.record.work.helpers.find(helper=>!helper.native).helperId,decision:'adopt',reason:'Unrelated helper remained live and its exact file result is reviewed'});
   if(phase===5||phase===6)return tool('accept_change');
   return {text:'Only native child stopped; unrelated result checked and accepted'};
 });
 const installed=await invoke(f,['install','npm:pi-subagents@0.84.0','--json']);assert.equal(installed.code,0,installed.stdout+installed.stderr);
 const abortExtension=join(f.home,'native-child-abort.mjs');writeFileSync(abortExtension,`import{existsSync,writeFileSync}from'node:fs';import{join}from'node:path';export default pi=>{let timer;pi.on('tool_call',(event,ctx)=>{if(event.toolName!=='bash')return;const poll=()=>{if(existsSync(join(ctx.cwd,'native-stop-ready'))){writeFileSync(${JSON.stringify(join(f.home,'native-abort-fired'))},'called');ctx.abort();writeFileSync(${JSON.stringify(join(f.home,'native-abort-after'))},'called');return;}timer=setTimeout(poll,10);};poll();});pi.on('session_shutdown',()=>clearTimeout(timer));};`);
 mkdirSync(join(f.home,'pi/agents'),{recursive:true});writeFileSync(join(f.home,'pi/agents/native-slow.md'),'---\nname: native-slow\ndescription: native scoped stop fixture\nmodel: fixture/main\ntools: bash\nsystemPromptMode: replace\ninheritProjectContext: false\ninheritGlobalContext: false\ninheritSkills: false\n---\nRun the requested command once.\n');
 const requireExtension=join(f.home,'require-native-abort.mjs');writeFileSync(requireExtension,`import{registerRequiredChildExtensions}from ${JSON.stringify(join(f.home,'pi/npm/node_modules/pi-subagents/bundle/required-child-extensions.js'))};export default pi=>{let registration;pi.on('session_start',(_,ctx)=>{registration=registerRequiredChildExtensions({sessionId:ctx.sessionManager.getSessionId(),requireForAllRunners:true,extensions:[{id:'native-abort-fixture',path:${JSON.stringify(abortExtension)}}]});});pi.on('session_shutdown',()=>registration?.dispose());};`);
 const running=runTurn({home:f.home,cwd:repo.project,input:'/one stop only native slow child while unrelated helper completes',config:{formatVersion:2,...f.models,piResources:{extensions:[requireExtension]},work:{execution,checks:[{command:'node',args:['-e',"const f=require('fs');if(f.existsSync('late.txt')||f.readFileSync('unrelated.txt','utf8')!=='UNRELATED_SURVIVED')process.exit(1)"]}]}},signal:controller.signal,onProgress:event=>{active=event.task??active;}});
 running.catch(()=>{});t.after(async()=>{if(active?.record.status==='running')controller.abort();releaseUnrelated();await running.catch(()=>{});});
 const deadline=Date.now()+20000;let child,container;
 for(;;) {
   child=active?.record.work?.helpers?.find(helper=>helper.native);container=child?.executions?.find(command=>command.status==='running')?.id;
   if(container&&existsSync(join(child.cwd,'native-stop-ready')))break;
   if(!container&&child?.executions?.[0]?.id&&existsSync(join(child.cwd,'native-stop-ready'))){container=child.executions[0].id;break;}
   if(Date.now()>deadline)throw Error('Native owned Docker command did not reach ready state');await new Promise(resolve=>setTimeout(resolve,20));
 }
 const stopDeadline=Date.now()+10000;
 for(;;){try{execFileSync('docker',['inspect',container],{stdio:'pipe'});}catch{break;}if(Date.now()>stopDeadline){console.log('abort fixture evidence',existsSync(join(f.home,'native-abort-fired')),existsSync(join(f.home,'native-abort-after')),child.shutdownEvidence,child.executions);throw Error('Native child stop did not terminate its Docker command');}await new Promise(resolve=>setTimeout(resolve,20));}
 assert.equal(active.signal.aborted,false);assert.equal(active.record.status,'running');
 const unrelated=active.record.work.helpers.find(helper=>!helper.native);assert.ok(unrelated);assert.equal(unrelated.cancelRequestedAt,undefined);
 releaseUnrelated();const task=await running;
 assert.equal(task.record.status,'completed',task.record.error);assert.ok(child.stoppedAt);assert.notEqual(child.status,'outcome_unknown');assert.equal(child.executions[0].status,'failed');
 assert.equal(unrelated.status,'completed');assert.equal(unrelated.treatment.decision,'adopted');assert.equal(task.record.work.acceptance.at(-1).status,'accepted');
});

for(const entry of ['CLI','GUI'])test(`native detached background ${entry} returns before child completion, status and reviewed Docker acceptance`,{timeout:60000},async t=>{
 const repo=repository(t);let phase=0,runId,childId,controllerId,release,childEntered=false,parentContinued=false;
 const held=new Promise(resolve=>release=resolve);t.after(()=>release());
 const f=await fixture(t,async(call,n)=>{
  const system=String(call.body.messages.find(m=>m.role==='system')?.content??'');
  if(system.includes('You are helper ')) {
   childEntered=true;
   if(call.body.messages.at(-1).role==='user'){await held;return tool('write',{path:'background.txt',content:'NATIVE_BACKGROUND'});}
   return {text:'Native detached child wrote background.txt'};
  }
  if(n===1)return tool('start_work',{reason:'Actual detached native background',scope:['background.txt'],readScope:['.']});
  phase++;
  if(phase===1)return tool('subagents_enable');
  if(phase===2)return tool('subagent',{agent:'native-local',task:'Write background.txt=NATIVE_BACKGROUND',model:'fixture/main',async:true,options:{context:'fresh'},artifacts:false});
  if(phase===3){const output=String(call.body.messages.at(-1).content);console.log('background native receipt',output);runId=output.match(/Async: native-local \[([^\]]+)\]/)?.[1];assert.ok(runId,output);parentContinued=true;
   const {readdirSync}=await import('node:fs');const taskFile=readdirSync(join(f.home,'tasks')).find(name=>name.endsWith('.json'));const saved=JSON.parse(readFileSync(join(f.home,'tasks',taskFile),'utf8'));const runner=saved.tools.find(t=>t.nativeBackground);
   const {spawn}=await import('node:child_process');const duplicate=spawn(runner.process.spawnfile,runner.process.spawnargs.slice(1),{cwd:runner.cwd,stdio:['ignore','pipe','pipe']});let error='';duplicate.stderr.on('data',b=>error+=b);const code=await new Promise(resolve=>duplicate.once('close',resolve));assert.notEqual(code,0);assert.match(error,/already bound/);console.log('duplicate original runner denied before SDK');
   return tool('read',{path:'a.txt'});}
  if(phase===4){assert.match(JSON.stringify(call.body.messages.at(-1)),/base A/);release();return tool('subagent',{action:'status',id:runId});}
  const {readdirSync}=await import('node:fs');const taskFile=readdirSync(join(f.home,'tasks')).find(name=>name.endsWith('.json'));
  const record=JSON.parse(readFileSync(join(f.home,'tasks',taskFile),'utf8')),child=record.work.helpers.find(h=>h.native),controller=record.tools.find(h=>h.nativeBackground);
  if(!child?.stoppedAt||!controller?.stoppedAt){if(phase>30)throw Error('Background did not settle: '+JSON.stringify({child,controller}));await new Promise(resolve=>setTimeout(resolve,100));return tool('subagent',{action:'status',id:runId});}
  childId=child.helperId;controllerId=controller.helperId;
  if(!child.treatment)return tool('cothink_helper_result',{helperId:childId,decision:'adopt',reason:'Reviewed actual detached child exact background.txt diff'});
  if(!controller.treatment)return tool('cothink_helper_result',{helperId:controllerId,decision:'reject',reason:'Native controller artifacts are not source changes'});
  if(!record.work.acceptance?.length)return tool('accept_change');
  return {text:'Background native file reviewed and formally accepted'};
 });
 const installed=await invoke(f,['install','npm:pi-subagents@0.84.0','--json']);assert.equal(installed.code,0,installed.stderr);
 mkdirSync(join(f.home,'pi/agents'),{recursive:true});writeFileSync(join(f.home,'pi/agents/native-local.md'),'---\nname: native-local\ndescription: native detached fixture\nmodel: fixture/main\ntools: read, write, edit, ls, bash\nsystemPromptMode: replace\ninheritProjectContext: false\ninheritGlobalContext: false\ninheritSkills: false\n---\nComplete the assigned file.\n');
 saveConfig(f.home,{formatVersion:2,...f.models,work:{execution,checks:[{command:'node',args:['-e',"if(require('fs').readFileSync('background.txt','utf8')!=='NATIVE_BACKGROUND')process.exit(1)"]}]}});
 let run;
 if(entry==='CLI')run=await invoke(f,['ask','--json','/one create background.txt using native detached background and review its result'],'',repo.project);
 else {
  const {createTeamConfig}=await import('../../src/teams.js'),{createGuiController}=await import('../../src/gui-controller.js'),{readTask}=await import('../../src/task.js');
  saveConfig(f.home,createTeamConfig({formatVersion:2,...f.models,work:{execution,checks:[{command:'node',args:['-e',"if(require('fs').readFileSync('background.txt','utf8')!=='NATIVE_BACKGROUND')process.exit(1)"]}]}},'GUI native background','7c8094cd-3476-4bfa-8f53-055d87972896'));
  const controller=await createGuiController({home:f.home,cwd:repo.project});t.after(()=>controller.close());const session=await controller.action('session.create',{project:repo.project});await controller.action('session.mode',{sessionId:session.id,mode:'one'});const submitted=await controller.action('task.submit',{sessionId:session.id,input:'create background.txt using native detached background and review its result',submissionId:'native-background-gui'});
  let final;for(let i=0;i<2000;i++){final=await controller.task(submitted.taskId);if(final.status!=='running')break;await new Promise(r=>setTimeout(r,10));}
  run={code:final.status==='completed'?0:1,stdout:JSON.stringify({task:readTask(f.home,submitted.taskId)}),stderr:final.error??''};await controller.close();
 }
 const task=JSON.parse(run.stdout).task;console.log('background final',JSON.stringify({code:run.code,status:task.status,error:task.error,helpers:task.work.helpers.map(h=>({id:h.helperId,status:h.status,error:h.error,resultError:h.resultError})),background:task.tools.filter(t=>t.nativeBackground).map(r=>({id:r.runnerId,status:r.status,process:r.process,close:r.processClose}))}));
 assert.equal(run.code,0,run.stderr);assert.ok(childEntered&&parentContinued);assert.equal(task.work.helpers[0].treatment.decision,'adopted');assert.ok(task.tools.find(t=>t.nativeBackground).processClose);assert.equal(task.work.acceptance.at(-1).status,'accepted');assert.equal(readFileSync(join(task.work.resultWorkspace,'background.txt'),'utf8'),'NATIVE_BACKGROUND');
});

test('native detached nested late admission preserves A after parent writes C and rejects stale import',{timeout:60000},async t=>{
 const repo=repository(t);let phase=0,release,firstEntered=false,workerCalls=0,nestedCalls=0,runId,staleObserved=false,adoptAttempted=false,nestedIds=[],parallelArrivals=0,parallelRelease;
 const parallel=new Promise(r=>parallelRelease=r);
 writeFileSync(join(repo.project,'background-parallel.js'),'return runs.all([{key:"writer",agent:"native-local",task:"Read a.txt from original A then write background.txt=NESTED_A",async:false},{key:"reader",agent:"native-local",task:"TEXT_ONLY parallel reader",async:false}]);');
 git(repo.project,'status','--porcelain');git(repo.project,'add','--','background-parallel.js');git(repo.project,'commit','-m','original background parallel workflow fixture');
 const held=new Promise(resolve=>release=resolve);t.after(()=>release());
 const f=await fixture(t,async(call,n)=>{
  const system=String(call.body.messages.find(m=>m.role==='system')?.content??'');
  if(system.includes('You are helper ')){
   if(system.includes('<active_agent name="native-parent"/>')){
    workerCalls++;firstEntered=true;
    if(workerCalls===1){await held;return tool('subagent',{action:'status',id:runId});}
    if(workerCalls===2){assert.match(String(call.body.messages.at(-1).content),/does not belong/);return tool('subagent',{action:'stop',id:runId});}
    if(workerCalls===3){assert.match(String(call.body.messages.at(-1).content),/does not belong/);return tool('subagent',{workflow:'./background-parallel.js',model:'fixture/main',async:false});}
    if(workerCalls===4){for(const line of String(call.body.messages.at(-1).content).split('\n').toReversed())try{const value=JSON.parse(line);if(value.nativeHostResults){nestedIds=value.nativeHostResults.map(h=>h.helperId);break;}}catch{}assert.equal(nestedIds.length,2);}
    if(workerCalls===4||workerCalls===5)return tool('cothink_helper_result',{helperId:nestedIds[workerCalls-4],decision:workerCalls===4?'adopt':'reject',reason:workerCalls===4?'Creator reviewed exact parallel writer A result':'Parallel text-only reader reviewed; no files to import after writer changed creator overlay'});
    return {text:'Background creator adopted nested A result'};
   }
   if(call.body.messages.at(-1).role==='user'){parallelArrivals++;if(parallelArrivals===2)parallelRelease();await parallel;}
   if(JSON.stringify(call.body.messages.filter(m=>m.role==='user')).includes('TEXT_ONLY'))return {text:'Parallel reader completed'};
   nestedCalls++;if(nestedCalls===1)return tool('read',{path:'a.txt'});
   if(nestedCalls===2){assert.match(JSON.stringify(call.body.messages.at(-1)),/base A/);assert.doesNotMatch(JSON.stringify(call.body.messages.at(-1)),/CURRENT_C/);return tool('write',{path:'background.txt',content:'NESTED_A'});}
   return {text:'Late child retained A'};
  }
  if(n===1)return tool('start_work',{reason:'Native background stale copy test',scope:['a.txt','background.txt'],readScope:['.']});phase++;
  if(phase===1)return tool('subagents_enable');
  if(phase===2)return tool('subagent',{agent:'native-parent',task:'Wait then use original nested child and adopt it',async:true,model:'fixture/main',options:{context:'fresh'},artifacts:false});
  if(phase===3){runId=String(call.body.messages.at(-1).content).match(/Async: native-parent \[([^\]]+)\]/)?.[1];assert.ok(runId);while(!firstEntered)await new Promise(r=>setTimeout(r,10));return tool('read',{path:'a.txt'});}
  if(phase===4)return tool('write',{path:'a.txt',content:'CURRENT_C'});
  if(phase===5){console.log('parent C write',call.body.messages.at(-1).content);release();return tool('subagent',{action:'status',id:runId});}
  const {readdirSync}=await import('node:fs');const taskFile=readdirSync(join(f.home,'tasks')).find(name=>name.endsWith('.json')),record=JSON.parse(readFileSync(join(f.home,'tasks',taskFile),'utf8'));
  const child=record.work.helpers.find(h=>!h.parentHelperId),runner=record.tools.find(r=>r.nativeBackground);
  if(!child?.stoppedAt||!runner?.stoppedAt){if(phase>35)throw Error('Late native child did not stop');await new Promise(r=>setTimeout(r,100));return tool('subagent',{action:'status',id:runId});}
  if(!adoptAttempted){adoptAttempted=true;return tool('cothink_helper_result',{helperId:child.helperId,decision:'adopt',reason:'Try reviewed A result against parent C; must reject stale version'});}
  if(!staleObserved){console.log('stale import response',call.body.messages.at(-1).content);assert.match(String(call.body.messages.at(-1).content),/STALE|旧|过期|version|版本/i);staleObserved=true;}
  if(!child.treatment)return tool('cothink_helper_result',{helperId:child.helperId,decision:'reject',reason:'A result is stale after actual parent C edit; preserve it without overwriting C'});
  if(!record.work.acceptance?.length)return tool('accept_change');return {text:'Preserved C, rejected stale A output'};
 });
 const installed=await invoke(f,['install','npm:pi-subagents@0.84.0','--json']);assert.equal(installed.code,0,installed.stderr);
 mkdirSync(join(f.home,'pi/agents'),{recursive:true});for(const name of ['native-parent','native-local'])writeFileSync(join(f.home,'pi/agents',name+'.md'),'---\nname: '+name+'\ndescription: native nested background\nmodel: fixture/main\ntools: read, write, edit, ls'+(name==='native-parent'?', subagent':'')+'\nallowNestedSubagents: '+(name==='native-parent')+'\nsystemPromptMode: replace\ninheritProjectContext: false\ninheritGlobalContext: false\ninheritSkills: false\n---\nUse assigned native route and review children.\n');
 saveConfig(f.home,{formatVersion:2,...f.models,work:{execution,checks:[{command:'node',args:['-e',"const f=require('fs');if(f.readFileSync('a.txt','utf8')!=='CURRENT_C'||f.existsSync('background.txt'))process.exit(1)"]}]}});
 const run=await invoke(f,['ask','--json','/one use native background while changing a.txt, reject stale result'],'',repo.project);const task=JSON.parse(run.stdout).task;
 console.log('late native summary',JSON.stringify({code:run.code,status:task.status,error:task.error,helpers:task.work.helpers.map(h=>({id:h.helperId,status:h.status,error:h.error,text:h.text,resultError:h.resultError}))}));
 assert.equal(run.code,0,run.stderr);assert.ok(staleObserved);assert.equal(task.work.helpers.length,3);assert.equal(parallelArrivals,2);assert.equal(task.work.helpers[1].snapshot.inputVersion,task.work.helpers[0].snapshot.inputVersion);assert.equal(readFileSync(join(task.work.resultWorkspace,'a.txt'),'utf8'),'CURRENT_C');assert.equal(readFileSync(join(repo.project,'a.txt'),'utf8'),'base A\n');
});

for(const failureMode of ['stop','503'])test(`native detached ${failureMode} has no automatic replay and retains safe parent acceptance`,{timeout:60000},async t=>{
 const repo=repository(t);let phase=0,runId,release,entered=false,stopRequested=false,childRequests=0;
 const held=new Promise(resolve=>release=resolve);t.after(()=>release());
 const f=await fixture(t,async(call,n)=>{
  const system=String(call.body.messages.find(m=>m.role==='system')?.content??'');
  if(system.includes('You are helper ')){entered=true;childRequests++;if(failureMode==='503')return {error:503};await held;return tool('write',{path:'background.txt',content:'LATE_CHILD_OUTPUT'});}
  if(n===1)return tool('start_work',{reason:'Native stop and late output',scope:['background.txt'],readScope:['.']});phase++;
  if(phase===1)return tool('subagents_enable');
  if(phase===2)return tool('subagent',{agent:'native-local',task:'Delayed native work',async:true,model:'fixture/main',artifacts:false,options:{context:'fresh'}});
  if(phase===3){runId=String(call.body.messages.at(-1).content).match(/Async: native-local \[([^\]]+)\]/)?.[1];assert.ok(runId);if(failureMode==='503')return tool('subagent',{action:'status',id:runId});while(!entered)await new Promise(r=>setTimeout(r,10));return tool('subagent',{action:'stop',id:'00000000-0000-4000-8000-000000000000'});}
  if(phase===4&&failureMode==='503')return tool('subagent',{action:'status',id:runId});
  if(phase===4){assert.match(String(call.body.messages.at(-1).content),/does not belong/);stopRequested=true;return tool('subagent',{action:'stop',id:runId});}
  const {readdirSync}=await import('node:fs');const taskFile=readdirSync(join(f.home,'tasks')).find(name=>name.endsWith('.json')),record=JSON.parse(readFileSync(join(f.home,'tasks',taskFile),'utf8'));
  const child=record.work.helpers[0],runner=record.tools.find(r=>r.nativeBackground);
  if(!child?.stoppedAt||!runner?.stoppedAt){if(phase>35)throw Error('Native stop did not settle');await new Promise(r=>setTimeout(r,100));return tool('subagent',{action:'status',id:runId});}
  release();
  if(!child.treatment)return tool('cothink_helper_result',{helperId:child.helperId,decision:'reject',reason:'Original native stop completed; delayed provider output is not a valid delivered result'});
  if(!record.work.acceptance?.length){if(!record.work.helpers[0].result?.edits.length&&!record.tools.some(t=>t.name==='write'))return tool('write',{path:'background.txt',content:'PARENT_AFTER_STOP'});return tool('accept_change');}
  return {text:'Stopped native child; retained only reviewed parent result'};
 });
 const installed=await invoke(f,['install','npm:pi-subagents@0.84.0','--json']);assert.equal(installed.code,0,installed.stderr);
 mkdirSync(join(f.home,'pi/agents'),{recursive:true});writeFileSync(join(f.home,'pi/agents/native-local.md'),'---\nname: native-local\ndescription: native stop fixture\nmodel: fixture/main\ntools: read, write, edit\nsystemPromptMode: replace\ninheritProjectContext: false\ninheritGlobalContext: false\ninheritSkills: false\n---\nDo assigned work.\n');
 saveConfig(f.home,{formatVersion:2,...f.models,work:{execution,checks:[{command:'node',args:['-e',"if(require('fs').readFileSync('background.txt','utf8')!=='PARENT_AFTER_STOP')process.exit(1)"]}]}});
 const run=await invoke(f,['ask','--json','/one start and stop native background, then write the parent result'],'',repo.project);const task=JSON.parse(run.stdout).task;
 console.log('native stop summary',JSON.stringify({code:run.code,status:task.status,error:task.error,helpers:task.work.helpers.map(h=>({status:h.status,stoppedAt:h.stoppedAt,resultError:h.resultError}))}));
 assert.equal(run.code,0,run.stderr);assert.ok(stopRequested||failureMode==='503');assert.equal(childRequests,1);assert.equal(task.work.helpers.length,1);assert.equal(task.work.helpers[0].result.edits.length,0);assert.equal(task.work.helpers[0].treatment.decision,'rejected');assert.equal(readFileSync(join(task.work.resultWorkspace,'background.txt'),'utf8'),'PARENT_AFTER_STOP');
});

test('native owner loss during Docker preserves unknown and blocks package replacement without replay',{timeout:60000},async t=>{
 const repo=repository(t);let phase=0,record,readyResolve,releaseParent;
 const ready=new Promise(r=>readyResolve=r),parentHeld=new Promise(r=>releaseParent=r);t.after(()=>releaseParent());
 const f=await fixture(t,async(call,n)=>{
  const system=String(call.body.messages.find(m=>m.role==='system')?.content??'');
  if(system.includes('You are helper '))return tool('bash',{command:'printf READY > ready; sleep 20; printf LATE_DOCKER > background.txt'});
  if(n===1)return tool('start_work',{reason:'Host loss during owned Docker',scope:['ready','background.txt'],readScope:['.']});phase++;
  if(phase===1)return tool('subagents_enable');
  if(phase===2)return tool('subagent',{agent:'native-local',task:'Run delayed Docker work',async:true,model:'fixture/main',artifacts:false,options:{context:'fresh'}});
  readyResolve();await parentHeld;return {text:'Host was killed; no reply should be consumed'};
 });
 const installed=await invoke(f,['install','npm:pi-subagents@0.84.0','--json']);assert.equal(installed.code,0,installed.stderr);
 mkdirSync(join(f.home,'pi/agents'),{recursive:true});writeFileSync(join(f.home,'pi/agents/native-local.md'),'---\nname: native-local\ndescription: native host loss fixture\nmodel: fixture/main\ntools: read, write, bash\nsystemPromptMode: replace\ninheritProjectContext: false\ninheritGlobalContext: false\ninheritSkills: false\n---\nRun the assigned Docker command.\n');
 saveConfig(f.home,{formatVersion:2,...f.models,work:{execution,checks:[{command:'node',args:['-e','process.exit(0)']}]}});
 const {spawn,execFile}=await import('node:child_process'),{promisify}=await import('node:util'),{readdirSync,existsSync}=await import('node:fs');
 const child=spawn(process.execPath,[join(process.cwd(),'bin/cothink.js'),'ask','--json','/one start native background Docker work'],{cwd:repo.project,env:{...process.env,COTHINK_HOME:f.home,PI_OFFLINE:'1',COTHINK_NO_TTY:'1'},stdio:['ignore','pipe','pipe']});let output='',error='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>error+=b);const closed=new Promise(r=>child.once('close',r));t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
 await ready;
 for(let i=0;i<1000;i++){const file=readdirSync(join(f.home,'tasks')).find(n=>n.endsWith('.json'));record=JSON.parse(readFileSync(join(f.home,'tasks',file),'utf8'));const h=record.work.helpers[0];if(h?.executions?.some(e=>e.status==='running')&&existsSync(join(h.cwd,'ready')))break;await new Promise(r=>setTimeout(r,10));}
 const helper=record.work.helpers[0],executionId=helper.executions.find(e=>e.status==='running').id;
 t.after(async()=>{await promisify(execFile)('docker',['rm','-f',executionId]).catch(()=>{});});
 child.kill('SIGKILL');await closed;
 const count=f.calls.length,{readTask}=await import('../../src/task.js'),{assertNoActivePiSessions}=await import('../../src/storage.js');
 const recovered=readTask(f.home,record.id);assert.equal(recovered.status,'outcome_unknown');assert.equal(recovered.work.helpers[0].status,'outcome_unknown');assert.ok(recovered.tools.find(t=>t.nativeBackground&&!t.stoppedAt));assert.throws(()=>assertNoActivePiSessions(f.home),/active or unknown/);
 const shown=await invoke(f,['show',record.id,'--json']);assert.equal(shown.code,0,shown.stderr);assert.equal(f.calls.length,count);
 const docker=await promisify(execFile)('docker',['inspect','--format','{{.State.Running}}',executionId]);assert.match(docker.stdout,/true/);
 console.log('owner-loss evidence',JSON.stringify({taskId:record.id,executionId,actualContainerStillRunning:true,status:recovered.status,packageBlocked:true,reopenCalls:f.calls.length-count}));
 await promisify(execFile)('docker',['rm','-f',executionId]);releaseParent();
});

for(const startupFailure of ['none','save-once'])test(`native background cancellation during actual SDK startup (${startupFailure}) never sends a child model request`,{timeout:60000},async t=>{
 const repo=repository(t);const {runTurn}=await import('../../src/discussion.js');const controller=new AbortController();let active,phase=0,childRequests=0,release;
 const held=new Promise(r=>release=r);t.after(()=>release());
 const f=await fixture(t,async(call,n)=>{
  const system=String(call.body.messages.find(m=>m.role==='system')?.content??'');if(system.includes('You are helper ')){childRequests++;return {text:'Must not execute'};}
  if(n===1)return tool('start_work',{reason:'Cancel native SDK startup',scope:['background.txt'],readScope:['.']});phase++;
  if(phase===1)return tool('subagents_enable');if(phase===2)return tool('subagent',{agent:'native-local',task:'Do not call model after startup cancellation',async:true,model:'fixture/main',output:false});await held;return {text:'Cancelled'};
 });
 const installed=await invoke(f,['install','npm:pi-subagents@0.84.0','--json']);assert.equal(installed.code,0,installed.stderr);
 mkdirSync(join(f.home,'pi/agents'),{recursive:true});writeFileSync(join(f.home,'pi/agents/native-local.md'),'---\nname: native-local\ndescription: native startup fixture\nmodel: fixture/main\ntools: read, write\nsystemPromptMode: replace\ninheritProjectContext: false\ninheritGlobalContext: false\ninheritSkills: false\n---\nPerform assigned work.\n');
 const marker=join(f.home,'startup-entered'),gate=join(f.home,'startup-release'),extension=join(f.home,'startup-delay.mjs'),required=join(f.home,'require-startup-delay.mjs');
 writeFileSync(extension,`import{existsSync,writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'entered');while(!existsSync(${JSON.stringify(gate)}))await new Promise(r=>setTimeout(r,10));export default()=>{};`);
 writeFileSync(required,`import{registerRequiredChildExtensions}from ${JSON.stringify(join(f.home,'pi/npm/node_modules/pi-subagents/bundle/required-child-extensions.js'))};export default pi=>{let registration;pi.on('session_start',(_,ctx)=>{registration=registerRequiredChildExtensions({sessionId:ctx.sessionManager.getSessionId(),requireForAllRunners:true,extensions:[{id:'startup-delay',path:${JSON.stringify(extension)}}]});});pi.on('session_shutdown',()=>registration?.dispose());};`);
 const running=runTurn({home:f.home,cwd:repo.project,input:'/one start native background then cancel during startup',config:{formatVersion:2,...f.models,piResources:{extensions:[required]},work:{execution,checks:[{command:'node',args:['-e','process.exit(0)']}]}},signal:controller.signal,onProgress:event=>{active=event.task??active;}});running.catch(()=>{});t.after(async()=>{controller.abort();if(existsSync(f.home))writeFileSync(gate,'release');release();await running.catch(()=>{});});
 const {existsSync}=await import('node:fs');for(let i=0;!existsSync(marker);i++){if(i>2000)throw Error('Actual child extension startup did not enter');await new Promise(r=>setTimeout(r,10));}
 assert.ok(active.record.work.helpers[0].native.startClaim);assert.equal(childRequests,0);
 if(startupFailure==='none'){
  const context=active.record.tools.find(t=>t.kind==='native_plugin_context'),stage=active.record.stages.findLast(s=>s.sessionFile),parentSessionId=JSON.parse(readFileSync(stage.sessionFile,'utf8').split('\n')[0]).id;
  const {pathToFileURL}=await import('node:url'),{admitHostOperation}=await import(pathToFileURL(join(f.home,'pi/npm/node_modules/pi-subagents/src/runs/shared/host-integration.js'))),before=active.record.tools.length;
  await assert.rejects(admitHostOperation({kind:'request',cwd:context.cwd,parentSessionId,nativeParams:{action:'resume',id:active.record.tools.find(t=>t.nativeBackground).nativeRunId,message:'Must not attach chain',chain:[{agent:'native-local',task:'No new child'}]}}),{code:'NATIVE_RESUME_CHAIN'});
  assert.equal(active.record.tools.length,before);assert.equal(active.record.work.helpers.length,1);assert.equal(childRequests,0);console.log('Public native attached-chain admission denied before new intent/fork/spawn');
 }
 if(startupFailure==='save-once'){const save=active.save;active.save=()=>{active.save=save;throw Error('injected cleanup save failure');};const closing=active.helperLifecycle.close();writeFileSync(gate,'release');await assert.rejects(closing,/cleanup incomplete/);controller.abort();release();}
 else {controller.abort();writeFileSync(gate,'release');release();}
 const task=await running;assert.notEqual(task.record.status,'completed');assert.equal(childRequests,0);const runner=task.record.tools.find(t=>t.nativeBackground);assert.ok(runner.processClose);console.log('startup cancel evidence',JSON.stringify({status:task.record.status,childRequests,runnerStatus:runner.status,close:runner.processClose,helperStatus:task.record.work.helpers[0].status}));
});

for(const resumeMode of ['action','workflow'])test(`explicit native resume ${resumeMode} forks a stopped handled session into a new admitted attempt`,{timeout:60000},async t=>{
 const repo=repository(t);
 if(resumeMode==='workflow'){writeFileSync(join(repo.project,'resume-workflow.js'),'return runs.run("resumed",{resume:args.id,task:"RESUME_FEEDBACK: write resumed.txt=EXPLICIT_RESUME",output:false});');git(repo.project,'status','--porcelain');git(repo.project,'add','--','resume-workflow.js');git(repo.project,'commit','-m','original workflow resume shorthand fixture');}
 let phase=0,firstRun,resumeRun,resumeRequested=false,childRequests=0,originalSession,chainProbeDone=false;
 const f=await fixture(t,async(call,n)=>{
  const system=String(call.body.messages.find(m=>m.role==='system')?.content??'');
  if(system.includes('You are helper ')){childRequests++;if(JSON.stringify(call.body.messages.at(-1)).includes('RESUME_FEEDBACK')){assert.match(JSON.stringify(call.body.messages),/FIRST_CONTEXT_TOKEN/);return tool('write',{path:'resumed.txt',content:'EXPLICIT_RESUME'});}return {text:resumeRequested?'Resumed file produced':'FIRST_CONTEXT_TOKEN'};}
  if(n===1)return tool('start_work',{reason:'Explicit original native resume',scope:['resumed.txt'],readScope:['.']});phase++;
  if(phase===1)return tool('subagents_enable');if(phase===2)return tool('subagent',{agent:'native-local',task:'Return FIRST_CONTEXT_TOKEN',async:true,model:'fixture/main',output:false});
  if(phase===3){firstRun=String(call.body.messages.at(-1).content).match(/Async: native-local \[([^\]]+)\]/)?.[1];assert.ok(firstRun);return tool('subagent',{action:'resume',id:firstRun,message:'UNHANDLED_MUST_NOT_REPLAY'});}
  if(phase===4){assert.match(String(call.body.messages.at(-1).content),/requires an original owned stopped/);return tool('subagent',{action:'status',id:firstRun});}
  const {readdirSync}=await import('node:fs');const file=readdirSync(join(f.home,'tasks')).find(n=>n.endsWith('.json')),record=JSON.parse(readFileSync(join(f.home,'tasks',file),'utf8'));
  const first=record.work.helpers[0],runners=record.tools.filter(t=>t.nativeBackground);
  if(!resumeRequested){if(!first?.stoppedAt||!runners[0].stoppedAt){await new Promise(r=>setTimeout(r,100));return tool('subagent',{action:'status',id:firstRun});}if(!first.treatment){originalSession=readFileSync(first.native.sessionFile);return tool('cothink_helper_result',{helperId:first.helperId,decision:'reject',reason:'First text-only result reviewed; explicit next feedback will be a separate attempt'});}if(!chainProbeDone){chainProbeDone=true;return tool('subagent',{action:'resume',id:firstRun,message:'CHAIN_MUST_NOT_START',chain:[{agent:'native-local',task:'Forbidden attached child'}],output:false});}console.log('attached resume chain rejected',call.body.messages.at(-1).content);assert.match(String(call.body.messages.at(-1).content),/one stopped child only|legacy|chain|Unsupported/i);assert.equal(record.work.helpers.length,1);assert.equal(runners.length,1);assert.equal(childRequests,1);resumeRequested=true;return resumeMode==='workflow'?tool('subagent',{workflow:'./resume-workflow.js',args:{id:firstRun},async:false}):tool('subagent',{action:'resume',id:firstRun,message:'RESUME_FEEDBACK: write resumed.txt=EXPLICIT_RESUME',output:false});}
  if(!resumeRun){const raw=call.body.messages.filter(m=>m.role==='tool').at(-1)?.content;const content=typeof raw==='string'?raw:JSON.stringify(raw);console.log('native resume receipt',content);resumeRun=content.match(/Async: native-local \[([^\]]+)\]/)?.[1]??content.match(/(?:run|id)[: ]+([a-f0-9-]{36})/i)?.[1];if(resumeMode==='workflow'){assert.match(content,/Workflow completed/);resumeRun=runners.at(-1).nativeRunId;}assert.ok(resumeRun,content);assert.notEqual(resumeRun,firstRun);}
  const second=record.work.helpers[1];if(!second?.stoppedAt||!runners[1]?.stoppedAt){if(phase>35)throw Error('Resumed native attempt did not stop');await new Promise(r=>setTimeout(r,100));return tool('subagent',{action:'status',id:resumeRun});}
  if(!second.treatment)return tool('cothink_helper_result',{helperId:second.helperId,decision:'adopt',reason:'Reviewed separately admitted explicit-resume file diff'});
  if(!record.work.acceptance?.length)return tool('accept_change');return {text:'Explicit native continuation reviewed and accepted'};
 });
 const installed=await invoke(f,['install','npm:pi-subagents@0.84.0','--json']);assert.equal(installed.code,0,installed.stderr);
 mkdirSync(join(f.home,'pi/agents'),{recursive:true});writeFileSync(join(f.home,'pi/agents/native-local.md'),'---\nname: native-local\ndescription: explicit native resume\nmodel: fixture/main\ntools: read, write\nsystemPromptMode: replace\ninheritProjectContext: false\ninheritGlobalContext: false\ninheritSkills: false\n---\nReturn text or write requested file.\n');
 saveConfig(f.home,{formatVersion:2,...f.models,work:{execution,checks:[{command:'node',args:['-e',"if(require('fs').readFileSync('resumed.txt','utf8')!=='EXPLICIT_RESUME')process.exit(1)"]}]}});
 const run=await invoke(f,['ask','--json','/one explicitly resume a completed native background child with feedback'],'',repo.project);const task=JSON.parse(run.stdout).task;console.log('resume summary',JSON.stringify({code:run.code,status:task.status,error:task.error,children:task.work.helpers.map(h=>({status:h.status,error:h.error,text:h.text}))}));
 assert.equal(run.code,0,run.stderr);assert.equal(task.work.helpers.length,2);assert.notEqual(task.work.helpers[0].native.sessionId,task.work.helpers[1].native.sessionId);assert.deepEqual(readFileSync(task.work.helpers[0].native.sessionFile),originalSession);assert.equal(task.work.helpers[1].native.resumeOf.helperId,task.work.helpers[0].helperId);assert.equal(childRequests,3);
});

test('detached named workflow local cancellation stops its actual Docker command while parent remains active',{timeout:60000},async t=>{
 const repo=repository(t);let phase=0,runId,ownedContainer,stopObserved=false;
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),{readdirSync,existsSync}=await import('node:fs');
 const f=await fixture(t,async(call,n)=>{
  const system=String(call.body.messages.find(m=>m.role==='system')?.content??'');
  if(system.includes('You are helper '))return tool('subagent',{workflow:'detached-host-stop',async:false});
  if(n===1)return tool('start_work',{reason:'Cancel only detached native host command',scope:['ready','late.txt','parent.txt'],readScope:['.']});phase++;
  if(phase===1)return tool('subagents_enable');if(phase===2)return tool('subagent',{agent:'native-local',task:'Use named detached-host-stop workflow',async:true,model:'fixture/main',output:false});
  if(phase===3){runId=String(call.body.messages.at(-1).content).match(/Async: native-local \[([^\]]+)\]/)?.[1];assert.ok(runId);}
  const file=readdirSync(join(f.home,'tasks')).find(n=>n.endsWith('.json')),record=JSON.parse(readFileSync(join(f.home,'tasks',file),'utf8')),child=record.work.helpers[0],runner=record.tools.find(r=>r.nativeBackground),command=record.tools.find(r=>r.kind==='native_host_command');
  ownedContainer??=command?.executions?.[0]?.id;
  if(!stopObserved&&ownedContainer&&existsSync(join(f.home,'detached-command-abort'))){const deadline=Date.now()+5000;for(;;){try{await promisify(execFile)('docker',['inspect',ownedContainer]);}catch{stopObserved=true;break;}if(Date.now()>deadline)throw Error('Local workflow abort failed to stop Docker');await new Promise(r=>setTimeout(r,20));}assert.equal(record.status,'running');}
  if(!child?.stoppedAt||!runner?.stoppedAt){if(phase>40)throw Error('Detached workflow failed to finish');await new Promise(r=>setTimeout(r,100));return tool('subagent',{action:'status',id:runId});}
  assert.ok(stopObserved);if(!child.treatment)return tool('cothink_helper_result',{helperId:child.helperId,decision:'reject',reason:'Scoped workflow command aborted, do not adopt its partial ready marker'});
  if(!record.tools.some(r=>r.name==='write'))return tool('write',{path:'parent.txt',content:'PARENT_LIVE'});
  if(!record.work.acceptance?.length)return tool('accept_change');return {text:'Scoped native command stopped; independent parent result accepted'};
 });
 t.after(async()=>{if(ownedContainer)await promisify(execFile)('docker',['rm','-f',ownedContainer]).catch(()=>{});});
 const installed=await invoke(f,['install','npm:pi-subagents@0.84.0','--json']);assert.equal(installed.code,0,installed.stderr);const plugin=join(f.home,'pi/npm/node_modules/pi-subagents');
 const command='printf READY > ready; sleep 60; printf FORBIDDEN_LATE > late.txt',script='return runs.host("command",{kind:"command",command:'+JSON.stringify(command)+',timeoutMs:60000});';
 const extension=join(f.home,'detached-host-command.mjs'),required=join(f.home,'require-detached-host-command.mjs');
 writeFileSync(extension,`import{existsSync,writeFileSync}from'node:fs';import{join}from'node:path';import{registerWorkflowResource}from ${JSON.stringify(join(plugin,'bundle/workflow-resources.js'))};export default pi=>{let registration,timer;pi.on('session_start',(_,ctx)=>{registration=registerWorkflowResource({sessionId:ctx.sessionManager.getSessionId(),definition:{name:'detached-host-stop',version:1,resolve:()=>({script:${JSON.stringify(script)},hostCommands:[{key:'command',command:${JSON.stringify(command)}}]})}});});pi.on('tool_call',(event,ctx)=>{if(event.toolName!=='subagent')return;const poll=()=>{if(existsSync(join(ctx.cwd,'ready'))){writeFileSync(${JSON.stringify(join(f.home,'detached-command-abort'))},'called');ctx.abort();return;}timer=setTimeout(poll,10);};poll();});pi.on('session_shutdown',()=>{clearTimeout(timer);registration?.dispose();});};`);
 writeFileSync(required,`import{registerRequiredChildExtensions}from ${JSON.stringify(join(plugin,'bundle/required-child-extensions.js'))};export default pi=>{let registration;pi.on('session_start',(_,ctx)=>{registration=registerRequiredChildExtensions({sessionId:ctx.sessionManager.getSessionId(),requireForAllRunners:true,extensions:[{id:'detached-host-command',path:${JSON.stringify(extension)}}]});});pi.on('session_shutdown',()=>registration?.dispose());};`);
 mkdirSync(join(f.home,'pi/agents'),{recursive:true});writeFileSync(join(f.home,'pi/agents/native-local.md'),'---\nname: native-local\ndescription: native detached host command\nmodel: fixture/main\ntools: read, write, subagent\nallowNestedSubagents: true\nsystemPromptMode: replace\ninheritProjectContext: false\ninheritGlobalContext: false\ninheritSkills: false\n---\nUse the named native workflow.\n');
 saveConfig(f.home,{formatVersion:2,...f.models,piResources:{extensions:[required]},work:{execution,checks:[{command:'node',args:['-e',"const f=require('fs');if(f.readFileSync('parent.txt','utf8')!=='PARENT_LIVE'||f.existsSync('late.txt'))process.exit(1)"]}]}});
 const run=await invoke(f,['ask','--json','/one run detached native workflow and stop only its command'],'',repo.project),task=JSON.parse(run.stdout).task;console.log('detached command cancel',JSON.stringify({code:run.code,status:task.status,error:task.error,ownedContainer,stopObserved}));assert.equal(run.code,0,run.stderr);assert.ok(stopObserved);assert.equal(readFileSync(join(task.work.resultWorkspace,'parent.txt'),'utf8'),'PARENT_LIVE');
});

for(const recursiveMode of ['complete','cancel'])test(`recursive native detached runner ${recursiveMode} uses same owner and actual parent process close evidence`,{timeout:60000},async t=>{
 const repo=repository(t);let phase=0,parentPhase=0,rootRun,nestedRun,release,grandRequests=0;
 const held=new Promise(r=>release=r);t.after(()=>release());
 const {readdirSync}=await import('node:fs');const saved=()=>{const file=readdirSync(join(f.home,'tasks')).find(n=>n.endsWith('.json'));return JSON.parse(readFileSync(join(f.home,'tasks',file),'utf8'));};
 const f=await fixture(t,async(call,n)=>{
  const system=String(call.body.messages.find(m=>m.role==='system')?.content??'');
  if(system.includes('You are helper ')){
   if(system.includes('<active_agent name="native-parent"/>')){
    parentPhase++;
    if(parentPhase===1)return tool('write',{path:'parent.txt',content:'PARENT_A'});
    if(parentPhase===2)return tool('subagent',{agent:'native-local',task:'Read parent.txt and write nested.txt=NESTED_BACKGROUND',model:'fixture/main',async:true,output:false});
    if(parentPhase===3){const content=String(call.body.messages.at(-1).content);console.log('recursive native receipt',content);nestedRun=content.match(/Async: native-local \[([^\]]+)\]/)?.[1];assert.ok(nestedRun);return tool('read',{path:'parent.txt'});}
    if(parentPhase===4){assert.match(String(call.body.messages.at(-1).content),/PARENT_A/);if(recursiveMode==='complete')release();return tool('subagent',{action:'status',id:nestedRun});}
    const record=saved(),grand=record.work.helpers.find(h=>h.parentHelperId),runner=record.tools.find(r=>r.nativeBackground&&r.parentHelperId);
    if(!grand?.stoppedAt||!runner?.stoppedAt){if(parentPhase>30)throw Error('Nested native runner did not stop');await new Promise(r=>setTimeout(r,100));return tool('subagent',{action:'status',id:nestedRun});}
    if(!grand.treatment)return tool('cothink_helper_result',{helperId:grand.helperId,decision:'adopt',reason:'Actual creator reviewed nested detached file result after original process close'});
    return {text:'Creator explicitly adopted its detached child'};
   }
   grandRequests++;if(grandRequests===1){await held;return tool('read',{path:'parent.txt'});}if(grandRequests===2){assert.match(String(call.body.messages.at(-1).content),/PARENT_A/);return tool('write',{path:'nested.txt',content:'NESTED_BACKGROUND'});}return {text:'Real nested detached file'};
  }
  if(n===1)return tool('start_work',{reason:'Recursive original detached native runners',scope:['parent.txt','nested.txt'],readScope:['.']});phase++;
  if(phase===1)return tool('subagents_enable');if(phase===2)return tool('subagent',{agent:'native-parent',task:'Write parent.txt, start an original detached child, continue reading, then adopt its result',async:true,model:'fixture/main',output:false});
  if(phase===3){rootRun=String(call.body.messages.at(-1).content).match(/Async: native-parent \[([^\]]+)\]/)?.[1];assert.ok(rootRun);return tool('subagent',{action:'status',id:rootRun});}
  const record=saved(),parent=record.work.helpers.find(h=>!h.parentHelperId),runner=record.tools.find(r=>r.nativeBackground&&!r.parentHelperId);
  if(!parent?.stoppedAt||!runner?.stoppedAt){if(phase>50)throw Error('Outer native runner did not stop');await new Promise(r=>setTimeout(r,100));return tool('subagent',{action:'status',id:rootRun});}
  if(!parent.treatment)return tool('cothink_helper_result',{helperId:parent.helperId,decision:'adopt',reason:'Reviewed creator source and explicitly incorporated nested detached result'});
  if(!record.work.acceptance?.length)return tool('accept_change');return {text:'Recursive native detached result reviewed and accepted'};
 });
 const installed=await invoke(f,['install','npm:pi-subagents@0.84.0','--json']);assert.equal(installed.code,0,installed.stderr);mkdirSync(join(f.home,'pi/agents'),{recursive:true});
 for(const name of ['native-parent','native-local'])writeFileSync(join(f.home,'pi/agents',name+'.md'),'---\nname: '+name+'\ndescription: recursive native detached\nmodel: fixture/main\ntools: read, write, edit'+(name==='native-parent'?', subagent':'')+'\nallowNestedSubagents: '+(name==='native-parent')+'\nsystemPromptMode: replace\ninheritProjectContext: false\ninheritGlobalContext: false\ninheritSkills: false\n---\nDo assigned work and explicitly review child results.\n');
 saveConfig(f.home,{formatVersion:2,...f.models,work:{execution,checks:[{command:'node',args:['-e',"const f=require('fs');if(f.readFileSync('parent.txt','utf8')!=='PARENT_A'||f.readFileSync('nested.txt','utf8')!=='NESTED_BACKGROUND')process.exit(1)"]}]}});
 let run,task;
 if(recursiveMode==='complete'){run=await invoke(f,['ask','--json','/one use an actual native detached child that starts its own detached child'],'',repo.project);task=JSON.parse(run.stdout).task;}
 else {
  const {runTurn}=await import('../../src/discussion.js'),controller=new AbortController();let active;
  const running=runTurn({home:f.home,cwd:repo.project,input:'/one use recursive native detached children then cancel',config:{formatVersion:2,...f.models,work:{execution,checks:[{command:'node',args:['-e','process.exit(0)']}]}},signal:controller.signal,onProgress:event=>{active=event.task??active;}});running.catch(()=>{});t.after(async()=>{controller.abort();release();await running.catch(()=>{});});
  for(let i=0;grandRequests===0;i++){if(i>2000)throw Error('Nested detached model did not enter');await new Promise(r=>setTimeout(r,10));}
  assert.equal(active.record.work.helpers.length,2);assert.equal(active.record.tools.filter(r=>r.nativeBackground).length,2);controller.abort();release();task=(await running).record;run={code:0,stderr:task.error??''};
 }

 console.log('recursive native summary',JSON.stringify({code:run.code,status:task.status,error:task.error,helpers:task.work.helpers.map(h=>({id:h.helperId,status:h.status,text:h.text,error:h.error})),runners:task.tools.filter(r=>r.nativeBackground).map(r=>({id:r.runnerId,parent:r.parentHelperId,status:r.status,process:r.process,close:r.processClose}))}));
 assert.equal(run.code,0,run.stderr);const runners=task.tools.filter(r=>r.nativeBackground);assert.equal(runners.length,2);assert.notEqual(runners[0].process.pid,runners[1].process.pid);assert.equal(runners[1].processClose.observerRunnerId,runners[0].runnerId);assert.equal(runners[0].ownerEpoch,runners[1].ownerEpoch);const manifests=runners.map(r=>JSON.parse(readFileSync(join(r.directory,'bridge.json'),'utf8')));assert.equal(manifests[0].port,manifests[1].port);if(recursiveMode==='complete'){assert.equal(task.work.helpers[1].treatment.destinationHelperId,task.work.helpers[0].helperId);assert.equal(readFileSync(join(task.work.resultWorkspace,'nested.txt'),'utf8'),'NESTED_BACKGROUND');}else{assert.equal(task.status,'cancelled');assert.ok(runners.every(r=>r.stoppedAt&&r.processClose));assert.equal(grandRequests,1);assert.ok(task.work.helpers.every(h=>h.stoppedAt));}
});

for(const barrierMode of ['coherent','disconnect'])test(`detached creator source barrier ${barrierMode} keeps overlapped real file write and admission coherent`,{timeout:60000},async t=>{
 const repo=repository(t);let phase=0,parentRequests=0,grandRequests=0,runId;
 const {existsSync,readdirSync}=await import('node:fs');
 const saved=()=>{const file=readdirSync(join(f.home,'tasks')).find(n=>n.endsWith('.json'));return JSON.parse(readFileSync(join(f.home,'tasks',file),'utf8'));};
 let f,running;t.after(async()=>{if(f&&existsSync(f.home))writeFileSync(join(f.home,'write-release'),'cleanup release');if(running)await running.catch(()=>{});});
 f=await fixture(t,async(call,n)=>{
  const system=String(call.body.messages.find(m=>m.role==='system')?.content??'');
  if(system.includes('You are helper ')){
   if(system.includes('<active_agent name="native-parent"/>')){
    parentRequests++;if(parentRequests===1)return {toolCalls:[{name:'write',args:{path:'creator.txt',content:'WHOLE_CREATOR'}},{name:'subagent',args:{agent:'native-local',task:'Read creator.txt and report CHILD_DONE',model:'fixture/main',async:false,output:join(saved().work.helpers[0].cwd,'native-output.txt')}}]};
    if(parentRequests===2)return tool('cothink_helper_result',{helperId:hostResult(call.body),decision:'reject',reason:'Child text verified coherent input; native output is already in creator copy and no child files need import'});
    return {text:'Coherent creator source and native output ready'};
   }
   grandRequests++;if(grandRequests===1)return tool('read',{path:'creator.txt'});assert.match(String(call.body.messages.at(-1).content),/WHOLE_CREATOR/);assert.doesNotMatch(String(call.body.messages.at(-1).content),/HALF_CREATOR/);return {text:'CHILD_DONE'};
  }
  if(n===1)return tool('start_work',{reason:'Actual concurrent creator write/native admission',scope:['creator.txt','native-output.txt'],readScope:['.']});phase++;
  if(phase===1)return tool('subagents_enable');if(phase===2)return tool('subagent',{agent:'native-parent',task:'Write creator.txt and launch native child in the same tool batch',async:true,model:'fixture/main',output:false});
  if(phase===3){runId=String(call.body.messages.at(-1).content).match(/Async: native-parent \[([^\]]+)\]/)?.[1];assert.ok(runId);
   for(let i=0;!existsSync(join(f.home,'write-held'));i++){if(i>2000)throw Error('Real scoped write did not enter fault barrier');await new Promise(r=>setTimeout(r,10));}
   await new Promise(r=>setTimeout(r,100));const record=saved();assert.equal(record.work.helpers.length,1);assert.equal(grandRequests,0);assert.equal(readFileSync(join(record.work.helpers[0].cwd,'creator.txt'),'utf8'),'HALF_CREATOR');
   if(barrierMode==='disconnect'){for(let i=0;saved().work.helpers[0].status!=='outcome_unknown';i++){if(i>1000)throw Error('Owner failed to retain unknown writer');await new Promise(r=>setTimeout(r,10));}return tool('cothink_helper_result',{helperId:record.work.helpers[0].helperId,decision:'adopt',reason:'Attempt must fail while disconnected source writer is unresolved'});}
   writeFileSync(join(f.home,'write-release'),'release');return tool('subagent',{action:'status',id:runId});
  }
  if(barrierMode==='disconnect'){assert.match(String(call.body.messages.at(-1).content),/stop|stopped|running|Writer/i);writeFileSync(join(f.home,'write-release'),'release');return {text:'Source writer remains unknown; no result accepted'};}
  const record=saved(),parent=record.work.helpers[0],runner=record.tools.find(r=>r.nativeBackground);
  if(!parent?.stoppedAt||!runner?.stoppedAt){if(phase>40)throw Error('Source barrier workflow did not finish');await new Promise(r=>setTimeout(r,100));return tool('subagent',{action:'status',id:runId});}
  if(!parent.treatment)return tool('cothink_helper_result',{helperId:parent.helperId,decision:'adopt',reason:'Reviewed whole creator write and native postprocessing output from coherent original child input'});
  if(!record.work.acceptance?.length)return tool('accept_change');return {text:'Coherent parallel tool batch checked and accepted'};
 });
 const installed=await invoke(f,['install','npm:pi-subagents@0.84.0','--json']);assert.equal(installed.code,0,installed.stderr);const plugin=join(f.home,'pi/npm/node_modules/pi-subagents'),extension=join(f.home,'hold-real-write.mjs'),required=join(f.home,'require-hold-write.mjs');
 // Instrument the real filesystem call, not the plugin runner or SDK factory.
 writeFileSync(extension,`import fs from'node:fs/promises';import{existsSync,writeFileSync,readFileSync}from'node:fs';import{syncBuiltinESMExports}from'node:module';const original=fs.writeFile;let held=false;fs.writeFile=async function(path,data,...rest){if(!held&&String(path).endsWith('/creator.txt')&&String(data)==='WHOLE_CREATOR'){held=true;await original(path,'HALF_CREATOR',...rest);writeFileSync(${JSON.stringify(join(f.home,'write-held'))},'held');${barrierMode==='disconnect'?"const cfg=JSON.parse(readFileSync(process.argv[2],'utf8')),manifest=JSON.parse(readFileSync(cfg.hostBridge.manifest,'utf8'));const socket=process._getActiveHandles().find(h=>h.remotePort===manifest.port&&h.remoteAddress==='127.0.0.1');if(!socket)throw Error('Actual authenticated socket missing');socket.destroy();":""}while(!existsSync(${JSON.stringify(join(f.home,'write-release'))}))await new Promise(r=>setTimeout(r,10));}return original(path,data,...rest);};syncBuiltinESMExports();export default()=>{};`);
 writeFileSync(required,`import{registerRequiredChildExtensions}from ${JSON.stringify(join(plugin,'bundle/required-child-extensions.js'))};export default pi=>{let registration;pi.on('session_start',(_,ctx)=>{registration=registerRequiredChildExtensions({sessionId:ctx.sessionManager.getSessionId(),requireForAllRunners:true,extensions:[{id:'hold-real-write',path:${JSON.stringify(extension)}}]});});pi.on('session_shutdown',()=>registration?.dispose());};`);
 mkdirSync(join(f.home,'pi/agents'),{recursive:true});for(const name of ['native-parent','native-local'])writeFileSync(join(f.home,'pi/agents',name+'.md'),'---\nname: '+name+'\ndescription: coherent source fixture\nmodel: fixture/main\ntools: read, write'+(name==='native-parent'?', subagent':'')+'\nallowNestedSubagents: '+(name==='native-parent')+'\nsystemPromptMode: replace\ninheritProjectContext: false\ninheritGlobalContext: false\ninheritSkills: false\n---\nPerform assigned scoped work.\n');
 saveConfig(f.home,{formatVersion:2,...f.models,piResources:{extensions:[required]},work:{execution,checks:[{command:'node',args:['-e',"const f=require('fs');if(f.readFileSync('creator.txt','utf8')!=='WHOLE_CREATOR'||f.readFileSync('native-output.txt','utf8').trim()!=='CHILD_DONE')process.exit(1)"]}]}});
 const run=await (running=invoke(f,['ask','--json','/one native background concurrent source write and child admission'],'',repo.project)),task=JSON.parse(run.stdout).task;console.log('source barrier evidence',JSON.stringify({mode:barrierMode,code:run.code,status:task.status,error:task.error,grandRequests,helpers:task.work.helpers.map(h=>({status:h.status,stoppedAt:h.stoppedAt,resultError:h.resultError})),nativeShutdownError:task.nativeShutdownError,...(run.code?{acceptance:task.work.acceptance,diffs:task.work.helpers.map(h=>h.result?.edits.map(e=>({path:e.path,content:e.contentBase64})))}:{})}));
 if(barrierMode==='coherent'){assert.equal(run.code,0,run.stderr);assert.equal(task.work.helpers.length,2);assert.equal(Buffer.from(task.work.helpers[1].snapshot.files['creator.txt'].contentBase64,'base64').toString(),'WHOLE_CREATOR');assert.equal(readFileSync(join(task.work.resultWorkspace,'native-output.txt'),'utf8').trim(),'CHILD_DONE');}
 else {assert.notEqual(run.code,0);assert.equal(grandRequests,0);assert.equal(task.work.helpers.length,1);assert.equal(task.work.helpers[0].status,'outcome_unknown');assert.equal(task.work.helpers[0].stoppedAt,undefined);assert.equal(task.work.helpers[0].result,undefined);const {assertNoActivePiSessions}=await import('../../src/storage.js');assert.throws(()=>assertNoActivePiSessions(f.home),/active or unknown/);}
 assert.equal(existsSync(join(repo.project,'creator.txt')),false);
});
