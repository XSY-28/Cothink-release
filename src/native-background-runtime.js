// Loaded by the ORIGINAL detached bootstrap, before its first filesystem mutation.
import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {dirname,join,resolve,relative,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {AsyncLocalStorage} from 'node:async_hooks';
import {connectNativeBroker} from './native-background.js';
import {acquireSessionWriter} from './storage.js';
import {managedHelperExtension} from './plugin-helper-extension.js';
export async function connectRunner(config) {
  const manifest=JSON.parse(readFileSync(config.hostBridge.manifest,'utf8'));
  const integration=await import(pathToFileURL(manifest.integrationPath));
  const controls=new Map(),runnerProcesses=new Map(),contracts=new Map(),children=new Map(),sessions=new Map(),sessionFiles=new Map();let disconnected=false,stopRequested=false;
  const abortAll=()=>{stopRequested=true;for(const abort of controls.values())void Promise.resolve().then(abort).catch(()=>{});};
  const client=await connectNativeBroker(manifest,{onControl:msg=>{if(msg.action==='abort')void controls.get(msg.launchId)?.();else if(msg.action==='runnerKill')runnerProcesses.get(msg.runnerId)?.kill(msg.signal);else abortAll();},onDisconnect:()=>{disconnected=true;abortAll();}});
  const lease=acquireSessionWriter(manifest.agentDir,manifest.detachedLeaseId,abortAll);
  const assertAllowed=()=>{lease.assertOwned();client.assertAlive();if(disconnected||stopRequested)throw new Error('CANCELLED: Native background owner stopped');};
  const requestWithSignal=(action,args,signal)=>{
    if(signal?.aborted)throw signal.reason;
    const promise=client.request(action,args),abort=()=>{void client.request('cancelRpc',{requestId:promise.requestId}).catch(abortAll);};
    signal?.addEventListener('abort',abort,{once:true});
    return promise.finally(()=>signal?.removeEventListener('abort',abort));
  };
  const sourceQueues=new Map(),sourceContext=new AsyncLocalStorage(),operationRoots=new Map(),closedSources=new Set();
  const sourceKey=root=>realpathSync(root);
  const runSource=(root,operation)=>{
    const key=sourceKey(root);let queue=sourceQueues.get(key);
    if(queue?.active&&sourceContext.getStore()?.token===queue.token)throw new Error('SOURCE_BUSY: cannot start another source operation inside an active writer');
    if(!queue){queue={tail:Promise.resolve(),active:false,token:null};sourceQueues.set(key,queue);}
    const token={};
    const run=queue.tail.catch(()=>{}).then(()=>{queue.active=true;queue.token=token;return sourceContext.run({key,token},operation);}).finally(()=>{queue.active=false;queue.token=null;});queue.tail=run;return run;
  };
  const creatorRoot=({parentSessionId,operationId,cwd})=>operationRoots.get(operationId)??(operationId===manifest.operationId?manifest.cwd:undefined)??[...children.values()].find(c=>sessions.get(c.helperId)===parentSessionId)?.cwd??cwd??manifest.cwd;
  const assertSource=root=>{assertAllowed();if(closedSources.has(sourceKey(root)))throw new Error('CANCELLED: creator source has finished');};
  const host={agentDir:manifest.agentDir,
    async admitOperation(input){return runSource(input.cwd,async()=>{assertSource(input.cwd);const accepted=await client.request('admitOperation',input);operationRoots.set(input.operationId,accepted.cwd??input.cwd);return accepted;});},
    async operationReturned(input){return runSource(creatorRoot(input),()=>client.request('operationReturned',input));},
    async prepareResume(input){assertAllowed();return client.request('prepareResume',input);},
    async admitRunner(input){assertAllowed();return client.request('admitRunner',input);},
    async runnerSpawned({runnerProcessInstanceId,process:child}){
      runnerProcesses.set(runnerProcessInstanceId,child);
      child.once('close',(code,signal)=>{runnerProcesses.delete(runnerProcessInstanceId);void client.request('runnerClose',{runnerProcessInstanceId,code,signal}).catch(abortAll);});
      try{await client.request('runnerSpawned',{runnerProcessInstanceId,pid:child.pid,spawnfile:child.spawnfile,spawnargs:child.spawnargs});}catch(error){child.kill('SIGTERM');throw error;}
    },
    async admitChild(input){const admitted=await runSource(input.cwd,()=>{assertSource(input.cwd);return client.request('admitChild',input);});contracts.set(admitted.cwd,admitted.hostToolConfig);children.set(admitted.launchId,{helperId:admitted.launchId,cwd:admitted.cwd,parentSessionId:input.parentSessionId,status:'queued'});
      const rpc=(action,args,signal)=>{const promise=requestWithSignal('rpc',{launchId:admitted.launchId,action,args},signal);if(action==='result'&&args.decision!=='inspect')void promise.then(()=>{if(children.has(args.helperId))children.get(args.helperId).treatment=args.decision;}).catch(()=>{});return promise;};
      const observe=data=>{void client.request('observe',{launchId:admitted.launchId,data}).catch(abortAll);};
      const factory=managedHelperExtension({...admitted.hostToolConfig,rpc,observe,assertAllowed:()=>assertSource(admitted.cwd),runSource:operation=>runSource(admitted.cwd,operation),childResults:()=>client.request('children',{launchId:admitted.launchId})});
      return {...admitted,hostHooks:[{name:'cothink-native-helper-tools',factory}]};},
    async claimStart(input){assertAllowed();return client.request('claimStart',input);},
    async started({control,...input}){controls.set(input.launchId,control.abort);sessions.set(input.launchId,input.sessionId);sessionFiles.set(input.sessionId,input.sessionFile);await client.request('started',input);assertAllowed();},
    async terminal(input){await client.request('terminal',input);controls.delete(input.launchId);},
    async finished(input){const root=children.get(input.launchId)?.cwd;if(root)await runSource(root,()=>closedSources.add(sourceKey(root)));await client.request('finished',input);Object.assign(children.get(input.launchId)??{},{status:input.result.exitCode===0?'completed':'failed',text:input.result.text});},
    async command(input){return runSource(input.cwd,()=>{assertSource(input.cwd);return requestWithSignal('command',{...input,signal:undefined},input.signal);});},
    async sourceOutput(input,operation){const root=creatorRoot(input);return runSource(root,()=>{assertSource(root);return operation();});},
    validateOutput({output,parentSessionId,operationId}){
      assertAllowed();
      const launchId=[...sessions].find(([,session])=>session===parentSessionId)?.[0];
      const child=launchId&&children.get(launchId),root=operationRoots.get(operationId)??(operationId===manifest.operationId?manifest.cwd:undefined)??child?.cwd??(parentSessionId===manifest.parentSessionId?manifest.cwd:undefined);
      if(!root)throw new Error('SCOPE: unknown detached output owner');
      if(sourceQueues.get(sourceKey(root))?.active&&sourceContext.getStore()?.token!==sourceQueues.get(sourceKey(root)).token)throw new Error('SOURCE_BUSY: native output must await the creator source barrier');
      const contract=contracts.get(root)??manifest,file=resolve(root,output),inside=rel=>rel!==''&&!isAbsolute(rel)&&!/^\.\.(?:[\\/]|$)/.test(rel);
      let boundary=[root,realpathSync(root)].find(candidate=>inside(relative(candidate,file)));
      if(boundary){const rel=relative(boundary,file).replaceAll('\\','/');if(contract.readOnly||!contract.scope.some(p=>p==='.'||p===rel||rel.startsWith(p+'/')))throw new Error('SCOPE: detached native output exceeds owner scope');}
      else {const sessionFile=sessionFiles.get(parentSessionId)??(parentSessionId===manifest.parentSessionId?manifest.parentSessionFile:null);const roots=sessionFile?[join(dirname(sessionFile),'subagent-artifacts'),join(realpathSync(dirname(sessionFile)),'subagent-artifacts')]:[];boundary=roots.find(candidate=>inside(relative(candidate,file)));if(!boundary)throw new Error('SCOPE: detached native output is outside its owner source/artifacts');}
      let current=boundary;for(const part of ['',...relative(boundary,file).split(/[\\/]/)]){if(part)current=join(current,part);try{const stat=lstatSync(current);if(stat.isSymbolicLink()||(!stat.isDirectory()&&(!stat.isFile()||stat.nlink!==1)))throw new Error('SCOPE: linked native output');}catch(error){if(error.code!=='ENOENT')throw error;}}

    }
  };
  integration.registerHostIntegration({cwd:manifest.cwd,parentSessionId:manifest.parentSessionId,host});
  return {run:callback=>integration.withRunnerOperation(manifest,callback),async finish(){await client.request('runnerDone',{});lease.release();client.close();},abort:abortAll};
}
