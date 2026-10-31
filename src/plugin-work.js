import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, chmodSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { inScope, withChangeQueue } from './versioning.js';
import { problem } from './task.js';
import { writePrivateJson, privateDirectory, acquireSessionWriter } from './storage.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const ended = new Set(['completed','failed','cancelled']);
export function helperBlockers(task, changeId) {
  return [...(task.record.work?.helpers??[]),...(task.record.tools??[]).filter(t=>t.nativeBackground)].filter(h => (!changeId || h.changeId === changeId) &&
    (!ended.has(h.status) || !h.stoppedAt || !['adopted','rejected'].includes(h.treatment?.decision) ||
      (h.import && (h.import.status!=='applied' || h.treatment?.decision!=='adopted'))));
}
export function assertHelpersHandled(task, changeId) {
  const pending = helperBlockers(task, changeId);
  if (pending.length) throw problem('HELPERS_PENDING', JSON.stringify(pending.map(h=>({helperId:h.helperId,status:h.status,treatment:h.treatment??null}))));
}
function safePath(path) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || /[\\\0]/.test(path) || path.split('/').some(p=>!p || p==='.' || p==='..' || p.toLowerCase()==='.git'))
    throw problem('HELPER_PATH','Unsafe helper result path: '+path);
  return path;
}
function scan(root, authoritative = {}) {
  const files = {}, aliases = new Map();
  function walk(dir, prefix='') {
    for (const name of readdirSync(dir).sort()) {
      const path=safePath(prefix+name), folded=path.normalize('NFC').toLowerCase();
      if (aliases.has(folded)) throw problem('HELPER_PATH','Case/Unicode alias: '+path);
      aliases.set(folded,path);
      const abs=join(root,path), stat=lstatSync(abs);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink!==1))
        throw problem('HELPER_FILE_TYPE','Helper produced a link or unsupported file: '+path);
      if (stat.isDirectory()) walk(abs,path+'/');
      else { const bytes=readFileSync(abs); files[path]={contentHash:digest(bytes),contentBase64:bytes.toString('base64'),mode:process.platform==='win32'?(authoritative[path]?.mode??'100644'):stat.mode&0o111?'100755':'100644'}; }
    }
  }
  walk(root); return files;
}

/** Each copy is assembled only from public reads, under the same consumer change queue. */
export async function snapshotHelper({versioning, change, directory}) {
  return withChangeQueue(versioning,change.changeId,async()=>{
    const current=await versioning.inspect({changeId:change.changeId});
    if (['accepted','abandoned','interrupted','outcome_unknown'].includes(current.status))
      throw problem('CHANGE_CLOSED','Helper cannot snapshot a closed or uncertain change');
    const ranges=[...new Set([...current.scope,...current.readScope])], files={}, observations=[];
    let inputVersion;
    function observe(result,path,kind) {
      inputVersion ??= result.version;
      if (result.version!==inputVersion) throw problem('HELPER_SNAPSHOT_CHANGED','Public reads returned different versions');
      observations.push({path,kind,version:result.version,fingerprint:result.fingerprint??result.contentHash});
    }
    for (const range of ranges) {
      if (range!=='.') {
        const file=await versioning.read({changeId:change.changeId,path:range,kind:'file'}); observe(file,range,'file');
        if (file.contentBase64!==null) {files[range]=file; continue;}
      }
      const tree=await versioning.read({changeId:change.changeId,path:range,kind:'tree'}); observe(tree,range,'tree');
      for (const entry of tree.entries) {
        safePath(entry.path);
        if (!inScope(entry.path,ranges)) throw problem('SCOPE','Public tree returned out-of-scope file');
        const file=await versioning.read({changeId:change.changeId,path:entry.path,kind:'file'}); observe(file,entry.path,'file');
        files[entry.path]=file;
      }
    }
    if (!inputVersion || inputVersion!==current.privateVersion) throw problem('HELPER_SNAPSHOT_CHANGED','Snapshot version not current');
    privateDirectory(directory);
    for (const [path,file] of Object.entries(files)) {
      safePath(path);
      if (!['100644','100755'].includes(file.mode) || file.contentBase64===null) throw problem('HELPER_FILE_TYPE','Unsupported input: '+path);
      mkdirSync(dirname(join(directory,path)),{recursive:true});
      writeFileSync(join(directory,path),Buffer.from(file.contentBase64,'base64')); chmodSync(join(directory,path),file.mode==='100755'?0o755:0o644);
    }
    return {inputVersion,files,observations,scope:current.scope,readScope:current.readScope,readOnly:current.readOnly};
  });
}

export function freezeHelperResult(helper, helpers = []) {
  if (!helper.stoppedAt) throw problem('HELPER_RUNNING','Cannot freeze until the writer stopped');
  if (helpers.some(h => h.parentHelperId === helper.helperId && (!h.stoppedAt || !ended.has(h.status))))
    throw problem('HELPERS_PENDING','Descendant writer stop is not confirmed');
  // Preserve entire directory even on rejection; never truncate illegal results into success.
  const files=scan(helper.cwd,helper.snapshot.files), edits=[];
  for (const path of [...new Set([...Object.keys(helper.snapshot.files),...Object.keys(files)])].sort()) {
    const before=helper.snapshot.files[path], after=files[path];
    if (before?.contentHash===after?.contentHash && before?.mode===after?.mode) continue;
    edits.push({path,oldHash:before?.contentHash??null,contentBase64:after?.contentBase64??null,...(after?{mode:after.mode}:{})});
  }
  const outside=edits.filter(e=>helper.readOnly || !inScope(e.path,helper.scope));
  const result={files,edits,digest:digest(JSON.stringify(edits)),frozenAt:new Date().toISOString()};
  helper.result=result;
  if(outside.length) throw problem('SCOPE','Helper result contains unauthorized writes: '+outside.map(e=>e.path).join(', '));
  return result;
}

/** Review/import operations are bound to the creator. Nested results first return to that creator's copy. */
export async function treatHelperResult({task,versioning,helper,actor,binding,decision,reason,assertAllowed=()=>{},signal}) {
  const effectiveSignal=signal?AbortSignal.any([task.signal,signal]):task.signal;
  const currentAuthority=()=>{assertAllowed();if(effectiveSignal.aborted||task.record.cancelRequestedAt)throw problem('CANCELLED','Late helper result cannot import');};
  if (!['adopt','reject'].includes(decision) || !reason?.trim()) throw problem('HELPER_REVIEW','Explicit adopt/reject and review reasons required');
  if(helper.parentActorId!==actor) throw problem('HELPER_PARENT','Only the creator can treat this helper result');
  if(!helper.stoppedAt || !ended.has(helper.status)) throw problem('HELPER_RUNNING','Writer stop not confirmed');
  if([...(task.record.work.helpers??[]),...(task.record.tools??[]).filter(t=>t.nativeBackground)].some(h=>h.parentHelperId===helper.helperId && !['adopted','rejected'].includes(h.treatment?.decision))) throw problem('HELPERS_PENDING','Treat descendants first');
  if (helper.import) {
    const fact = await recoverHelperImport({task,versioning,helper,binding});
    if (fact.status === 'applied') {
      if(decision==='reject') throw problem('HELPER_IMPORT_APPLIED','Original import is already applied; rejecting its text cannot undo source. Use an explicit compensating edit and normal review.');
      return fact;
    }
    throw problem('OPERATION_UNKNOWN','Import already has an identity; inspect the original requestId, never replay: '+helper.import.requestId);
  }
  if(helper.treatment) throw problem('HELPER_REVIEW','Result already handled');
  if(decision==='reject') {helper.treatment={decision:'rejected',reason,at:new Date().toISOString()};task.save();return helper.treatment;}
  if(helper.status!=='completed' || helper.resultError || !helper.result) throw problem('HELPER_RESULT','Failed/invalid result cannot be adopted');
  if (!helper.result.edits.length) {
    currentAuthority();
    helper.treatment={decision:'adopted',reason,at:new Date().toISOString()}; task.save();
    return {status:'text_adopted',helperId:helper.helperId};
  }
  return withChangeQueue(versioning,helper.changeId,async()=>{
    currentAuthority();
    const current=await versioning.inspect({changeId:helper.changeId});
    currentAuthority();
    if(binding.current.changeId!==helper.changeId || current.readOnly || ['accepted','abandoned','interrupted'].includes(current.status)) throw problem('CHANGE_CLOSED','Helper authorization no longer current');
    for(const edit of helper.result.edits) if(!inScope(edit.path,current.scope)||!inScope(edit.path,helper.scope)) throw problem('SCOPE','Helper import exceeds scope');
    if(current.privateVersion!==helper.inputVersion) throw problem('STALE_PRIVATE','Helper input A differs from current parent C. Inspect A/B/C and provide feedback; expectedVersion is not replaced.');
    currentAuthority();
    const intent={requestId:randomUUID(),expectedVersion:helper.inputVersion,digest:helper.result.digest,status:'pending'};
    helper.import=intent;task.save();
    try {
      currentAuthority();
      const fact=await versioning.edit(helper.changeId,{requestId:intent.requestId,expectedVersion:intent.expectedVersion,edits:helper.result.edits},{signal:effectiveSignal});
      if(fact.status!=='applied') throw problem('OPERATION_UNKNOWN',JSON.stringify(fact));
      Object.assign(intent,{status:'applied',receipt:fact});
      Object.assign(binding.current,await versioning.inspect({changeId:helper.changeId}));
      binding.reviewedVersion=null;
      helper.treatment={decision:'adopted',reason,at:new Date().toISOString()};task.save();return fact;
    } catch(error) {intent.status='outcome_unknown';intent.error=error.message;task.save();throw error;}
  });
}

export async function recoverHelperImport({task,versioning,helper,binding}) {
  if(!helper.import?.requestId) throw problem('HELPER_IMPORT','No saved import request');
  const alreadyApplied=helper.import.status==='applied'&&helper.treatment?.decision==='adopted';
  const fact=await versioning.inspect({requestId:helper.import.requestId});
  if(fact.status==='applied') {
    helper.import.status='applied';helper.import.receipt=fact;
    if(!alreadyApplied)helper.treatment={decision:'adopted',reason:'Recovered original requestId receipt',at:new Date().toISOString()};
    if(!alreadyApplied&&binding?.current?.changeId===helper.changeId) {Object.assign(binding.current,await versioning.inspect({changeId:helper.changeId}));binding.reviewedVersion=null;}
    task.save();
  }
  return fact;
}

