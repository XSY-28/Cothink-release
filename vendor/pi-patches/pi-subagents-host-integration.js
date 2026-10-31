// Public CoThink compatibility contract for pi-subagents@0.84.0.
// This module is copied into the selected package, shared by source and bundle.
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

const key = Symbol.for('pi-subagents:cothink-host-integration:v1');
const state = globalThis[key] ??= { owners: new Map(), sessions: new Map(), receipts: new WeakMap() };
state.results ??= new WeakMap();
state.runnerRegistrations ??= new Map();
state.operations ??= new AsyncLocalStorage();
const fail = message => { throw Object.assign(new Error(message), { code: 'SUBAGENT_HOST_ADMISSION' }); };
const canonical = cwd => typeof cwd === 'string' && cwd.length ? resolve(cwd) : fail('Missing host cwd');

/** Trusted application API; model-supplied parent/actor IDs never create bindings. */
export function registerHostIntegration({ cwd, parentSessionId, host }) {
  cwd = canonical(cwd);
  if (!parentSessionId || !host || ['admitChild','admitOperation','started','terminal'].some(method => typeof host[method] !== 'function'))
    fail('Host integration requires a bound session, admission and lifecycle methods');
  if (state.owners.has(cwd)) fail('Host cwd already has an integration owner');
  if (state.sessions.has(parentSessionId)) fail('Host session already has an integration owner');
  const owner = { cwd, parentSessionId, host, closed: false };
  state.owners.set(cwd, owner);
  state.sessions.set(parentSessionId, owner);
  return async () => {
    if (owner.closed) return;
    owner.closed = true;
    // Retain the closed binding: stale queued calls must fail, never become unmanaged.
    await host.closed?.();
  };
}

function isClosed(owner) { return owner.closed || Boolean(owner.parent && isClosed(owner.parent)); }
function ownerFor(input) {
  const byCwd = state.owners.get(canonical(input.cwd));
  const bySession = state.sessions.get(input.parentSessionId);
  if (byCwd && bySession && byCwd !== bySession) fail('Session cannot control another host cwd');
  const owner = byCwd ?? bySession;
  if (owner && isClosed(owner)) fail('Host owner has closed admission');
  if (owner && input.parentSessionId !== owner.parentSessionId) fail('Host parent session does not match cwd owner');
  return owner;
}
function receiptFor(launch, {cleanup=false}={}) {
  const receipt = launch.hostAdmission;
  const saved = receipt && state.receipts.get(receipt);
  const managed = state.owners.get(canonical(launch.cwd));
  if (!saved) {
    if (receipt || managed || hostAgentDirectory()) fail('Managed child has no authentic admission receipt');
    return;
  }
  if ((!cleanup&&(isClosed(saved.owner) || saved.childOwner.closed)) || saved.cwd !== canonical(launch.cwd)) fail('Stale or changed child admission');
  if (saved.model !== launch.model) fail('Child model changed after admission');
  return saved;
}

/** Outer controller admission precedes native session/output/config writers. */
export async function admitHostOperation(input) {
  const owner = ownerFor(input);
  if (!owner) {if(hostAgentDirectory())fail('CoThink native work requires a task-owned admission binding');return input;}
  const operationId = randomUUID();
  const parent=state.operations.getStore();
  const accepted = await owner.host.admitOperation({ ...input, operationId, ...(parent?.owner===owner?{parentOperationId:parent.operationId}:{}) });
  if (isClosed(owner)) fail('Host closed during operation admission');
  if (!accepted || typeof accepted !== 'object') fail('Host did not persist operation admission');
  if(accepted.cwd&&canonical(accepted.cwd)!==owner.cwd)state.owners.set(canonical(accepted.cwd),owner);
  return { ...input, ...accepted, hostOperationId: operationId };
}

