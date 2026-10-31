import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerHostIntegration, admitHostChild, verifyHostInput, verifyHostChild, claimHostChild, hostChildStarted, hostChildTerminal, admitHostOperation, withHostResources } from '../vendor/pi-patches/pi-subagents-host-integration.js';

function owner(host = {}) {
  const cwd = join(tmpdir(), randomUUID()), parentSessionId = randomUUID();
  const facts = [];
  const integration = {
    admitOperation: async () => ({}),
    admitChild: async input => ({ ...input, cwd: join(tmpdir(), randomUUID()), launchId: randomUUID() }),
    started: async fact => facts.push(fact), terminal: async fact => facts.push(fact), ...host,
  };
  const close = registerHostIntegration({ cwd, parentSessionId, host: integration });
  return { input: { cwd, parentSessionId, model: 'fixture/main' }, facts, close };
}
test('explicit CoThink resource scope cannot fall back to an unbound native model launch',async()=>{
 const input={cwd:join(tmpdir(),randomUUID()),parentSessionId:randomUUID()};
 await assert.rejects(withHostResources(join(tmpdir(),randomUUID()),()=>admitHostOperation(input)),/task-owned admission/);
 await assert.rejects(withHostResources(join(tmpdir(),randomUUID()),()=>admitHostChild(input)),/task-owned admission/);
 withHostResources(join(tmpdir(),randomUUID()),()=>assert.throws(()=>verifyHostChild(input),/authentic admission/));
});
test('persist failure rejects; owner cannot bypass admission by changing cwd or claiming another session', async () => {
  const a = owner({ admitChild: async () => { throw Error('save failed'); } });
  await assert.rejects(admitHostChild(a.input), /save failed/);
  assert.throws(() => verifyHostInput(a.input), { code: 'SUBAGENT_HOST_ADMISSION' });
  assert.throws(() => verifyHostInput({ ...a.input, cwd: join(tmpdir(), randomUUID()) }), { code: 'SUBAGENT_HOST_ADMISSION' });
  const b = owner();
  await assert.rejects(admitHostChild({ ...a.input, cwd: b.input.cwd }), /another host cwd/);
  await a.close(); await b.close();
});
test('closing during admission latches cancellation and never returns a runnable child', async () => {
  let release;
  const a = owner({ admitChild: async input => {
    await new Promise(resolve => { release = resolve; });
    return { ...input, cwd: join(tmpdir(), randomUUID()), launchId: randomUUID() };
  } });
  const child = admitHostChild(a.input);
  await a.close(); release();
  await assert.rejects(child, /closed during child admission/);
  await assert.rejects(admitHostOperation(a.input), /closed admission/);
});
test('real session identity binds nested admission; receipt replay cannot start another session', async () => {
  const a = owner();
  const child = await admitHostChild(a.input);
  verifyHostInput(child); verifyHostChild(child);
  assert.throws(() => verifyHostChild({ ...child, model: 'other/model' }), /model changed/);
  assert.throws(() => verifyHostChild({ ...child, hostAdmission: { ...child.hostAdmission } }), /authentic admission/);
  const sessionId = randomUUID();
  await claimHostChild(child);
  await assert.rejects(claimHostChild(child),/consumed/);
  await hostChildStarted(child, { sessionId });
  await assert.rejects(hostChildStarted(child, { sessionId: randomUUID() }), /second SDK session/);
  const nested = await admitHostChild({ cwd: child.cwd, parentSessionId: sessionId, model: child.model });
  assert.notEqual(nested.cwd, child.cwd);
  await hostChildTerminal(child, { sessionId, disposed: true, shutdownCompleted: false, timedOut: true, errors: [] });
  assert.equal(a.facts.at(-1).shutdownCompleted, false);
  await assert.rejects(admitHostChild({ cwd: child.cwd, parentSessionId: sessionId }), /closed admission/);
  await a.close();
  assert.throws(() => verifyHostChild(nested), /Stale/);
});

