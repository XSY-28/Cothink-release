// Real pinned package + native public delegation + real SDK + deterministic localhost model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture } from '../helpers/pi-fixture.js';
import { invoke } from '../helpers/cli-fixture.js';
import { createRuntime } from '../../src/pi-runtime.js';
import { preparePluginCompatibility, inspectPluginCompatibility } from '../../src/plugin-compatibility.js';
import {restorePinnedPlugin} from '../helpers/pi-plugin-fixture.js';

test('pinned native dispatch awaits host persistence before SDK launch and reports actual disposal facts', {timeout:60000}, async t => {
  const f = await fixture(t, () => ({text:'NATIVE_HOST_CHILD'}));
  const installation = await invoke(f, ['install','npm:pi-subagents@0.84.0','--json']);
  assert.equal(installation.code, 0, installation.stdout + installation.stderr);
  const pluginRoot = join(f.home,'pi/npm/node_modules/pi-subagents');
  const patch=JSON.parse(readFileSync(new URL('../../vendor/pi-patches/pi-subagents-0.84.0-foreground-unlimited-v1.json',import.meta.url)));
  const prior=JSON.parse(readFileSync(new URL('../../vendor/pi-patches/pi-subagents-0.84.0-foreground-unlimited-v1.base.json',import.meta.url)));
  // Reproduce the actually delivered patched revision, which npm preserves on same-version install.
  restorePinnedPlugin(f,pluginRoot,patch,prior);
  const oldFile=join(pluginRoot,prior.files[0].path),oldBytes=readFileSync(oldFile,'utf8');
  const foreignBytes=oldBytes+'\n// unrecognized local modification\n';writeFileSync(oldFile,foreignBytes);
  assert.throws(()=>preparePluginCompatibility(join(f.home,'pi')),/previous patched artifact differs/);
  const rejectedMigration=await invoke(f,['install','npm:pi-subagents@0.84.0','--json']);
  assert.notEqual(rejectedMigration.code,0);assert.match(rejectedMigration.stdout+rejectedMigration.stderr,/previous patched artifact differs/);
  assert.equal(readFileSync(oldFile,'utf8'),foreignBytes,'failed migration must preserve original modified installation');
  writeFileSync(oldFile,oldBytes);
  const oldFiles=new Map(patch.files.filter(file=>file.before!==null).map(file=>[file.path,readFileSync(join(pluginRoot,file.path))]));
  const oldProvenance=readFileSync(join(pluginRoot,'cothink-compatibility.json'));
  preparePluginCompatibility(join(f.home,'pi'));
  assert.equal(inspectPluginCompatibility(pluginRoot).revision,patch.revision,'exact previous patch bytes must transform without npm replacement');
  for(const file of patch.files)if(file.before===null)unlinkSync(join(pluginRoot,file.path));else writeFileSync(join(pluginRoot,file.path),oldFiles.get(file.path));
  writeFileSync(join(pluginRoot,'cothink-compatibility.json'),oldProvenance);
  const migrated=await invoke(f,['install','npm:pi-subagents@0.84.0','--json']);
  assert.equal(migrated.code,0,migrated.stdout+migrated.stderr);
  const afterMigration=readFileSync(join(pluginRoot,'cothink-compatibility.json'),'utf8');
  assert.equal(JSON.parse(afterMigration).revision,patch.revision);
  const repeated=await invoke(f,['install','npm:pi-subagents@0.84.0','--json']);
  assert.equal(repeated.code,0,repeated.stdout+repeated.stderr);
  assert.equal(readFileSync(join(pluginRoot,'cothink-compatibility.json'),'utf8'),afterMigration);
  const old = Object.fromEntries(['PI_CODING_AGENT_DIR','PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT'].map(key=>[key,process.env[key]]));
  process.env.PI_CODING_AGENT_DIR=join(f.home,'pi');
  process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT=resolve('node_modules/@earendil-works/pi-coding-agent');
  t.after(()=>{for(const [key,value] of Object.entries(old))if(value===undefined)delete process.env[key];else process.env[key]=value;});
  writeFileSync(join(f.home,'pi/settings.json'),JSON.stringify({packages:[],retry:{enabled:false,provider:{maxRetries:0,timeoutMs:0}},compaction:{enabled:false},cacheWarming:'off',httpIdleTimeoutMs:0}));
  let pi;
  const rt = await createRuntime({home:f.home,cwd:f.cwd,modelRef:f.models.main,
    packageSnapshot:{packages:[],extensions:[join(pluginRoot,'bundle/index.js')],skills:[],prompts:[],themes:[],diagnostics:[]},
    extensionFactories:[{name:'native-host-fixture',factory:api=>{pi=api;}}]});
  t.after(()=>rt.dispose()); await rt.session.bindExtensions({mode:'rpc'});
  const {registerAgentViaEvents}=await import(pathToFileURL(join(pluginRoot,'bundle/agents.js')));
  const agent=registerAgentViaEvents({pi,name:'native-host-child',definition:{description:'Native host contract fixture',systemPrompt:'Return the given task.',systemPromptMode:'replace',inheritGlobalContext:false,inheritProjectContext:false,inheritSkills:false,tools:['read'],model:'fixture/main',allowNestedSubagents:false}});
  t.after(()=>agent.dispose());
  const {registerHostIntegration}=await import(pathToFileURL(join(pluginRoot,'src/runs/shared/host-integration.js')));
  let reject=true, childNumber=0;const events=[];
  const close=registerHostIntegration({cwd:f.cwd,parentSessionId:rt.sessionManager.getSessionId(),host:{
    async admitOperation(input){events.push({kind:'operation',input});if(reject)throw Error('PERSISTENCE_FAILURE_BEFORE_WRITER');return {};},
    async admitChild(input){events.push({kind:'admit',input});const childCwd=join(f.home,'isolated-child-'+(++childNumber));mkdirSync(childCwd);return {...input,cwd:childCwd,launchId:'actual-child-'+childNumber,sessionEnabled:false};},
    async started(fact){events.push({kind:'started',fact});},async terminal(fact){events.push({kind:'terminal',fact});},
  }});t.after(close);
  const dispatch=async requestId=>new Promise(resolveResponse=>{
    const off=pi.events.on('prompt-template:subagent:response',data=>{if(data.requestId===requestId){off();resolveResponse(data);}});
    pi.events.emit('prompt-template:subagent:request',{requestId,ownerRunId:'host-contract',nodeId:requestId,agent:'native-host-child',task:'Return NATIVE_HOST_CHILD',context:'fresh',cwd:f.cwd,model:'fixture/main',timeoutMs:0,skill:false,artifacts:false,result:{kind:'text'}});
  });
  const failed=await dispatch('persist-failed');
  assert.equal(f.calls.length,0);assert.match(JSON.stringify(failed),/PERSISTENCE_FAILURE_BEFORE_WRITER/);
  assert.deepEqual(events.map(e=>e.kind),['operation']);
  reject=false;const result=await dispatch('native-allowed');
  assert.equal(result.status,'completed',JSON.stringify(result));assert.equal(f.calls.length,1);
  assert.match(JSON.stringify(result),/NATIVE_HOST_CHILD/);
  assert.deepEqual(events.map(e=>e.kind),['operation','operation','operation','admit','started','terminal']);
  const terminal=events.at(-1).fact;assert.equal(terminal.shutdownCompleted,true);assert.equal(terminal.disposed,true);assert.equal(terminal.timedOut,false);
  assert.equal(events.find(e=>e.kind==='started').fact.sessionId,terminal.sessionId);
  const extension=join(f.home,'late-shutdown.mjs'),marker=join(f.home,'late-shutdown-write');
  writeFileSync(extension,`import {writeFileSync} from 'node:fs'; export default pi=>pi.on('session_shutdown',async()=>{await new Promise(resolve=>setTimeout(resolve,5250));writeFileSync(${JSON.stringify(marker)},'late');});`);
  const {registerRequiredChildExtensions}=await import(pathToFileURL(join(pluginRoot,'bundle/required-child-extensions.js')));
  const required=registerRequiredChildExtensions({sessionId:rt.sessionManager.getSessionId(),requireForAllRunners:true,extensions:[{id:'late-shutdown',path:extension}]});
  t.after(()=>required.dispose());
  await dispatch('late-cleanup');
  const partial=events.findLast(e=>e.kind==='terminal').fact;
  assert.equal(partial.disposed,true);assert.equal(partial.timedOut,true);assert.equal(partial.shutdownCompleted,false);
  const deadline=Date.now()+2000;
  while(!existsSync(marker)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(existsSync(marker),true,'real late extension write remains observable after partial cleanup');
  required.dispose();
  const failing=join(f.home,'throwing-shutdown.mjs');
  writeFileSync(failing,"export default pi=>pi.on('session_shutdown',()=>{throw Error('ACTUAL_SHUTDOWN_FAILURE');});");
  const throwing=registerRequiredChildExtensions({sessionId:rt.sessionManager.getSessionId(),requireForAllRunners:true,extensions:[{id:'throwing-shutdown',path:failing}]});
  t.after(()=>throwing.dispose());
  await dispatch('throwing-cleanup');
  const failedCleanup=events.findLast(e=>e.kind==='terminal').fact;
  assert.equal(failedCleanup.disposed,true);assert.equal(failedCleanup.shutdownCompleted,false);assert.equal(failedCleanup.timedOut,false);
  assert.match(JSON.stringify(failedCleanup.errors),/ACTUAL_SHUTDOWN_FAILURE/);
  throwing.dispose();
  // Use the real default factory, not a replacement factory. Concurrent/repeated create must
  // fail before a second real session_start, even when no model prompt is submitted.
  const startup=join(f.home,'startup-count.mjs'),countPath=join(f.home,'startup-count');
  writeFileSync(startup,`import{appendFileSync}from'node:fs';export default pi=>pi.on('session_start',()=>appendFileSync(${JSON.stringify(countPath)},'start\\n'));`);
  const {resolveHostPeerAliases}=await import(pathToFileURL(join(pluginRoot,'src/runs/background/runner-aliases.js')));
  const {registerHooks}=await import('node:module');
  const peers=resolveHostPeerAliases(resolve('node_modules/@earendil-works/pi-coding-agent'));
  assert.deepEqual(peers.missing,[]);
  const aliases=registerHooks({resolve(specifier,context,next){const peer=peers.aliases[specifier];return peer?{url:pathToFileURL(peer).href,shortCircuit:true}:next(specifier,context);}});
  t.after(()=>aliases.deregister());
  const {buildAdmittedChildLaunch}=await import(pathToFileURL(join(pluginRoot,'src/runs/shared/child-launch.js')));
  const {createDefaultChildSessionFactory}=await import(pathToFileURL(join(pluginRoot,'src/runs/shared/child-session.js')));
  const nativeLaunch=await buildAdmittedChildLaunch({cwd:f.cwd,parentSessionId:rt.sessionManager.getSessionId(),model:'fixture/main',childAgentName:'native-host-child',runId:'duplicate-create',childIndex:0,host:'parent',sessionEnabled:false,tools:['read'],requiredExtensions:[{id:'startup-count',path:startup}],inheritGlobalContext:false,inheritProjectContext:false,inheritSkills:false,waitToolEnabled:false});
  const factory=createDefaultChildSessionFactory();t.after(()=>factory.dispose());
  const created=await Promise.allSettled([factory.create(nativeLaunch.session),factory.create(nativeLaunch.session)]);
  assert.equal(created.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(created.filter(result=>result.status==='rejected').length,1);
  assert.match(String(created.find(result=>result.status==='rejected').reason),/consumed/);
  assert.equal(readFileSync(countPath,'utf8'),'start\n');
  await created.find(result=>result.status==='fulfilled').value.dispose();
  await assert.rejects(factory.create(nativeLaunch.session),/Stale|consumed/);
  assert.equal(readFileSync(countPath,'utf8'),'start\n');
  const saved=JSON.parse(readFileSync(join(pluginRoot,'cothink-compatibility.json')));assert.equal(saved.revision,'native-host-admission-v2');
});