/** Called BEFORE child storage, tool/resource planning or launch permits are finalized. */
export async function admitHostChild(input) {
  const owner = ownerFor(input);
  if (!owner) {if(hostAgentDirectory())fail('CoThink native child requires a task-owned admission binding');return input;}
  const requestId = randomUUID();
  const operation=state.operations.getStore();
  const accepted = await owner.host.admitChild({ ...input, requestId, ...(operation?.owner===owner?{hostOperationId:operation.operationId}:{}) });
  if (isClosed(owner)) fail('Host closed during child admission');
  if (!accepted || typeof accepted.launchId !== 'string' || !accepted.launchId || !accepted.cwd)
    fail('Host did not return persisted child admission');
  const cwd = canonical(accepted.cwd);
  if (cwd === owner.cwd) fail('A child requires an independent source copy');
  const prior = state.owners.get(cwd);
  if (prior && prior !== owner) fail('Child cwd belongs to another owner');
  const receipt = Object.freeze({ version: 1, launchId: accepted.launchId });
  const result = { ...input, ...accepted, cwd, hostAdmission: receipt };
  const childOwner = { cwd, parentSessionId: undefined, host: owner.host, closed: false, parent: owner };
  state.owners.set(cwd, childOwner);
  state.receipts.set(receipt, { owner, childOwner, cwd, model: result.model, started: false, terminal: false });
  return result;
}

/** Native interpreter callbacks retain the trusted operation basis across asynchronous fanout. */
export async function withHostOperation(input,callback) {
  const owner=ownerFor(input),admitted=await admitHostOperation(input);
  if(!owner)return callback(admitted);
  return state.operations.run({...state.operations.getStore(),owner,operationId:admitted.hostOperationId},async()=>{
    try{return await callback(admitted);}finally{await owner.host.operationReturned?.({operationId:admitted.hostOperationId});}
  });
}

/** Per-runtime resource lookup; concurrent tasks never mutate process.env. */
export function withHostResources(agentDir,callback,{headlessUI=false}={}) {
  return state.operations.run({...state.operations.getStore(),agentDir,headlessUI},callback);
}
export function headlessHostUI(){return state.operations.getStore()?.headlessUI===true;}
export function headlessHostAPI(pi) {
  if(!headlessHostUI())return pi;
  const context=ctx=>new Proxy(ctx,{get(target,property){return property==='hasUI'?false:Reflect.get(target,property,target);}});
  return new Proxy(pi,{get(target,property){
    if(property==='on')return (event,handler)=>target.on(event,(value,ctx)=>handler(value,context(ctx)));
    if(property==='registerTool')return tool=>target.registerTool({...tool,execute:typeof tool.execute==='function'?(...args)=>{args[4]=context(args[4]);return tool.execute(...args);}:tool.execute});
    const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
  }});
}
export function hostAgentDirectory() {
  const context=state.operations.getStore();
  return context?.agentDir??context?.owner?.host.agentDir;
}
export function validateHostOutput(output) {
  if(!output)return;
  const owner=state.operations.getStore()?.owner;
  if(owner)owner.host.validateOutput?.({output,parentSessionId:owner.parentSessionId,operationId:state.operations.getStore()?.operationId});
}

export function verifyHostInput(input) {
  if (input.hostAdmission) verifyHostChild(input);
  else if (ownerFor(input)) fail('Managed child launch requires awaited host admission');
}

/** Verify again at the actual SDK/placement boundary, before runtime creation. */
export function verifyHostChild(launch) {
  const saved=receiptFor(launch);
  if(saved&&(saved.claimed||saved.started||saved.terminal))fail('Child admission has already been consumed');
}

/** Synchronous claim before any actual factory await, storage or startup side effect. */
export async function claimHostChild(launch) {
  verifyHostChild(launch);
  const saved=launch.hostAdmission&&state.receipts.get(launch.hostAdmission);
  if(saved)saved.claimed=true;
  if(saved){await saved.owner.host.claimStart?.({launchId:launch.hostAdmission.launchId});if(isClosed(saved.owner))fail('Host closed during start claim');}
}

export async function hostChildStarted(launch, facts) {
  const saved = receiptFor(launch);
  if (!saved) return;
  if (!saved.claimed) fail('Child admission was not claimed before SDK creation');
  if (saved.started) fail('Child admission cannot start a second SDK session');
  if (!facts.sessionId) fail('SDK session identity is required');
  saved.started = true;
  saved.childOwner.parentSessionId = facts.sessionId;
  if (state.sessions.has(facts.sessionId)) fail('Child session identity already belongs to a host owner');
  state.sessions.set(facts.sessionId, saved.childOwner);
  await saved.owner.host.started?.({ launchId: launch.hostAdmission.launchId, ...facts });
  if (isClosed(saved.owner)) fail('Host closed during child startup');
}