test('managed placement cannot consult source settings or choose an unregistered provider',async()=>{
 const {resolveHostMachinePlacement,hostMachineConnection,withHostOperation}=await import('../vendor/pi-patches/pi-subagents-host-integration.js');
 const denied=owner();await assert.rejects(withHostOperation(denied.input,()=>resolveHostMachinePlacement({...denied.input,machine:'local',settings:{rex:{ssh:'untrusted'}}})),/not configured/);await denied.close();
 let seen;
 const bound=owner({resolvePlacement:input=>{seen=input;return {machine:{provider:'herdr',id:'saved',target:'fixture-alias',cwd:'/remote/unique'},connection:{sshConfig:'/private/fixture-ssh-config'}};}});
 await withHostOperation(bound.input,()=>{
  const value=resolveHostMachinePlacement({...bound.input,machine:'saved',settings:{rex:{ssh:'untrusted'}},stepCwd:'/original'});
  assert.equal(seen.requestedCwd,'/original');assert.equal(value.machine.target,'fixture-alias');
  assert.deepEqual(hostMachineConnection(value.machine),{sshConfig:'/private/fixture-ssh-config'});
  assert.deepEqual(hostMachineConnection({...value.machine}),{},'copied model metadata cannot claim trusted transport options');
 });await bound.close();
 const rex=owner({resolvePlacement:()=>({machine:{provider:'rex'}})});
 await assert.rejects(withHostOperation(rex.input,()=>resolveHostMachinePlacement({...rex.input,machine:'local'})),/Herdr/);await rex.close();
});

test('revoking admission preserves cleanup of the original claimed remote child',async()=>{
 const {stopHostRemote,prepareHostRemote}=await import('../vendor/pi-patches/pi-subagents-host-integration.js');let stopped;
 const bound=owner({stopRemote:async input=>{stopped=input.launchId;return {disposed:true};},prepareRemote:async()=>({})});
 const child=await admitHostChild(bound.input);await claimHostChild(child);await bound.close();
 await assert.rejects(prepareHostRemote(child),/Stale/);
 assert.deepEqual(await stopHostRemote(child),{disposed:true});assert.equal(stopped,child.hostAdmission.launchId);
 await assert.rejects(stopHostRemote({...child,cwd:join(tmpdir(),randomUUID())}),/changed child/);
});