// Deliberately one plugin adapter, not a generic process/plugin platform.
async function createHelperWork({task,versioning,execution,maxOutputTokens,remoteMachines}) {
  const { fork, spawn }=await import('node:child_process');
  const { fileURLToPath }=await import('node:url');
  const { Type }=await import('typebox');
  const { existsSync, cpSync, rmSync, realpathSync }=await import('node:fs');
  const { inspectPluginCompatibility }=await import('./plugin-compatibility.js');
  const resourceRoot=join(task.home,'tasks',task.record.id+'-resources');privateDirectory(resourceRoot);
  task.record.work.skillResources=[];
  for(const skill of task.answerSkills??[]) {
    safePath(skill.name);
    if(digest(readFileSync(skill.path))!==skill.hash)throw problem('SKILL_CHANGED','Frozen main skill changed before work: '+skill.name);
    const destination=join(resourceRoot,skill.name);privateDirectory(destination);
    // Freeze only declared skill material, never an arbitrary ancestor (which may be COTHINK_HOME).
    writeFileSync(join(destination,'SKILL.md'),readFileSync(skill.path));
    const paths=new Set(['references','scripts','assets','templates']),explicit=new Set(),unavailable=[];
    for(const match of skill.body.matchAll(/\]\(([^)\s]+)\)|`([^`\n\s]+)`/g)) {
      const path=match[1]??match[2];
      if(path&&!path.includes(':')&&!path.startsWith('#')){const relative=path.replace(/\/$/,'');paths.add(relative);explicit.add(relative);}
    }
    for(const path of paths) {
      try {safePath(path);}catch {if(explicit.has(path))unavailable.push({path,reason:'Resource path escapes the selected skill directory or is unsupported'});continue;}
      const source=join(dirname(skill.path),path);
      if(!existsSync(source)){if(explicit.has(path))unavailable.push({path,reason:'Referenced resource is missing'});continue;}
      mkdirSync(dirname(join(destination,path)),{recursive:true});cpSync(source,join(destination,path),{recursive:true,dereference:false});
    }
    const files=scan(destination);
    task.record.work.skillResources.push({name:skill.name,sourceDirectory:dirname(skill.path),root:destination,unavailable,files:Object.fromEntries(Object.entries(files).map(([path,file])=>[path,file.contentHash]))});
  }
  task.save();
  const root=task.packageSnapshot?.packages?.find(p=>p.name==='pi-subagents'&&p.version==='0.84.0'&&p.installedPath&&task.packageSnapshot.extensions.some(path=>realpathSync(path)===realpathSync(join(p.installedPath,'bundle/index.js'))))?.installedPath ?? join(task.home,'pi/npm/node_modules/pi-subagents');
  if(!existsSync(join(root,'package.json')))return {tools:()=>[],close:async()=>{},assertHandled:()=>{}};
  const selected=task.packageSnapshot?.packages?.some(p=>p.name==='pi-subagents'&&p.version==='0.84.0') &&
    task.packageSnapshot?.extensions?.some(path=>realpathSync(path)===realpathSync(join(root,'bundle/index.js')));
  if(!selected)return {tools:()=>[],close:async()=>{},assertHandled:()=>{}};
  const compatibility=inspectPluginCompatibility(root);
  if(!compatibility)throw problem('PLUGIN_COMPATIBILITY','Reinstall pi-subagents@0.84.0 to prepare the disclosed CoThink compatibility patch');
  const integration=await import((await import('node:url')).pathToFileURL(join(root,'src/runs/shared/host-integration.js')));
  const {freezeRemoteProfiles,selectRemoteProfile,prepareRemoteHelper}=await import('./native-remote.js');
  const remoteProfiles=await freezeRemoteProfiles(remoteMachines,integration,{directory:join(task.home,'tasks',task.record.id+'-remote-ssh')}),remoteAttempts=new Map();
  task.record.work.remoteProfiles=[...remoteProfiles].map(([selector,p])=>({selector,machine:p.machine,stagingRoot:p.stagingRoot,execution:p.execution??null,runtimeHashes:p.runtime.hashes,sshConfigDigest:p.sshConfigDigest}));task.save();
  const handles=new Map(), actors=new Map(), nativeSessions=new Map(), nativeSessionFiles=new Map(), nativeClosers=[];
  const nativeOwnerInstance=randomUUID();
  const runnerHandles=new Map();let broker,brokerPending,nativeClosing=false;
  const backgroundRecords=()=> (task.record.tools??[]).filter(t=>t.nativeBackground);
  const brokerReady=()=>{
    if(nativeClosing)return Promise.reject(problem('CANCELLED','Native owner is closing'));
    if(broker)return Promise.resolve(broker);
    return brokerPending??=(async()=>{const created=await (await import('./native-background.js')).createNativeBroker({task,epoch:nativeOwnerInstance});if(nativeClosing){await created.close();throw problem('CANCELLED','Native owner closed during broker initialization');}broker=created;return created;})().catch(error=>{brokerPending=undefined;throw error;});
  };
  const nativeModelContracts=new Map();
  const sourceQueues=new Map();
  const sourceOperation=(actor,operation)=>{
    const run=(sourceQueues.get(actor)??Promise.resolve()).catch(()=>{}).then(operation);
    sourceQueues.set(actor,run);return run;
  };
  const shellHandles=new Map();
  const work=task.record.work;work.helpers??=[];
  const runtimeBase=join(task.home,'tasks',task.record.id+'-helpers','runtime-base');privateDirectory(runtimeBase);
  work.helperRuntime={files:{}};
  for(const name of ['models.json','auth.json'])if(existsSync(join(task.home,'pi',name))) {
    const bytes=readFileSync(join(task.home,'pi',name));writeFileSync(join(runtimeBase,name),bytes,{mode:0o600});work.helperRuntime.files[name]=digest(bytes);
  }
  task.save();
  const plugin={name:'pi-subagents',version:'0.84.0',compatibility};
  // Preserve upstream depth (2) and per-run spawn ceiling (64) across process boundaries.
  // These are plugin limits, not new CoThink model call/time budgets.
  const limits={maxDepth:Number(process.env.PI_SUBAGENT_MAX_DEPTH??2),maxSpawnsPerRun:Number(process.env.PI_SUBAGENT_MAX_SPAWNS_PER_RUN??64)};
  if(!Number.isSafeInteger(limits.maxDepth)||limits.maxDepth<0||!Number.isSafeInteger(limits.maxSpawnsPerRun)||limits.maxSpawnsPerRun<1)throw problem('PLUGIN_LIMITS','Invalid inherited pi-subagents depth/spawn limits');
  work.helperLimits={...limits,source:'pi-subagents@0.84.0 defaults / explicit environment'};
  const guard=()=>{if(task.signal.aborted||task.record.cancelRequestedAt||task.record.status!=='running')throw problem('CANCELLED','Task no longer permits helpers');};
  const actorGuard=state=>{guard();state.assertAllowed?.();if(state.signal?.aborted||state.helper?.cancelRequestedAt)throw problem('CANCELLED','Creator no longer permits helper work');};
  const view=h=>({helperId:h.helperId,parentActorId:h.parentActorId,parentHelperId:h.parentHelperId,status:h.status,stoppedAt:h.stoppedAt??null,text:h.text??null,resultError:h.resultError??null,
    diff:h.result?.edits.map(e=>({path:e.path,oldHash:e.oldHash,mode:e.mode,contentBase64:e.contentBase64})),treatment:h.treatment??null,import:h.import??null,usage:h.usage??null});
  async function allocate(actor,assignment,parentHelper,toolSignal,nativeSpec) {
    guard();const state=actors.get(actor);if(!state)throw problem('HELPER_PARENT','Unknown creator');
    actorGuard(state);if(toolSignal?.aborted)throw problem('CANCELLED','Helper tool was aborted');
    if(/(?:不使用|不要|禁止).{0,8}(?:子代理|助手)|\bno\s+(?:subagents?|helpers?)\b|\bdo not use\s+(?:subagents?|helpers?)\b/i.test(task.record.input))throw problem('HELPERS_DISABLED','Original user task disables helpers');
    const depth=(parentHelper?.depth??0)+1;
    if(depth>limits.maxDepth)throw problem('PLUGIN_DEPTH','pi-subagents depth limit reached: '+limits.maxDepth);
    if(work.helpers.length>=limits.maxSpawnsPerRun)throw problem('PLUGIN_SPAWNS','pi-subagents per-run spawn limit reached');
    const helperId=randomUUID(),directory=join(task.home,'tasks',task.record.id+'-helpers',helperId);
    privateDirectory(directory);const cwd=join(directory,'source');
    const h={helperId,parentActorId:actor,...(parentHelper?{parentHelperId:parentHelper.helperId}:{}),depth,changeId:state.binding.current.changeId,
      originalTask:task.record.input,assignment,plugin,model:nativeSpec?.model ? {provider:nativeSpec.model.split('/')[0],modelId:nativeSpec.model.split('/').slice(1).join('/').replace(/:(off|minimal|low|medium|high|xhigh|max)$/,'')} : state.model,native:nativeSpec ? {runId:nativeSpec.runId,agent:nativeSpec.childAgentName,childIndex:nativeSpec.childIndex,model:nativeSpec.model,thinking:nativeSpec.thinking??null} : undefined,effectiveOutputCap:maxOutputTokens??state.model.maxOutputTokens??null,status:'queued',usage:null,usageSource:'pi-subagents public delegation; catalog-derived cost, not provider billing',directory,cwd,createdAt:new Date().toISOString()};
    h.catalogPricing=nativeSpec?null:state.getPricing?.()??null;
    if(nativeSpec){h.effectiveOutputCap=maxOutputTokens??null;h.usageSource='Actual SDK stream observations; provider cost unavailable';}
    work.helpers.push(h);task.save(); // Intent precedes snapshot and process creation.
    try {
      const origin=nativeSpec?.sourceBinding??parentHelper;
      if(origin) {
        if(state.binding.current.changeId!==origin.changeId||state.binding.current.readOnly&&!origin.snapshot.readOnly||origin.snapshot.scope.some(path=>!inScope(path,state.binding.current.scope))||origin.snapshot.readScope.some(path=>!inScope(path,[...state.binding.current.scope,...state.binding.current.readScope])))throw problem('HELPER_AUTHORITY','Creator copy belongs to an older or narrowed authority; reconcile it explicitly');
        h.snapshot=structuredClone(origin.snapshot);h.changeId=origin.changeId;
        // Creator's scoped source tools serialize the launch RPC with writes/shell; no common change queue is held while waiting.
        const files=scan(origin.cwd,origin.snapshot.files);
        h.snapshot.publicBaseline??={inputVersion:h.snapshot.inputVersion,observations:h.snapshot.observations};
        h.snapshot.creatorHelperId=origin.helperId??null;h.snapshot.creatorInputDigest=digest(JSON.stringify(files));h.snapshot.files=files;
        privateDirectory(cwd);
        for(const [path,file] of Object.entries(files)){mkdirSync(dirname(join(cwd,path)),{recursive:true});writeFileSync(join(cwd,path),Buffer.from(file.contentBase64,'base64'));chmodSync(join(cwd,path),file.mode==='100755'?0o755:0o644);}
      }else h.snapshot=await snapshotHelper({versioning,change:state.binding.current,directory:cwd});
      Object.assign(h,{inputVersion:h.snapshot.inputVersion,scope:h.snapshot.scope,readScope:h.snapshot.readScope,readOnly:h.snapshot.readOnly});
      const home=join(directory,'runtime');privateDirectory(join(home,'pi'));
      for(const name of ['models.json','auth.json'])if(existsSync(join(runtimeBase,name)))cpSync(join(runtimeBase,name),join(home,'pi',name));
      writePrivateJson(join(home,'pi/settings.json'),{retry:{enabled:false,provider:{maxRetries:0,timeoutMs:0}},compaction:{enabled:false},cacheWarming:'off',httpIdleTimeoutMs:0,packages:[]});
      const resources=join(directory,'resources');privateDirectory(resources);
      const skills=[];
      for(const skill of task.answerSkills??[]) {
        // Resources remain outside source delta. Copy now, never discover ambient skills.
        const destination=join(resources,skill.name);cpSync(join(resourceRoot,skill.name),destination,{recursive:true,dereference:false});
        skills.push({...skill,path:join(destination,'SKILL.md')});
      }
      const input={helperId,taskId:task.record.id,packageHome:task.home,home,cwd,pluginRoot:root,model:h.model,assignment,frozenSkills:skills,
        systemPrompt:`You are helper ${helperId}; creator=${actor}; original task follows verbatim. Work only in your independent copy. Do not claim acceptance. Treat nested results explicitly before final delivery.\nOriginal user input:\n${task.record.input}\nFrozen skills: ${JSON.stringify(skills)}\nTask resources: ${resources}\nWrite scope=${JSON.stringify(h.scope)}; readOnly=${h.readOnly}.`};
      writePrivateJson(join(directory,'launch.json'),input);actorGuard(state);if(toolSignal?.aborted)throw problem('CANCELLED','Helper tool was aborted');task.save();
      return {h,state,home,resources,input};
    }catch(error){h.status='failed';h.error={code:error.code,message:error.message};h.stoppedAt=new Date().toISOString();task.save();throw error;}
  }
  async function launch(actor,assignment,parentHelper,toolSignal) {
    const {h,state,home,resources,input}=await allocate(actor,assignment,parentHelper,toolSignal);
    const helperId=h.helperId,directory=h.directory,cwd=h.cwd;
    try {
      const env={...process.env,PI_CODING_AGENT_DIR:join(home,'pi'),PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT:fileURLToPath(new URL('../node_modules/@earendil-works/pi-coding-agent',import.meta.url)),
        COTHINK_HELPER_CWD:cwd,COTHINK_HELPER_RESOURCES:resources,COTHINK_HELPER_SCOPE:JSON.stringify(h.scope),COTHINK_HELPER_READONLY:h.readOnly?'1':'0',COTHINK_HELPER_OUTPUT_CAP:h.effectiveOutputCap===null?'':String(h.effectiveOutputCap),PI_SUBAGENT_MAX_DEPTH:String(limits.maxDepth)};
      const child=fork(fileURLToPath(new URL('./plugin-helper-runner.js',import.meta.url)),[join(directory,'launch.json')],{cwd,env,stdio:['ignore','pipe','pipe','ipc']});
      h.process={pid:child.pid,launchId:helperId};h.status='running';
      actors.set(helperId,{...state,helper:h});
      let shutdown=false,releaseWait;
      const observed=new Promise(resolve=>releaseWait=resolve);
      const exit=new Promise(resolveExit=>{
        child.stdout.on('data',data=>writeFileSync(join(directory,'stdout.log'),data,{flag:'a'}));
        child.stderr.on('data',data=>writeFileSync(join(directory,'stderr.log'),data,{flag:'a'}));
        child.on('message',message=>{
          if(message.type==='rpc')void (async()=>{
            try {
              let value;
              if(message.action==='launch')value=await launch(helperId,message.args.assignment,h);
              else if(message.action==='result')value=await result(helperId,message.args);
              else if(message.action==='exec')value=await execute(h,message.args.command,resources);
              else throw problem('HELPER_RPC','Unsupported action');
              if(child.connected)child.send({type:'rpc-result',id:message.id,value});
            }catch(error){if(child.connected)child.send({type:'rpc-result',id:message.id,error:{code:error.code,message:error.message}});}
          })();
          else if(message.type==='response') {h.pluginResponse=message.data;h.pluginReportedUsage=message.data.usage??null;h.usage=message.data.status==='completed'&&(h.requestObservations?.length??0)>0&&h.requestObservations.every(r=>r.usageSeen&&r.status!=='error'&&r.status!=='aborted')?message.data.usage??null:null;if(h.usage&&!Object.values(h.catalogPricing??{}).some(price=>typeof price==='number'&&price>0))h.usage={...h.usage,cost:null};h.text=message.data.result?.text??null;task.save();}
          else if(message.type==='request-observation') {(h.requestObservations??=[]).push(message.data);task.save();}
          else if(message.type==='shutdown-ready') {
            void (async()=>{
              await Promise.all(work.helpers.filter(x=>x.parentHelperId===h.helperId).map(x=>handles.get(x.helperId)?.exit));
              await Promise.all([...shellHandles.values()].filter(s=>s.helper.helperId===h.helperId).map(s=>s.settled));
              if(child.connected)child.send({type:'release'});
            })().catch(error=>{h.error={message:error.message};task.save();});
          }
          else if(message.type==='update') {h.pluginRunId=message.data.runId??h.pluginRunId;h.observedUsage=message.data.usage??null;task.save();}
          else if(message.type==='cancelled-before-launch') {h.cancelledBeforeLaunch=true;task.save();}
          else if(message.type==='shutdown') {shutdown=true;h.shutdownEvidence={at:new Date().toISOString(),kind:h.cancelledBeforeLaunch?'cancelled before delegation + SDK disposal + process exit':'plugin response + SDK abort/dispose + process exit'};}
          else if(message.type==='fatal') {h.error=message.error;task.save();}
        });
        child.on('error',error=>{h.error={message:error.message};});
        child.on('exit',async(code,signal)=>{
          h.exit={code,signal,at:new Date().toISOString()};
          const descendants=work.helpers.filter(x=>x.parentHelperId===h.helperId);
          await Promise.all(descendants.map(x=>handles.get(x.helperId)?.exit));
          await Promise.all([...shellHandles.values()].filter(s=>s.helper.helperId===h.helperId).map(s=>s.settled));
          if(shutdown&&code===0&&descendants.every(x=>x.stoppedAt)&&![...shellHandles.values()].some(s=>s.helper.helperId===h.helperId)) {
            h.stoppedAt=h.exit.at;h.status=h.cancelledBeforeLaunch?'cancelled':h.pluginResponse?.status==='completed'?'completed':h.pluginResponse?.status==='cancelled'?'cancelled':'failed';
            try{freezeHelperResult(h,[...work.helpers,...backgroundRecords()]);}catch(error){h.resultError={code:error.code,message:error.message};}
          }else {h.status='outcome_unknown';h.error??={message:'No complete tracked shutdown evidence'};}
          try{task.save();}catch(error){task.ioError=error;}finally{resolveExit();releaseWait();}
        });
      });
      handles.set(helperId,{child,exit,releaseWait});task.save();
      const abort=()=>{void stopHelpers([h,...ownedHelpers(h.helperId)]).catch(error=>{h.stopError=error.message;task.save();});};
      toolSignal?.addEventListener('abort',abort,{once:true});
      if(toolSignal?.aborted)abort();
      try {await observed;return view(h);} finally {toolSignal?.removeEventListener('abort',abort);}
    }catch(error){h.status=h.process?'outcome_unknown':'failed';h.error={code:error.code,message:error.message};if(!h.process)h.stoppedAt??=new Date().toISOString();else if(handles.get(helperId)?.child.connected)handles.get(helperId).child.send({type:'cancel'});task.save();throw error;}
  }
  async function result(actor,args,toolSignal) {
    const h=[...work.helpers,...backgroundRecords()].find(x=>x.helperId===args.helperId);if(!h||h.parentActorId!==actor)throw problem('HELPER_PARENT','Result does not belong to creator');
    if(args.decision==='inspect') {
      if(h.import?.status==='outcome_unknown') await recoverHelperImport({task,versioning,helper:h,binding:actors.get(actor)?.binding});
      return view(h);
    }
    const state=actors.get(actor);
    if(state.helper) {
      const currentAuthority=()=>{actorGuard(state);if(toolSignal?.aborted)throw problem('CANCELLED','Creator result tool was aborted');};
      currentAuthority();if(!args.reason?.trim())throw problem('HELPER_REVIEW','Concrete review reason required');
      if(!h.stoppedAt||helperBlockers(task).some(x=>x.parentHelperId===h.helperId))throw problem('HELPERS_PENDING','Nested result/descendant not stopped and handled');
      if(h.treatment)throw problem('HELPER_REVIEW','Already treated');
      if(args.decision==='adopt') {
        if(h.status!=='completed'||h.resultError||!h.result)throw problem('HELPER_RESULT','Invalid result');
        const current=scan(state.helper.cwd,state.helper.snapshot.files);
        const basis=Object.fromEntries(Object.entries(h.snapshot.files).map(([p,f])=>[p,[f.contentHash,f.mode]]));
        const now=Object.fromEntries(Object.entries(current).map(([p,f])=>[p,[f.contentHash,f.mode]]));
        if(JSON.stringify(Object.entries(basis).sort())!==JSON.stringify(Object.entries(now).sort()))throw problem('STALE_PRIVATE','Creator source C differs from complete nested input A; preserve B and provide feedback');
        for(const e of h.result.edits)if((current[e.path]?.contentHash??null)!==e.oldHash)throw problem('STALE_PRIVATE','Nested input A differs from creator C; provide feedback');
        currentAuthority();
        for(const e of h.result.edits) {const path=join(state.helper.cwd,e.path);if(e.contentBase64===null)unlinkSync(path);else{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,Buffer.from(e.contentBase64,'base64'));chmodSync(path,e.mode==='100755'?0o755:0o644);}}
      }else if(args.decision!=='reject')throw problem('HELPER_REVIEW','Invalid treatment');
      h.treatment={decision:args.decision==='adopt'?'adopted':'rejected',reason:args.reason,at:new Date().toISOString(),destinationHelperId:state.helper.helperId};task.save();return view(h);
    }
    const signals=[state.signal,toolSignal].filter(Boolean);
    return treatHelperResult({task,versioning,helper:h,actor,binding:state.binding,decision:args.decision,reason:args.reason,assertAllowed:()=>actorGuard(state),signal:signals.length?AbortSignal.any(signals):undefined});
  }
  async function execute(h,command,resources,toolSignal) {
    const state=actors.get(h.helperId);actorGuard(state);
    const signal=AbortSignal.any([task.signal,state.signal,toolSignal].filter(Boolean));
    if(signal.aborted)throw problem('CANCELLED','Command owner/tool has stopped');
    if(!execution?.image||execution.network!==false&&execution.network!=='none')throw problem('EXECUTION_REQUIRED','A configured fixed offline Docker image is required');
    const id='cothink-helper-'+randomUUID(),trace={id,command,status:'pending'};(h.executions??=[]).push(trace);task.save();
    const args=['create','--name',id,'--rm','--network','none','--cap-drop','ALL','--security-opt','no-new-privileges',
      ...(execution.limits?.memoryBytes?['--memory',String(execution.limits.memoryBytes)]:[]),...(execution.limits?.cpus?['--cpus',String(execution.limits.cpus)]:[]),...(execution.limits?.pids?['--pids-limit',String(execution.limits.pids)]:[]),
      '-v',h.cwd+':/workspace'+(h.readOnly?':ro':''),'-v',resources+':/resources:ro','-w','/workspace',execution.image,'sh','-lc',command];
    const {promisify}=await import('node:util');const {execFile}=await import('node:child_process');
    let resolveShell;const settled=new Promise(resolve=>resolveShell=resolve);
    const stop=()=>{const killer=spawn('docker',['rm','-f',id],{stdio:'ignore'});killer.on('error',()=>{});};
    shellHandles.set(id,{stop,trace,helper:h,settled});
    signal.addEventListener('abort',stop,{once:true});
    try {
      await promisify(execFile)('docker',args);
      if(signal.aborted||h.cancelRequestedAt){await promisify(execFile)('docker',['rm','-f',id]);trace.status='cancelled';throw problem('CANCELLED','Cancelled before Docker start');}
    } catch(error) {
      signal.removeEventListener('abort',stop);
      if(error.code==='CANCELLED'){shellHandles.delete(id);resolveShell();}
      else {trace.status='outcome_unknown';trace.error=error.message;}
      task.save();throw error;
    }
    return await new Promise((resolveExec,reject)=>{
      const child=spawn('docker',['start','-a',id],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';trace.status='running';task.save();
      child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
      child.on('error',error=>{trace.status='outcome_unknown';trace.error=error.message;task.save();reject(error);});
      child.on('exit',code=>{signal.removeEventListener('abort',stop);shellHandles.delete(id);resolveShell();trace.status=code===0?'completed':'failed';trace.exitCode=code;trace.stdout=stdout;trace.stderr=stderr;task.save();resolveExec(trace);});
    });
  }
  function ownedHelpers(actor) {
    const ids=new Set([actor]);let changed=true;
    while(changed){changed=false;for(const h of work.helpers)if(ids.has(h.parentActorId)&&!ids.has(h.helperId)){ids.add(h.helperId);changed=true;}}
    return work.helpers.filter(h=>ids.has(h.helperId));
  }
  async function stopHelpers(targets) {
    const ids=new Set(targets.map(h=>h.helperId)),errors=[];
    const save=()=>{try{task.save();}catch(error){errors.push(error);}};
    for(const h of targets)if(!h.stoppedAt)h.cancelRequestedAt??=new Date().toISOString();
    save();
    for(const h of targets){
      const handle=handles.get(h.helperId),child=handle?.child;
      try{if(child?.connected)child.send({type:'cancel'});}catch(error){errors.push(error);}
      try{if(handle?.abort)void handle.abort().catch(error=>{h.stopError=error.message;task.ioError??=error;save();});}catch(error){errors.push(error);}
    }
    for(const shell of shellHandles.values())if(ids.has(shell.helper.helperId))try{shell.stop();}catch(error){errors.push(error);}
    let timer;
    // A cleanup safeguard, never a model execution deadline. Expiry retains unknown stop facts.
    await Promise.race([Promise.all(targets.map(h=>handles.get(h.helperId)?.exit)),new Promise(resolve=>{timer=setTimeout(resolve,15000);})]);
    clearTimeout(timer);
    for(const h of targets)if(!h.stoppedAt&&(h.process||h.native)){h.status='outcome_unknown';h.stopError='Cleanup did not confirm tracked writer exit';const handle=handles.get(h.helperId);handle?.releaseWait?.();handle?.child?.unref();if(handle?.child?.connected)try{handle.child.disconnect();}catch(error){errors.push(error);}}
    for(const shell of shellHandles.values())if(ids.has(shell.helper.helperId)){shell.trace.status='outcome_unknown';shell.helper.status='outcome_unknown';delete shell.helper.stoppedAt;}
    save();if(errors.length)throw new AggregateError(errors,'Helper cleanup encountered errors; every owned stop was attempted');
  }
  const stopRunners=async(actor)=>{
    const owners=actor?new Set([actor,...ownedHelpers(actor).map(h=>h.helperId)]):null;
    const records=backgroundRecords().filter(r=>!r.stoppedAt&&(!owners||owners.has(r.parentActorId))),errors=[];
    for(const r of records){r.cancelRequestedAt??=new Date().toISOString();try{broker?.signal(r.runnerId,{action:'stop'});}catch(error){errors.push(error);}}
    try{task.save();}catch(error){errors.push(error);}
    let timer;await Promise.race([Promise.all(records.map(r=>runnerHandles.get(r.runnerId)?.closed)),new Promise(resolve=>timer=setTimeout(resolve,15000))]);clearTimeout(timer);
    for(const r of records)if(!r.stoppedAt){r.status='outcome_unknown';r.stopError='Original native process close not observed';}
    try{task.save();}catch(error){errors.push(error);}
    if(errors.length)throw new AggregateError(errors,'Runner cleanup encountered errors; every owned stop was attempted');
  };
  const close=async()=>{nativeClosing=true;const errors=[];if(brokerPending)try{await brokerPending;}catch(error){if(error.code!=='CANCELLED')errors.push(error);}try{await stopRunners();}catch(error){errors.push(error);}for(const closer of nativeClosers)try{await closer();}catch(error){errors.push(error);}try{await stopHelpers([...new Set([...work.helpers,...[...shellHandles.values()].map(shell=>shell.helper)])]);}catch(error){errors.push(error);}if([...shellHandles.values()].some(shell=>shell.helper.kind==='native_host_command'))errors.push(problem('SHUTDOWN_UNKNOWN','Native workflow command cleanup remains unknown'));for(const remote of remoteAttempts.values())try{await remote.forward.close();}catch(error){errors.push(error);}if(broker)try{await broker.close();}catch(error){errors.push(error);}if(backgroundRecords().some(r=>!r.stoppedAt))errors.push(problem('SHUTDOWN_UNKNOWN','Native runner cleanup remains unknown'));if(errors.length)throw new AggregateError(errors,'Native/helper cleanup incomplete');};
  async function bindNative(actor,cwd,parentSessionId,getSourceBinding,sessionFile) {
    const {pathToFileURL}=await import('node:url');
    const {registerHostIntegration}=await import(pathToFileURL(join(root,'src/runs/shared/host-integration.js')));
    const {managedHelperExtension}=await import('./plugin-helper-extension.js');
    nativeSessions.set(parentSessionId,actor);
    if(sessionFile)nativeSessionFiles.set(parentSessionId,sessionFile);
    const parentFor=input=>{
      const parent=nativeSessions.get(input.parentSessionId);
      if(!parent)throw problem('HELPER_PARENT','Unknown native creator session');
      const state=actors.get(parent);actorGuard(state);return {parent,state};
    };
    const operationBases=new Map();
    const validateOutput=(output,parentSession,operationId)=>{
      const {state}=parentFor({parentSessionId:parentSession}),root=operationBases.get(operationId)?.source.cwd??state.helper?.cwd??cwd;
      const file=resolve(root,output);
      const inside=path=>path!==''&&!isAbsolute(path)&&!/^\.\.(?:[\\/]|$)/.test(path);
      let boundary=[root,realpathSync(root)].find(candidate=>inside(relative(candidate,file)));
      if(boundary) {
        const sourcePath=relative(boundary,file).replaceAll('\\','/');
        safePath(sourcePath);
        if(state.helper?.readOnly||state.binding.current.readOnly||!inScope(sourcePath,state.helper?.scope??state.binding.current.scope))throw problem('SCOPE','Native output exceeds creator write scope/read-only authority');
      }else {
        const parentFile=nativeSessionFiles.get(parentSession);
        const roots=parentFile?[join(dirname(parentFile),'subagent-artifacts'),join(realpathSync(dirname(parentFile)),'subagent-artifacts')]:[];
        boundary=roots.find(candidate=>inside(relative(candidate,file)));
        if(!boundary)throw problem('SCOPE','Native output is neither current scoped source nor its declared artifact root');
      }
      // Reject links at every existing component, including the declared root itself.
      let current=boundary;
      for(const part of ['',...relative(boundary,file).split(/[\\/]/)]) {
        if(part)current=join(current,part);
        try{const stat=lstatSync(current);if(stat.isSymbolicLink()||(!stat.isDirectory()&&(!stat.isFile()||stat.nlink!==1)))throw problem('SCOPE','Native output resolves through a link or special file');}catch(error){if(error.code!=='ENOENT')throw error;}
      }
      return file;
    };
    const host={agentDir:join(task.home,'pi'),
      resolvePlacement:({machine,requestedCwd})=>selectRemoteProfile(remoteProfiles,machine,requestedCwd),
      async closed(){const facts=await Promise.allSettled([stopRunners(actor),stopHelpers(ownedHelpers(actor))]);const errors=facts.filter(f=>f.status==='rejected').map(f=>f.reason);if(errors.length)throw new AggregateError(errors,'Native owner cleanup incomplete');},
      validateOutput:({output,parentSessionId,operationId})=>validateOutput(output,parentSessionId,operationId),
      sourceOutput:({parentSessionId},operation)=>{const {parent}=parentFor({parentSessionId});return sourceOperation(parent,operation);},
      async command(input) {
        const {parent,state}=parentFor(input),helper=state.helper;
        const directory=input.cwd,resources=helper?join(helper.directory,'resources'):resourceRoot;
        const roots=[helper?.cwd??cwd,...[...operationBases.values()].filter(value=>value.actor===parent).map(value=>value.source.cwd)];
        if(!roots.some(root=>realpathSync(root)===realpathSync(directory)))throw problem('SCOPE','Native command cwd has no registered creator source');
        const trace={name:'native_host_command',kind:'native_host_command',helperId:parent,parentActorId:parent,cwd:directory,readOnly:helper?.readOnly??state.binding.current.readOnly,status:'pending',key:input.key,executions:[]};
        (task.record.tools??=[]).push(trace);task.save();
        return sourceOperation(parent,async()=>{
          actorGuard(state);
          const started=Date.now();
          const outputPath=input.params.output?join(directory,safePath(input.params.output)):join(task.home,'tasks',task.record.id+'-native-artifacts',randomUUID()+'.log');
          if(input.params.output&&(trace.readOnly||!inScope(input.params.output,helper?.scope??state.binding.current.scope)))throw problem('SCOPE','Native host output exceeds creator write scope');
          const timeout=new AbortController();let timedOut=false;
          const timer=setTimeout(()=>{timedOut=true;timeout.abort(problem('COMMAND_TIMEOUT','Explicit native host command limit elapsed'));},input.params.timeoutMs);
          let fact;
          try{fact=await execute(trace,input.params.command,resources,AbortSignal.any([input.signal,timeout.signal]));}
          catch(error){trace.status=trace.executions.some(execution=>execution.status==='outcome_unknown')?'outcome_unknown':'failed';trace.error=error.message;task.save();throw error;}
          finally{clearTimeout(timer);}
          trace.status=fact.status;task.save();
          actorGuard(state);
          if(input.signal.aborted)throw problem('CANCELLED','Native workflow command was cancelled; stdout retained in its execution record');
          if(input.params.output)scan(directory);
          mkdirSync(dirname(outputPath),{recursive:true});writeFileSync(outputPath,(fact.stdout??'')+(fact.stderr??''));
          trace.outputPath=outputPath;trace.status=fact.status;task.save();
          return {key:input.key,kind:'command',ok:!timedOut&&fact.exitCode===0,state:timedOut?'timed-out':input.signal.aborted||fact.status==='cancelled'?'stopped':fact.exitCode===0?'passed':'failed',exitCode:fact.exitCode??null,stdout:fact.stdout??'',stderr:fact.stderr??'',outputPath,durationMs:Date.now()-started};
        });
      },
      async operationReturned({operationId}) {
        const record=operationBases.get(operationId)?.background;
        if(record&&!record.process&&!record.stoppedAt){record.status='failed';record.stoppedAt=new Date().toISOString();record.error={message:'Native operation returned without spawning its admitted runner'};try{freezeHelperResult(record);}catch(error){record.resultError={code:error.code,message:error.message};}task.save();const handle=runnerHandles.get(record.runnerId);handle?.lease.release();handle?.resolveClose();}
      },
      async prepareResume({target,operationId,parentSessionId}) {
        const {parent,state}=parentFor({parentSessionId}),record=operationBases.get(operationId)?.background;
        if(!record?.resumeOf||record.parentActorId!==parent||record.resumeOf.runId!==target.runId||!record.resumeOf.sessionFile||resolve(record.resumeOf.sessionFile)!==resolve(target.sessionFile??''))throw problem('NATIVE_RESUME_UNBOUND','Native resume target differs from the admitted original session');
        if(record.resumeFork)throw problem('NATIVE_RESUME_CLAIMED','Resume preparation cannot replay');
        actorGuard(state);record.resumeFork={status:'pending',sourceSessionFile:target.sessionFile};task.save();
        const {SessionManager}=await import('@earendil-works/pi-coding-agent');
        const session=SessionManager.forkFrom(target.sessionFile,record.cwd,join(record.directory,'resume-sessions'));
        record.resumeFork={...record.resumeFork,status:'prepared',sessionFile:session.getSessionFile(),sessionId:session.getSessionId()};task.save();actorGuard(state);
        return {...target,cwd:record.cwd,sessionFile:session.getSessionFile(),...(target.recoveryDescriptor?{recoveryDescriptor:{...target.recoveryDescriptor,cwd:record.cwd,sessionDir:join(record.directory,'resume-sessions')}}:{})};
      },
      async admitRunner(input) {
        if(input.steps?.some(step=>step.machine))throw problem('NATIVE_REMOTE_ASYNC_PENDING','Detached remote is not adapted; use explicit async:false');
        const {parent,state}=parentFor(input),operation=operationBases.get(input.hostOperationId);
        if(!operation||operation.actor!==parent||!operation.background)throw problem('NATIVE_RUNNER','Detached runner has no admitted independent operation');
        actorGuard(state);const record=operation.background;
        if(record.runnerId)throw problem('NATIVE_RUNNER','Operation already has a native runner; no replay');
        Object.assign(record,{runnerId:input.runnerProcessInstanceId,nativeRunId:input.id,status:'starting',nativeConfig:JSON.parse(JSON.stringify(input)),ownerEpoch:nativeOwnerInstance});task.save();
        const transport=await brokerReady();actorGuard(state);const allowedSessions=new Set([input.parentSessionId]),launches=new Set(),subrunners=new Set(),connectionOperations=new Set(),rpcControls=new Map();
        const dispatch=async(action,args,{send,requestId})=>{
          if(['admitOperation','admitChild','admitRunner','prepareResume','command'].includes(action)){
            if(!allowedSessions.has(args.parentSessionId))throw problem('HELPER_PARENT','Connection cannot name another creator');
            if(action==='admitChild')args={...args,hostOperationId:args.hostOperationId??input.hostOperationId};
          }
          if(['claimStart','started','terminal','finished','observe','rpc','children'].includes(action)&&!launches.has(args.launchId))throw problem('HELPER_PARENT','Connection cannot control another child');
          if(action==='admitOperation'){const accepted=await host.admitOperation(args);connectionOperations.add(args.operationId);return accepted;}
          if(action==='operationReturned'){if(!connectionOperations.has(args.operationId))throw problem('HELPER_PARENT','Connection cannot finalize another operation');return (await host.operationReturned(args))??null;}
          if(action==='admitRunner'){const accepted=await host.admitRunner(args);subrunners.add(args.runnerProcessInstanceId);return accepted;}
          if(action==='prepareResume')return host.prepareResume(args);
          if(action==='runnerSpawned'||action==='runnerClose'){
            if(!subrunners.has(args.runnerProcessInstanceId))throw problem('HELPER_PARENT','Connection cannot report another runner process');
            if(action==='runnerSpawned'){host.runnerStarted({...args,observerRunnerId:record.runnerId},signal=>send({event:'control',action:'runnerKill',runnerId:args.runnerProcessInstanceId,signal}));return null;}
            await host.runnerClosed(args);return null;
          }
          if(action==='children')return [...work.helpers,...backgroundRecords()].filter(h=>h.parentActorId===args.launchId&&!h.treatment).map(view);
          if(action==='admitChild') {const value=await host.admitChild(args);launches.add(value.launchId);const {hostHooks,...serial}=value;return JSON.parse(JSON.stringify(serial));}
          if(action==='started'){await host.started({...args,control:{abort:async()=>send({event:'control',action:'abort',launchId:args.launchId})}});allowedSessions.add(args.sessionId);return null;}
          if(action==='observe'){handles.get(args.launchId).observe(args.data);return null;}
          if(action==='cancelRpc'){rpcControls.get(args.requestId)?.abort(problem('CANCELLED','Native child tool aborted'));return null;}
          if(action==='rpc'||action==='command'){const control=new AbortController();rpcControls.set(requestId,control);try{return await (action==='rpc'?handles.get(args.launchId).rpc(args.action,args.args,control.signal):host.command({...args,signal:control.signal}));}finally{rpcControls.delete(requestId);}}
          if(action==='runnerDone'){if([...launches].some(id=>!work.helpers.find(h=>h.helperId===id)?.stoppedAt)||[...subrunners].some(id=>!backgroundRecords().find(r=>r.runnerId===id)?.stoppedAt))throw problem('SHUTDOWN_UNKNOWN','Runner still has unknown child/process termination');record.executionFinishedAt=new Date().toISOString();task.save();return null;}
          if(!['admitOperation','claimStart','terminal','finished','command'].includes(action))throw problem('NATIVE_RPC','Unsupported native bridge action');
          return (await host[action](args))??null;
        };
        const manifest=transport.register({record,dispatch,assertAllowed:()=>actorGuard(state),onDisconnect:()=>{if(!record.stoppedAt&&!record.executionFinishedAt){record.status='outcome_unknown';record.ownerDisconnectedAt=new Date().toISOString();const descendants=[...new Set([...launches].flatMap(id=>ownedHelpers(id)))];for(const h of descendants)if(!h.stoppedAt){h.status='outcome_unknown';h.ownerDisconnectedAt=record.ownerDisconnectedAt;}try{task.save();}catch(error){task.ioError??=error;}for(const id of launches)void stopRunners(id).catch(error=>{task.ioError??=error;});void stopHelpers(descendants).catch(error=>{task.ioError??=error;});}}});
        const path=join(record.directory,'bridge.json');writePrivateJson(path,{...manifest,cwd:record.cwd,parentSessionId:input.parentSessionId,operationId:input.hostOperationId,detachedLeaseId:randomUUID(),scope:record.scope,readOnly:record.readOnly,parentSessionFile:nativeSessionFiles.get(input.parentSessionId)??null,agentDir:join(task.home,'pi'),integrationPath:join(root,'src/runs/shared/host-integration.js')});
        const lease=acquireSessionWriter(join(task.home,'pi'),record.runnerId,()=>{void stopRunners(parent);});
        let resolveClose;const closed=new Promise(resolve=>resolveClose=resolve);runnerHandles.set(record.runnerId,{lease,closed,resolveClose,launches});
        task.save();actorGuard(state);
        return {hostBridge:{module:fileURLToPath(new URL('./native-background-runtime.js',import.meta.url)),manifest:path},hostManaged:true};
      },
      runnerStarted({runnerProcessInstanceId,pid,spawnfile,spawnargs,observerRunnerId},terminate) {
        const record=backgroundRecords().find(r=>r.runnerId===runnerProcessInstanceId),handle=runnerHandles.get(runnerProcessInstanceId);
        if(!record||!handle||record.process)throw problem('NATIVE_RUNNER','Runner was not persisted or already has a process observation');
        handle.terminate=terminate;record.process={pid,runnerId:record.runnerId,spawnfile,spawnargs,...(observerRunnerId?{observerRunnerId}: {})};record.status='running';
        try{task.save();}catch(error){broker?.signal(record.runnerId,{action:'stop'});terminate('SIGTERM');throw error;}
      },
      async runnerClosed({runnerProcessInstanceId,code,signal}) {
        const record=backgroundRecords().find(r=>r.runnerId===runnerProcessInstanceId),handle=runnerHandles.get(runnerProcessInstanceId);
        if(!record?.process||!handle)throw problem('NATIVE_RUNNER','Runner close has no registered process observation');
        if(record.processClose)return;
        record.processClose={code,signal,at:new Date().toISOString(),...(record.process.observerRunnerId?{observerRunnerId:record.process.observerRunnerId}: {})};
        const children=work.helpers.filter(h=>handle.launches.has(h.helperId));
        if(children.some(h=>!h.stoppedAt)){for(const h of children)if(!h.stoppedAt){h.status='outcome_unknown';handles.get(h.helperId)?.finish();}record.status='outcome_unknown';}
        else {record.stoppedAt=new Date().toISOString();record.status=record.cancelRequestedAt?'cancelled':code===0?'completed':'failed';try{freezeHelperResult(record);if(!record.result.edits.length)record.treatment={decision:'rejected',reason:'Native controller produced no source delta',at:record.stoppedAt};}catch(error){record.resultError={code:error.code,message:error.message};}}
        try{task.save();if(record.stoppedAt)handle.lease.release();}finally{handle.resolveClose();}
      },
      runnerSpawned({runnerProcessInstanceId,process:child}) {
        const handle=runnerHandles.get(runnerProcessInstanceId);if(!handle)throw problem('NATIVE_RUNNER','No registered runner');
        handle.child=child;child.once('close',(code,signal)=>{void host.runnerClosed({runnerProcessInstanceId,code,signal}).catch(error=>{task.ioError??=error;handle.resolveClose();});});
        host.runnerStarted({runnerProcessInstanceId,pid:child.pid,spawnfile:child.spawnfile,spawnargs:child.spawnargs},signal=>child.kill(signal));
      },
      async claimStart({launchId}) {
        const h=work.helpers.find(h=>h.helperId===launchId);if(!h?.native)throw problem('HELPER_PARENT','Unknown native start claim');
        actorGuard(actors.get(h.helperId));
        if(h.native.startClaim)throw problem('NATIVE_START_CLAIMED','Persisted native launch has already claimed its single SDK start');
        h.native.startClaim={ownerInstance:nativeOwnerInstance,at:new Date().toISOString()};h.status='starting';task.save();
      },
      async admitOperation(input) {
        const {parent,state}=parentFor(input);
        const params=input.nativeParams;
        if(params?.machine&&params.async!==false)throw problem('NATIVE_REMOTE_ASYNC_PENDING','Remote placement currently requires explicit async:false; detached remote is not adapted');
        if(typeof input.outputPath==='string')validateOutput(input.outputPath,input.parentSessionId,input.parentOperationId);
        if(params?.gate||typeof params?.acceptance==='object'&&params.acceptance?.verify?.length)throw problem('NATIVE_CHECK_PENDING','Native verification commands must use tracked runs.host or the existing parent Docker checks');
        if(params?.machine&&!remoteProfiles.has(params.machine))throw problem('NATIVE_REMOTE','Machine is not in frozen host configuration');
        if(params?.worktree||params?.baseRef||params?.merge||params?.accept)throw problem('NATIVE_AUTHORITY','Native placement/Git handoff cannot bypass the current managed route');
        if(params?.resume!==undefined)throw problem('NATIVE_RESUME_PENDING','Native resume requires reconciliation and an explicitly recorded new attempt');
        if(params?.action&&!['validate','status','stop','resume'].includes(params.action))throw problem('NATIVE_ACTION_PENDING','This native management action has no task-owned adapter yet');
        if(params?.action&&params.action!=='validate') {
          const ownChild=work.helpers.some(h=>h.parentActorId===parent&&h.native?.runId===params.id);
          const ownRun=(task.record.tools??[]).some(t=>t.kind==='native_plugin_tool'&&t.parentActorId===parent&&t.nativeRunId===params.id);
          if(!params.id||!ownChild&&!ownRun)throw problem('HELPER_PARENT','Native status/stop target does not belong to this creator');
        }
        let resumeOf;
        if(params?.action==='resume'){
          if(params.chain?.length)throw problem('NATIVE_RESUME_CHAIN','Managed resume supports one stopped child only; attached chains require independent native workflow launches');
          const previous=backgroundRecords().find(r=>r.nativeRunId===params.id&&r.parentActorId===parent);
          const previousChildren=work.helpers.filter(h=>h.native?.runId===params.id&&h.parentActorId===parent);
          if(!previous?.stoppedAt||!previous.treatment||previous.status==='outcome_unknown'||previousChildren.length!==1||previousChildren.some(h=>!h.stoppedAt||!h.treatment||h.status==='outcome_unknown'||ownedHelpers(h.helperId).some(x=>!x.stoppedAt||!x.treatment)))throw problem('NATIVE_RESUME_UNSETTLED','Explicit resume requires an original owned stopped single child and handled results; unknown work is never replayed');
          if(typeof params.message!=='string'||!params.message.trim())throw problem('NATIVE_RESUME_FEEDBACK','Explicit resume requires concrete new feedback');
          resumeOf={runId:params.id,helperId:previousChildren[0].helperId,sessionFile:previousChildren[0].native.sessionFile};
        }
        const authorityRoot=state.helper?.cwd??cwd;
        if(params?.cwd!==undefined&&realpathSync(resolve(input.cwd,params.cwd))!==realpathSync(authorityRoot))throw problem('NATIVE_CWD_PENDING','Managed native work currently requires its creator copy root; a different cwd needs an explicit copy mapping');
        if(typeof params?.output==='string')validateOutput(params.output,input.parentSessionId);

        return sourceOperation(parent,()=>{
          actorGuard(state);
          const inherited=operationBases.get(input.parentOperationId);
          const origin=inherited?.actor===parent?inherited.source:state.helper??getSourceBinding();
          const source={cwd:origin.cwd,changeId:origin.changeId,snapshot:structuredClone(origin.snapshot)};
          source.snapshot.publicBaseline??={inputVersion:source.snapshot.inputVersion,observations:source.snapshot.observations};
          source.snapshot.files=scan(source.cwd,source.snapshot.files);
          let background;
          if(input.nativeParams&&((!input.nativeParams.action&&input.nativeParams.async!==false)||resumeOf)) {
            const directory=join(task.home,'tasks',task.record.id+'-native-background',input.operationId),copy=join(directory,'source');
            background={name:'native_background',kind:'native_plugin_result',nativeBackground:true,...(state.helper?{parentHelperId:state.helper.helperId}:{}),...(resumeOf?{resumeOf}:{}),helperId:input.operationId,operationId:input.operationId,parentActorId:parent,changeId:source.changeId,snapshot:structuredClone(source.snapshot),scope:source.snapshot.scope,readOnly:source.snapshot.readOnly,cwd:copy,directory,status:'queued',inputVersion:source.snapshot.inputVersion};
            (task.record.tools??=[]).push(background);task.save();
            privateDirectory(copy);for(const [path,file] of Object.entries(source.snapshot.files)){mkdirSync(dirname(join(copy,path)),{recursive:true});writeFileSync(join(copy,path),Buffer.from(file.contentBase64,'base64'));chmodSync(join(copy,path),file.mode==='100755'?0o755:0o644);}
            source.cwd=copy;
          }
          operationBases.set(input.operationId,{actor:parent,source,background});
          (task.record.tools??=[]).push({name:'native_operation',kind:'native_plugin_operation',operationId:input.operationId,parentActorId:parent,runId:input.runId??null,operation:input.kind,cwd:input.cwd,inputVersion:source.snapshot.inputVersion,creatorInputDigest:digest(JSON.stringify(source.snapshot.files)),status:'admitted'});
          task.save();actorGuard(state);return {hostManaged:true,...(background?{cwd:source.cwd}: {})};
        });
      },
      async admitChild(input) {
        const {parent,state}=parentFor(input);
        const remoteProfile=input.machine?[...remoteProfiles.values()].find(p=>input.machine.provider==='herdr'&&p.machine.id===input.machine.id&&p.machine.target===input.machine.target&&p.machine.session===input.machine.session&&integration.hostMachineConnection(input.machine).sshConfig===p.sshConfig):null;
        if(input.machine&&!remoteProfile)throw problem('NATIVE_REMOTE','Remote child lacks original owner-attested placement');
        if(remoteProfile&&input.tools?.some(name=>!['read','write','edit','bash','grep','find','ls','cothink_helper_result','contact_supervisor'].includes(name)))throw problem('NATIVE_REMOTE_TOOLS','Selected remote tool has no connected owner adapter');
        if(remoteProfile&&(task.packageSnapshot.extensions.some(path=>!path.startsWith(root+'/'))||(task.resourceOptions?.additionalExtensionPaths?.length??0)>0))throw problem('NATIVE_REMOTE_RESOURCES','Selected additional extensions require explicit remote staging; no ambient fallback');
        if(input.mcpDirectTools?.length||input.builtinMcpTools?.length||input.extensionBindings&&Object.keys(input.extensionBindings).length)throw problem('NATIVE_RESOURCES_PENDING','Native MCP/extension bindings need an explicit per-launch adapter; ambient process environment is not used');
        if(typeof input.nativeAcceptance==='object'&&input.nativeAcceptance?.verify?.length)throw problem('NATIVE_CHECK_PENDING','Agent verification commands have no tracked native adapter; use the parent Docker checks');
        const selected=typeof input.model==='string'?input.model.replace(/:(off|minimal|low|medium|high|xhigh|max)$/,''):null;
        const allowed=[task.record.models.main,...(task.record.models.secondary??[])];
        if(!selected||!allowed.some(model=>selected===model.provider+'/'+model.modelId))throw problem('PLUGIN_MODEL_UNBOUND','Native child must resolve to a model in the frozen task configuration before any SDK/provider call');
        const [provider,...modelPath]=selected.split('/'),expectedModel=state.getModelContract?.(provider,modelPath.join('/'));
        if(!expectedModel)throw problem('PLUGIN_MODEL_UNBOUND','Native selected model has no frozen owner runtime contract');
        if(remoteProfile&&!remoteProfile.credentials?.[provider])throw problem('NATIVE_REMOTE_CREDENTIALS','Selected provider has no explicit remote credential source');
        return sourceOperation(parent,async()=>{
          actorGuard(state);
          const operation=operationBases.get(input.hostOperationId);
          const sourceBinding=operation?.actor===parent?operation.source:state.helper??getSourceBinding();
          if(operation?.background?.resumeFork){if(operation.background.resumeFork.claimedBy)throw problem('NATIVE_RESUME_SINGLE','Resume session already belongs to one admitted child');operation.background.resumeFork.claimedBy=input.requestId;task.save();}
          const allocated=await allocate(parent,input.nativeTask??'',state.helper,undefined,{...input,sourceBinding});
          const {h,home,resources}=allocated;
          const expected={...h.model,api:expectedModel.api,baseUrl:expectedModel.baseUrl};nativeModelContracts.set(h.helperId,expected);
          h.native={...h.native,requestId:input.requestId,...(operation?.background?.resumeOf?{resumeOf:operation.background.resumeOf}: {})};
          h.native.modelContract={api:expected.api,baseUrlDigest:digest(expected.baseUrl??'')};
          h.native.resolvedContract={agent:input.childAgentName,model:input.model,tools:input.tools??null,excludeTools:input.excludeTools??[],skills:input.remoteSkillNames??[],systemPromptDigest:digest(input.systemPrompt??''),scope:h.scope,readScope:h.readScope,readOnly:h.readOnly,operationId:input.hostOperationId??null,hostTools:['cothink_helper_result']};
          const lease=acquireSessionWriter(join(task.home,'pi'),h.helperId,()=>{void stopHelpers([h,...ownedHelpers(h.helperId)]).catch(error=>{task.ioError??=error;});});
          const helperState={...state,helper:h,assertAllowed:()=>{state.assertAllowed?.();lease.assertOwned();}};actors.set(h.helperId,helperState);
          let finish;const exit=new Promise(resolve=>finish=resolve);
          handles.set(h.helperId,{exit,finish,lease});task.save();
          const rpc=async(action,args,signal)=>{
            if(action==='result')return result(h.helperId,args,signal);
            if(action==='exec'){if(input.machine){const remote=remoteAttempts.get(h.helperId);if(!remote?.execute)throw problem('NATIVE_REMOTE_EXECUTION','Remote Docker execution is not configured; no local or SSH-shell fallback');return remote.execute(args.command,signal);}return execute(h,args.command,resources,signal);}
            throw problem('HELPER_RPC','Native child must use its original subagent engine');
          };
          const observe=data=>{
            (h.requestObservations??=[]).push(data);h.text=data.text??h.text;
            h.usage=h.requestObservations.every(r=>r.usageSeen&&!['error','aborted'].includes(r.status))?h.requestObservations.reduce((sum,r)=>{for(const key of ['input','output','cacheRead','cacheWrite'])sum[key]=(sum[key]??0)+(r.usage?.[key]??0);return sum;},{cost:null}):null;
            task.save();
          };
          handles.get(h.helperId).rpc=rpc;handles.get(h.helperId).observe=observe;
          if(remoteProfile){const remoteMachine=integration.remapHostMachine(input.machine,join(remoteProfile.stagingRoot,'cothink-'+h.helperId,'source'));handles.get(h.helperId).remote={profile:remoteProfile,machine:remoteMachine,input,hostPrompt:{prefix:input.systemPrompt??'',creator:parent,originalTask:task.record.input,skills:allocated.input.frozenSkills},expectedModel,resources};}
          const factory=managedHelperExtension({root:h.cwd,resources,scope:h.scope,readOnly:h.readOnly,outputCap:h.effectiveOutputCap,rpc,observe,
            assertAllowed:()=>actorGuard(helperState),native:true,expectedModel:expected,runSource:operation=>sourceOperation(h.helperId,operation),
            verifyCopy:()=>scan(h.cwd,h.snapshot.files),
            childResults:()=>[...work.helpers,...backgroundRecords()].filter(child=>child.parentActorId===h.helperId&&!child.treatment).map(view)});
          return {...input,...(remoteProfile?{machine:handles.get(h.helperId).remote.machine}:{}),cwd:h.cwd,launchId:h.helperId,hostToolConfig:{root:h.cwd,resources,scope:h.scope,readOnly:h.readOnly,outputCap:h.effectiveOutputCap,native:true,expectedModel:expected},hostAgentDir:join(home,'pi'),hostSettings:{retry:{enabled:false,provider:{maxRetries:0,timeoutMs:0}},compaction:{enabled:false},cacheWarming:'off',httpIdleTimeoutMs:0},
            hostHooks:[{name:'cothink-native-helper-tools',factory}],sessionDir:join(h.directory,'sessions'),sessionFile:operation?.background?.resumeFork?.sessionFile,projectTrusted:false,
            inheritGlobalContext:false,inheritProjectContext:false,inheritSkills:false,
            hostToolNames:['cothink_helper_result'],
            systemPrompt:(input.systemPrompt??'')+'\n\n'+allocated.input.systemPrompt};
        });
      },
      async prepareRemote({launchId,toolNames,excludedTools}) {
        const h=work.helpers.find(h=>h.helperId===launchId),handle=handles.get(launchId);
        if(!h?.native.startClaim||!handle?.remote||remoteAttempts.has(launchId))throw problem('NATIVE_REMOTE','Remote launch is not uniquely claimed');
        actorGuard(actors.get(launchId));
        const remote=await prepareRemoteHelper({task,integration,h,execution,...handle.remote,input:{...handle.remote.input,...(toolNames?{tools:toolNames}:{}),...(excludedTools?{excludeTools:excludedTools}:{})},pluginRoot:root,broker:await brokerReady(),rpc:handle.rpc,observe:handle.observe,
          children:()=>[...work.helpers,...backgroundRecords()].filter(child=>child.parentActorId===h.helperId&&!child.treatment).map(view),signal:task.signal});
        remoteAttempts.set(launchId,remote);actorGuard(actors.get(launchId));return remote.policy;
      },
      async stopRemote({launchId}) {
        const h=work.helpers.find(h=>h.helperId===launchId),remote=remoteAttempts.get(launchId);
        if(!h||!remote)throw problem('NATIVE_REMOTE','No original remote launch to stop');
        if(remote.cleanupPromise)return remote.cleanupPromise;
        return remote.cleanupPromise=(async()=>{
        h.native.remote.stopCallbackAt=new Date().toISOString();task.save();let stopped;try{stopped=await (remote.stopPromise??=remote.stop());}catch(error){h.native.remote.stopError=error.message;task.save();throw error;}
        writePrivateJson(join(h.directory,'remote-result.json'),stopped.files);
        cpSync(h.cwd,join(h.directory,'source-before-remote'),{recursive:true});
        rmSync(h.cwd,{recursive:true});privateDirectory(h.cwd);
        for(const [path,file] of Object.entries(stopped.files)){safePath(path);mkdirSync(dirname(join(h.cwd,path)),{recursive:true});writeFileSync(join(h.cwd,path),Buffer.from(file.contentBase64,'base64'));chmodSync(join(h.cwd,path),file.mode==='100755'?0o755:0o644);}
        h.native.remote.resultFrozenAt=new Date().toISOString();task.save();return stopped.facts;
        })();
      },
      async started(fact) {
        const h=work.helpers.find(h=>h.helperId===fact.launchId);if(!h?.native)throw problem('HELPER_PARENT','Unknown admitted native launch');
        if(fact.model!==h.model.provider+'/'+h.model.modelId)throw problem('PLUGIN_MODEL_UNBOUND','Actual SDK model differs from the admitted frozen model');
        const expected=nativeModelContracts.get(h.helperId);
        if(fact.api!==expected?.api||fact.baseUrl!==expected?.baseUrl)throw problem('PLUGIN_MODEL_UNBOUND','Actual SDK API/endpoint differs from its frozen owner runtime contract');
        h.status='running';h.native.sessionId=fact.sessionId;h.native.sessionFile=fact.sessionFile??null;h.native.actualModel=fact.model??null;
        h.native.actualThinking=fact.thinking??null;if(fact.remoteIdentity)h.native.remoteIdentity=fact.remoteIdentity;h.native.actualModelContract={api:fact.api,baseUrlDigest:digest(fact.baseUrl??'')};
        nativeSessions.set(fact.sessionId,h.helperId);handles.get(h.helperId).abort=fact.control?.abort;
        if(remoteAttempts.has(h.helperId)){actorGuard(actors.get(h.helperId));await remoteAttempts.get(h.helperId).activate();}
        if(fact.sessionFile)nativeSessionFiles.set(fact.sessionId,fact.sessionFile);
        task.save();actorGuard(actors.get(h.helperId));
      },
      async terminal(fact) {
        const h=work.helpers.find(h=>h.helperId===fact.launchId);if(!h?.native)throw problem('HELPER_PARENT','Unknown native terminal');
        h.shutdownEvidence={...fact,control:undefined};
        if(!fact.shutdownCompleted||!fact.disposed)h.status='outcome_unknown';
        task.save();
      },
      async finished(fact) {
        const h=work.helpers.find(h=>h.helperId===fact.launchId);if(!h?.native)throw problem('HELPER_PARENT','Unknown native writer result');
        h.native.result=fact.result;h.pluginReportedUsage=fact.result.usage;h.text=fact.result.text;
        await Promise.all(work.helpers.filter(child=>child.parentHelperId===h.helperId).map(child=>handles.get(child.helperId)?.exit));
        await Promise.all(backgroundRecords().filter(child=>child.parentActorId===h.helperId).map(child=>runnerHandles.get(child.runnerId)?.closed));
        await Promise.all([...shellHandles.values()].filter(shell=>shell.helper.helperId===h.helperId).map(shell=>shell.settled));
        if(!h.native.startClaim) {
          h.stoppedAt=new Date().toISOString();h.status='failed';h.error={message:fact.result.error??'Native attempt finished without an SDK start claim'};
          try{freezeHelperResult(h,[...work.helpers,...backgroundRecords()]);}catch(error){h.resultError={code:error.code,message:error.message};}
        }else if(fact.sdkTerminalObserved&&h.shutdownEvidence?.shutdownCompleted&&h.shutdownEvidence?.disposed) {
          h.stoppedAt=new Date().toISOString();h.status=h.cancelRequestedAt?'cancelled':fact.result.exitCode===0&&!fact.result.error?'completed':'failed';
          try{freezeHelperResult(h,[...work.helpers,...backgroundRecords()]);}catch(error){h.resultError={code:error.code,message:error.message};}
        }else h.status='outcome_unknown';
        try{task.save();if(h.stoppedAt)handles.get(h.helperId)?.lease.release();}finally{handles.get(h.helperId)?.finish();}
      },
    };
    const closer=registerHostIntegration({cwd,parentSessionId,host});
    const signals=[task.signal,actors.get(actor)?.signal].filter(Boolean);
    const abort=()=>{void closer().catch(error=>{task.ioError??=error;});};
    for(const signal of signals){signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();}
    nativeClosers.push(async()=>{for(const signal of signals)signal.removeEventListener('abort',abort);await closer();});
    return {close:closer};
  }
  const stopActor=async(actor,{reason}={})=>{
    await stopRunners(actor);const helperTargets=ownedHelpers(actor);await stopHelpers(helperTargets);const owners=new Set([actor,...helperTargets.map(h=>h.helperId)]);const targets=[...helperTargets,...backgroundRecords().filter(r=>owners.has(r.parentActorId))];
    if(reason) {
      for(const h of targets.toReversed()) {
        if(!h.stoppedAt||h.status==='outcome_unknown')throw problem('HELPERS_PENDING','Actor helper stop remains unknown');
        if(h.import) {
          const fact=await recoverHelperImport({task,versioning,helper:h,binding:actors.get(actor)?.binding});
          if(fact.status!=='applied')throw problem('OPERATION_UNKNOWN','Actor import must be resolved by original requestId before abandonment');
        }else if(!h.treatment)h.treatment={decision:'rejected',reason,at:new Date().toISOString()};
      }
      task.save();
    }
  };
  task.helperLifecycle={close};
  return {assertHandled:changeId=>{assertHelpersHandled(task,changeId);if(backgroundRecords().some(r=>(!changeId||r.changeId===changeId)&&(!r.stoppedAt||!r.treatment)))throw problem('PLUGIN_BUSY','Native background runner/result remains active, unknown or unhandled');},close,stopActor,bindNative,
    tools:({actor,binding,model,assertAllowed,getPricing,getModelContract,signal})=>{
      actors.set(actor,{binding,model,assertAllowed,getPricing,getModelContract,signal});
      return [{name:'cothink_helper',label:'cothink_helper',description:'Create an installed pi-subagents helper in an independent task copy. Actual result requires explicit parent review/adopt/reject; no Team delegation.',parameters:Type.Object({assignment:Type.String()}),execute:async(_id,args,toolSignal)=>({content:[{type:'text',text:JSON.stringify(await launch(actor,args.assignment,undefined,toolSignal))}]})},
      {name:'cothink_helper_result',label:'cothink_helper_result',description:'Inspect complete helper diff, adopt reviewed file/text results, or reject with reasons. Stale input requires concrete feedback, never overwrite a newer version.',parameters:Type.Object({helperId:Type.String(),decision:Type.Union([Type.Literal('inspect'),Type.Literal('adopt'),Type.Literal('reject')]),reason:Type.Optional(Type.String())}),execute:async(_id,args,toolSignal)=>({content:[{type:'text',text:JSON.stringify(await result(actor,args,toolSignal))}]})}];
    }};
}

/** Native tools share the existing copy/delta/import contract, without pretending to be model helpers. */
export async function createPluginWork(options) {
  const {task,versioning}=options;
  const helpers=await createHelperWork(options), contexts=new Map(), operations=new Map();
  const {Type}=await import('typebox');
  const {cpSync,rmSync}=await import('node:fs');
  const enabled=((task.packageSnapshot?.extensions?.length??0)>0&&(task.packageSnapshot?.packages?.length??0)>0)||(task.resourceOptions?.additionalExtensionPaths?.length??0)>0;
  const context=async state=>{
    if(!enabled)return null;
    if(contexts.has(state.actor))return contexts.get(state.actor);
    const directory=join(task.home,'tasks',task.record.id+'-native',state.actor.replaceAll(':','-'),randomUUID());
    let snapshot=await snapshotHelper({versioning,change:state.binding.current,directory});
    const record={name:'native_context',kind:'native_plugin_context',actor:state.actor,changeId:state.binding.current.changeId,cwd:directory,inputVersion:snapshot.inputVersion,status:'idle'};
    (task.record.tools??=[]).push(record);task.save();
    let active, lastDigest, phase;
    const capture=()=>{
      const probe={cwd:directory,snapshot,scope:snapshot.scope,readOnly:snapshot.readOnly||["worker-prepare","worker-conflict-resolution"].includes(phase),stoppedAt:new Date().toISOString()};
      let error;
      try {freezeHelperResult(probe);}catch(e){error=e;}
      if(!error&&!probe.result?.edits.length)return null;
      const resultDigest=probe.result?.digest??digest("invalid:"+error.message);
      if(resultDigest===lastDigest)return [...operations.values()].findLast(o=>o.parentActorId===state.actor);
      if([...operations.values()].some(o=>o.parentActorId===state.actor && !o.treatment))throw problem('PLUGIN_RESULTS_PENDING','Review the previous native tool result before changing its copy');
      lastDigest=resultDigest;
      const resultId=randomUUID(),archive=directory+'-results/'+resultId;cpSync(directory,archive,{recursive:true,dereference:false});
      const operation={...probe,cwd:archive,helperId:resultId,parentActorId:state.actor,changeId:state.binding.current.changeId,
        inputVersion:snapshot.inputVersion,status:error?'failed':'completed',resultError:error?.message,
        name:'native_result',kind:'native_plugin_result',evidence:'Awaited native execution returned; arbitrary detached JavaScript is outside this supported route'};
      operations.set(resultId,operation);(task.record.tools??=[]).push(operation);task.save();
      return operation;
    };
    const pending=()=>[...operations.values()].filter(o=>o.parentActorId===state.actor&&!o.treatment);
    const syncBasis=async()=>{
      const current=await versioning.inspect({changeId:state.binding.current.changeId});
      if(current.privateVersion===snapshot.inputVersion && current.changeId===record.changeId)return;
      if(capture() && pending().length)throw problem('STALE_PRIVATE','Native copy has an unreviewed delta against an older input; inspect/reject it or obtain concrete new work');
      rmSync(directory,{recursive:true});snapshot=await snapshotHelper({versioning,change:current,directory});
      record.inputVersion=snapshot.inputVersion;record.changeId=current.changeId;lastDigest=undefined;task.save();
    };
    const value={cwd:directory,actor:state.actor,supportsNativeSubagents:Boolean(helpers.bindNative),
      async bindSession(sessionId,sessionFile){if(helpers.bindNative)await helpers.bindNative(state.actor,directory,sessionId,()=>({cwd:directory,changeId:record.changeId,snapshot}),sessionFile);},
      get changeId(){return state.binding.current.changeId;},
      async beforeTool(event) {
        state.assertAllowed?.();if(state.signal?.aborted)throw problem('CANCELLED','Native tool owner stopped');
        if(pending().length)throw problem('PLUGIN_RESULTS_PENDING','Review the existing native result before executing another native tool');
        await syncBasis();
        if(active && !event.parentToolCallId)throw problem('PLUGIN_BUSY','Parallel native tools cannot share a writable plugin copy; retry with concrete sequential work');
        if(!active)active=event.toolCallId;
        record.status='running';task.save();
      },
      afterTool(event) {
        if(event.toolCallId!==active)return;
        active=null;record.status='idle';const operation=capture();task.save();
        const nativeResults=[...(task.record.work.helpers??[]),...(task.record.tools??[]).filter(t=>t.nativeBackground)].filter(h=>(h.native||h.nativeBackground)&&h.parentActorId===state.actor&&!h.treatment).map(h=>({helperId:h.helperId,status:h.status,text:h.text??null,error:h.resultError??null}));
        if(operation||nativeResults.length)return {content:[...event.content,{type:'text',text:JSON.stringify({...(operation?{nativePluginResultId:operation.helperId,files:operation.result?.edits.map(e=>e.path),error:operation.resultError??null}:{}),nativeHostResults:nativeResults,instruction:'Inspect and explicitly adopt/reject with cothink_helper_result; helperId is the result ID. No source was automatically accepted. Text dependency does not incorporate files.'})}]};
      },
      async beforePrompt(input){phase=input?.phase;state.assertAllowed?.();const operation=capture();if(!operation||operation.treatment)await syncBasis();return operation&&!operation.treatment?`Native plugin lifecycle changed its independent copy. Review result ${operation.helperId} using cothink_helper_result before completion. Original source is unchanged.`:'';},
      afterPrompt(){capture();},
      afterShutdown(){record.status="shutdown_completed";const operation=capture();if(operation&&!operation.treatment)operation.origin="session_shutdown";task.save();return pending().map(o=>o.helperId);},
      assertHandled(){if(active||(task.record.tools??[]).some(t=>t.kind==='native_host_command'&&t.parentActorId===state.actor&&t.executions?.some(e=>['pending','running','outcome_unknown'].includes(e.status))))throw problem('PLUGIN_BUSY','Native tool/command still running or unknown');capture();if(pending().length)throw problem('PLUGIN_RESULTS_PENDING','Native results require explicit creator review: '+pending().map(o=>o.helperId).join(','));},
      async result(args,signal) {
        const operation=operations.get(args.helperId);if(!operation||operation.parentActorId!==state.actor)throw problem('HELPER_PARENT','Only the native result creator may inspect/treat it');
        if(args.decision==='inspect')return operation;
        const alreadyHandled=Boolean(operation.treatment);
        if(alreadyHandled&&!operation.import)return {status:'already_handled',treatment:operation.treatment};
        const combined=state.signal&&signal?AbortSignal.any([state.signal,signal]):state.signal??signal;
        const fact=await treatHelperResult({task,versioning,helper:operation,actor:state.actor,binding:state.binding,decision:args.decision,reason:args.reason,assertAllowed:state.assertAllowed,signal:combined});
        // Receipt replay is observational: never reset a newer binding or its independent copy.
        if(alreadyHandled||state.binding.current.changeId!==operation.changeId)return fact;
        if(pending().length)return fact;
        if(combined?.aborted||task.signal.aborted||task.record.status!=="running")return fact;
        state.assertAllowed?.();
        const current={cwd:directory,snapshot,scope:snapshot.scope,readOnly:snapshot.readOnly,stoppedAt:new Date().toISOString()};
        try{freezeHelperResult(current);}catch{throw problem('PLUGIN_COPY_CHANGED','Current native copy cannot be proven equal to the reviewed result; retained without reset');}
        if(current.result.digest!==operation.result?.digest)throw problem('PLUGIN_COPY_CHANGED','Current native copy changed since this result; retained without reset');
        rmSync(directory,{recursive:true});
        snapshot=await snapshotHelper({versioning,change:state.binding.current,directory});
        lastDigest=undefined;record.inputVersion=snapshot.inputVersion;task.save();
        return fact;
      }};
    contexts.set(state.actor,value);return value;
  };
  return {context,
    assertHandled(changeId){helpers.assertHandled(changeId);for(const [actor,c]of contexts) {if(!changeId||c.changeId===changeId)c.assertHandled();}},
    async close(){await helpers.close();},
    async stopActor(actor,args){await helpers.stopActor?.(actor,args);const c=contexts.get(actor);if(c&&args?.reason){for(const o of operations.values())if(o.parentActorId===actor&&!o.treatment){if(o.import)throw problem('OPERATION_UNKNOWN','Native result import must be inspected before abandonment');o.treatment={decision:'rejected',reason:args.reason,at:new Date().toISOString()};}task.save();}},
    tools(state) {
      const existing=helpers.tools(state), resultTool=existing.find(t=>t.name==='cothink_helper_result');
      if(!enabled)return existing;
      const execute=async(id,args,signal)=>{
        if(!operations.has(args.helperId)&&resultTool)return resultTool.execute(id,args,signal);
        const c=contexts.get(state.actor);if(!c)throw problem('HELPER_PARENT','No native context for this actor');
        return {content:[{type:'text',text:JSON.stringify(await c.result(args,signal))}]};
      };
      return [...existing.filter(t=>t.name!=='cothink_helper_result'),{name:'cothink_helper_result',label:'cothink_helper_result',description:'Inspect and explicitly adopt/reject helper or native plugin file results by creator-owned result ID. File changes are never accepted automatically.',
        parameters:Type.Object({helperId:Type.String(),decision:Type.Union([Type.Literal('inspect'),Type.Literal('adopt'),Type.Literal('reject')]),reason:Type.Optional(Type.String())}),execute}];
    }};
}