/** Cleanup facts are observations; timeout/error must remain partial/unknown. */
export async function hostChildTerminal(launch, facts) {
  const saved = launch.hostAdmission && state.receipts.get(launch.hostAdmission);
  if (!saved) return;
  if (saved.terminal) return;
  await saved.owner.host.terminal?.({ launchId: launch.hostAdmission.launchId, ...facts });
  saved.terminal = true;
  saved.childOwner.closed = true;
}

/** Preserve the opaque receipt while native result processing/artifact writers finish. */
export function bindHostResult(result,launch) {
  if(launch.hostAdmission)state.results.set(result,launch.hostAdmission);
}
export async function finishHostResult(result) {
  const receipt=state.results.get(result),saved=receipt&&state.receipts.get(receipt);
  if(!saved||saved.writerFinished)return;
  await saved.owner.host.finished?.({launchId:receipt.launchId,sdkTerminalObserved:saved.terminal,
    result:{exitCode:result.exitCode,error:result.error??null,text:result.finalOutput??result.output??'',usage:result.usage??null,outputState:result.outputState??null,artifactPaths:result.artifactPaths??null}});
  saved.writerFinished=true;
}

/** Native named-resource host commands retain their interpreter; managed hosts own execution. */
export async function executeHostCommand(input) {
  const owner=state.owners.get(canonical(input.cwd));
  if(!owner)return undefined;
  if(isClosed(owner))fail('Host command owner has closed');
  if(typeof owner.host.command!=='function')fail('Host command execution is not configured');
  return owner.host.command({...input,parentSessionId:owner.parentSessionId});
}

/** Preserve the native executor while selecting its admitted immutable controller copy. */
export function hostOperationContext(ctx,admitted) {
  return admitted.hostManaged&&admitted.cwd!==ctx.cwd?new Proxy(ctx,{get(target,key){return key==='cwd'?admitted.cwd:Reflect.get(target,key,target);}}):ctx;
}
export async function admitHostRunner(config,parentSessionId) {
  const context=state.operations.getStore(),owner=context?.owner??ownerFor({cwd:config.cwd,parentSessionId});
  if(!owner)return config;
  if(isClosed(owner)||!owner.host.admitRunner)fail('Native detached owner unavailable');
  const accepted=await owner.host.admitRunner({...config,parentSessionId,hostOperationId:context?.operationId});
  if(isClosed(owner))fail('Owner closed during runner admission');
  return {...config,...accepted};
}
export function hostRunnerSpawned(config,process) {
  const owner=state.operations.getStore()?.owner;
  if(config.hostManaged){if(!owner||isClosed(owner))fail('Runner owner closed');state.runnerRegistrations.set(config.runnerProcessInstanceId,Promise.resolve().then(()=>owner.host.runnerSpawned({runnerProcessInstanceId:config.runnerProcessInstanceId,process})));}
}
export function withRunnerOperation({cwd,parentSessionId,operationId},callback) {
  const owner=ownerFor({cwd,parentSessionId});if(!owner)fail('Runner not authenticated');
  return state.operations.run({owner,operationId,agentDir:owner.host.agentDir},callback);
}

/** Explicit native resume still uses the original resolver/executor, with a fresh owned attempt. */
export async function admitHostResume(target) {
  const context=state.operations.getStore(),owner=context?.owner;
  if(!owner)return target;
  if(isClosed(owner)||!owner.host.prepareResume)fail('Native resume has no live task owner');
  return owner.host.prepareResume({target,operationId:context.operationId,parentSessionId:owner.parentSessionId});
}

/** Await process registration after original listeners attach, before native startup proceeds. */
export async function hostRunnerReady(config) {
  if(config.hostManaged)await state.runnerRegistrations.get(config.runnerProcessInstanceId);
}