test('native remote startup cancellation attempts managed stop before pane cleanup and keeps startup failure',async()=>{
 const {readFileSync}=await import('node:fs');
 const {stopHostRemote}=await import('../vendor/pi-patches/pi-subagents-host-integration.js');
 const patch=JSON.parse(readFileSync(new URL('../vendor/pi-patches/pi-subagents-0.84.0-foreground-unlimited-v1.json',import.meta.url)));
 // Execute both shipped postimages' actual factory with boundary doubles, not a rewritten startup flow.
 for(const path of ['src/runs/shared/herdr-placed-run.js','bundle/chunk-J5YL7LYR.js']){
  const file=patch.files.find(file=>file.path===path);
  const source=file.replacements.findLast(([,after])=>after.startsWith('async function startPlacedPiSession('))[1];
  for(const failure of ['owner-close','activation','launch']){
   const events=[],original=Error('activation acknowledgement failed'),cleanupError=Error('stop evidence unknown');let bound,session;
   const sessionId=randomUUID();
   bound=owner({started:async()=>{if(failure==='owner-close')await bound.close();else throw original;},stopRemote:async()=>{events.push('managed-stop');if(failure==='launch')throw cleanupError;return {disposed:true,shutdownCompleted:true};},terminal:async fact=>events.push(fact)});
   const child=await admitHostChild(bound.input);await claimHostChild(child);
   const manifest={protocol:1,packageVersion:'0.84.0',nativeSessionId:sessionId};
   const remoteOwner={machine:{cwd:child.cwd},runId:'fixture-run',runtimeDir:'/fixture/runtime',connection:{forwardRemoteSocket:async()=>({socketPath:'/fixture/socket'})},host:{sessionOf:()=>sessionId},journal(){},launch:async()=>{if(failure==='launch')throw original;return {owned:{},terminalId:'term'};},cleanup:async()=>{events.push('pane-cleanup');}};
   class Session {constructor(){session=this;this.identity={runId:'fixture-run'};this.evidenceCursor=0;}async dispose(){try{await this.hostDispose?.();}finally{await remoteOwner.cleanup();}}}
   class Bridge {configure(){return {...manifest,model:child.model,agent:'fixture',tools:[],hostReceipt:{sessionId}};}}
   const deps={stopHostRemote,hostChildStarted,hostChildTerminal,HERDR_PI_MODE_ENV:'mode',HERDR_PI_RUN_ENV:'run',HERDR_PI_RUNTIME_DIR_ENV:'dir',HERDR_PI_PROTOCOL:1,packageJson:{version:'0.84.0'},package_default:{version:'0.84.0'},discoverPlacedBridgeManifest:async()=>manifest,BridgeChannel:Bridge,waitForReadyBridgeFrame:async()=>({...manifest,cwd:child.cwd}),isRexLocalMachine:()=>false,HerdrPiSession:Session};
   const create=Function(...Object.keys(deps),source+';return startPlacedPiSession;')(...Object.values(deps));
   let thrown;try{await create({...child,runtime:{}},remoteOwner,{args:[],resources:{agent:'fixture'}});}catch(error){thrown=error;}
   assert.ok(thrown,path+' '+failure);
   if(failure==='owner-close')assert.match(thrown.message,/closed during child startup/);else assert.equal(thrown,original);
   assert.equal(events.filter(event=>event==='managed-stop').length,1,'stop must be attempted exactly once');
   assert.equal(events.at(-1),'pane-cleanup','managed stop/harvest precedes native cleanup');
   if(failure==='launch'){assert.ok(thrown.cleanupErrors.includes(cleanupError));assert.equal(events.length,2,'unknown stop must not produce known terminal facts');}
   else {assert.equal(events[1].disposed,true);assert.equal(events[1].shutdownCompleted,true);assert.equal(events[1].sessionId,sessionId);await session.hostDispose();assert.equal(events.length,3,'repeated cleanup must not reapply stop/harvest');}
   await bound.close();
  }
 }
});

test('partial native remote construction retains original-receipt cleanup before an owner exists',async()=>{
 const {readFileSync}=await import('node:fs');const {stopHostRemote}=await import('../vendor/pi-patches/pi-subagents-host-integration.js');
 const patch=JSON.parse(readFileSync(new URL('../vendor/pi-patches/pi-subagents-0.84.0-foreground-unlimited-v1.json',import.meta.url)));
 for(const path of ['src/runs/shared/herdr-placed-run.js','bundle/chunk-J5YL7LYR.js'])for(const stage of ['prepare','owner']){
  const events=[],original=Error('construction failed'),bound=owner({stopRemote:async()=>{events.push('managed-stop');return {disposed:true,shutdownCompleted:true};},terminal:async fact=>events.push(fact)});
  const child=await admitHostChild(bound.input);await claimHostChild(child);
  const source=patch.files.find(file=>file.path===path).replacements.findLast(([,after])=>/^(export )?async function createHerdrPiSession\(/.test(after))[1].replace(/^export /,'');
  const deps={prepareHostRemote:async()=>{if(stage==='prepare'){await bound.close();throw original;}return {};},stopHostRemote,hostChildTerminal,safeRunId:value=>value,HerdrPlacedRunOwner:{create:async()=>{await bound.close();throw original;}}};
  const create=Function(...Object.keys(deps),source+';return createHerdrPiSession;')(...Object.values(deps));
  await assert.rejects(create({...child,machine:{provider:'herdr'},runtime:{runId:'owned'}}),error=>error===original);
  assert.equal(events[0],'managed-stop');assert.equal(events.length,2);assert.equal(events[1].disposed,true);await bound.close();
 }
});