/** Known native postprocessing writers share the creator barrier, without holding model waits. */
export async function withHostSourceOutput(output,operation) {
  const context=state.operations.getStore(),owner=context?.owner;
  if(!output||!owner?.host.sourceOutput)return operation();
  return owner.host.sourceOutput({output,parentSessionId:owner.parentSessionId,operationId:context.operationId},operation);
}

// Transport options are owner-attested, never taken from model/source machine objects.
state.machineConnections ??= new WeakMap();
export function resolveHostMachinePlacement(input) {
  const owner=state.operations.getStore()?.owner??state.owners.get(canonical(input.cwd));
  if(!owner){if(hostAgentDirectory())fail('Remote placement has no task-owned binding');return undefined;}
  if(isClosed(owner)||typeof owner.host.resolvePlacement!=='function')fail('Native remote placement is not configured by the task owner');
  const admitted=owner.host.resolvePlacement({machine:input.machine,requestedCwd:input.stepCwd,parentSessionId:owner.parentSessionId,operationId:state.operations.getStore()?.operationId});
  if(!admitted||admitted.then||admitted.machine?.provider!=='herdr')fail('Only an explicitly admitted Herdr placement is supported');
  const connection=admitted.connection;
  if(!connection||typeof connection.sshConfig!=='string'||!connection.sshConfig.startsWith('/')||/[\0\r\n]/.test(connection.sshConfig))fail('Remote placement requires an explicit absolute SSH configuration');
  const machine=Object.freeze({...admitted.machine});
  state.machineConnections.set(machine,Object.freeze({sshConfig:connection.sshConfig}));
  return {machine};
}
export function hostMachineConnection(machine) {return state.machineConnections.get(machine)??{};}

/** Fixed-runtime consumer transport; only the exact owner-admitted machine is accepted. */
export async function openHostRemoteAccess(machine) {
  const options=state.machineConnections.get(machine);
  if(!options)fail('Remote transport requires the original owner-admitted placement');
  const {sshMachineAccess}=await import('./herdr-connection.js');
  return sshMachineAccess(machine,options);
}

/** Materialize the frozen remote runtime only after the durable one-start claim. */
export async function prepareHostRemote(launch) {
  const saved=receiptFor(launch);if(!saved)return undefined;
  if(!saved.claimed||saved.remotePrepared)fail('Remote preparation requires an unused claimed launch');
  if(!saved.owner.host.prepareRemote)fail('Remote runtime adapter is not configured');
  saved.remotePrepared=true;
  if(launch.runtime?.permissions&&Object.keys(launch.runtime.permissions).length||launch.runtime?.toolBudget||launch.runtime?.mcpDirectTools?.length)fail('Remote native permission/budget/MCP policy needs an explicit adapter');
  const policy=await saved.owner.host.prepareRemote({launchId:launch.hostAdmission.launchId,toolNames:launch.tools,excludedTools:launch.excludeTools});
  if(isClosed(saved.owner))fail('Owner closed during remote preparation');
  return policy;
}
export async function stopHostRemote(launch) {
  const saved=receiptFor(launch,{cleanup:true});if(!saved)return undefined;
  if(!saved.owner.host.stopRemote)fail('Remote stop adapter is not configured');
  return saved.owner.host.stopRemote({launchId:launch.hostAdmission.launchId});
}

/** Host-only snapshot lookup: explicit settings bypass source .pi configuration. */
export async function resolveRegisteredHerdrProfile({selector,cwd,herdrBin,env}) {
  const {resolveHerdrMachinePlacement}=await import('./herdr-machine.js');
  if(selector==='local')fail('Rex local placement is not supported by the remote adapter');
  return resolveHerdrMachinePlacement({machine:selector,cwd,stepCwd:cwd,settings:{cwd},herdrBin,env}).machine;
}
export function remapHostMachine(machine,cwd) {
  const connection=state.machineConnections.get(machine);if(!connection)fail('Remote copy mapping requires admitted machine identity');
  if(typeof cwd!=='string'||!cwd.startsWith('/')||/[\0\r\n]/.test(cwd))fail('Invalid remote copy root');
  const mapped=Object.freeze({...machine,cwd});state.machineConnections.set(mapped,connection);return mapped;
}
