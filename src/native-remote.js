// Consumer adapter for the existing task owner. Herdr/Pi still own native execution;
// this module stages private copies and observes their actual process/result evidence.
import {readFileSync,realpathSync,mkdirSync,writeFileSync,chmodSync,mkdtempSync,rmSync} from 'node:fs';
import {join,isAbsolute,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import {readRemoteTree,validateRemoteFiles} from './native-remote-files.js';
const sha=value=>createHash('sha256').update(value).digest('hex');
const fault=message=>Object.assign(new Error(message),{code:'NATIVE_REMOTE'});
const absolute=(value,label)=>{if(typeof value!=='string'||!isAbsolute(value)||/[\0\r\n]/.test(value))throw fault(label+' must be an explicit absolute path');return value;};
const sourceRoot=fileURLToPath(new URL('.',import.meta.url));
const file=bytes=>({contentHash:sha(bytes),contentBase64:Buffer.from(bytes).toString('base64'),mode:'100644'});
const copyCode=readFileSync(new URL('./native-remote-files.js',import.meta.url),'utf8');
const executeCopy=copyCode+'\nprocess.stdout.write(JSON.stringify(remoteCopyOperation(JSON.parse(readFileSync(0)))));';
export async function freezeRemoteProfiles(entries,integration,{directory}={}){
 const profiles=new Map();
 for(const [selector,value] of Object.entries(entries??{})){
  if(selector==='local'||!value||value.provider!=='herdr')throw fault('Only explicitly configured Herdr saved machines are supported');
  const profile=structuredClone(value);
  for(const key of ['sshConfig','stagingRoot','herdrBin'])absolute(profile[key],key);
  const sshBytes=readFileSync(profile.sshConfig);if(/^\s*Include\s/im.test(sshBytes.toString()))throw fault('Remote SSH config must be standalone; Include files need an explicit frozen mapping');
  if(!directory)throw fault('Private SSH snapshot directory required');mkdirSync(directory,{recursive:true,mode:0o700});
  profile.sshConfigDigest=sha(sshBytes);profile.sshConfig=join(directory,sha(selector)+'.config');writeFileSync(profile.sshConfig,sshBytes,{mode:0o600,flag:'wx'});
  for(const key of ['node','piCli','nodeModules','pluginNodeModules'])absolute(profile.runtime?.[key],'runtime.'+key);
  if(!profile.runtime.piCli.endsWith('/@earendil-works/pi-coding-agent/dist/cli.js'))throw fault('Managed remote requires the pinned unbundled Pi dist/cli.js; bundled zero-timeout runtime is unsupported');
  if(!profile.runtime.nodeModules.endsWith('/node_modules')||!profile.runtime.pluginNodeModules.endsWith('/node_modules'))throw fault('Runtime dependencies must name dedicated node_modules roots');
  if(!profile.runtime.hashes||Object.entries(profile.runtime.hashes).some(([path,hash])=>!isAbsolute(path)||!/^[a-f0-9]{64}$/.test(hash)))throw fault('Explicit frozen runtime hashes required');
  if(relative(profile.runtime.nodeModules,profile.runtime.piCli).startsWith('..')||isAbsolute(relative(profile.runtime.nodeModules,profile.runtime.piCli)))throw fault('Pi CLI must belong to the explicitly selected runtime dependency tree');
  if(!profile.runtime.hashes[profile.runtime.node]||!profile.runtime.hashes[profile.runtime.piCli])throw fault('Node and Pi executable hashes required');
  for(const [key,path] of Object.entries(profile.herdrEnvironment??{})){if(!['HERDR_CONFIG_PATH','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_RUNTIME_DIR','XDG_STATE_HOME'].includes(key))throw fault('Unsupported Herdr environment key');absolute(path,key);}
  for(const path of Object.values(profile.credentials??{}))absolute(path,'provider credential file');
  const machine=await integration.resolveRegisteredHerdrProfile({selector,cwd:profile.stagingRoot,herdrBin:profile.herdrBin,env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',...profile.herdrEnvironment}});
  profiles.set(selector,Object.freeze({...profile,machine:Object.freeze(machine)}));
 }
 return profiles;
}
export function selectRemoteProfile(profiles,selector,requestedCwd){
 const profile=profiles.get(selector);if(!profile)throw fault('Machine is not in the frozen task remote configuration');
 if(requestedCwd!==undefined)throw fault('Remote cwd overrides are not allowed; each child receives a unique copied source');
 return {machine:profile.machine,connection:{sshConfig:profile.sshConfig}};
}
export async function prepareRemoteHelper({task,profile,machine,integration,h,resources,input,hostPrompt,expectedModel,pluginRoot,broker,rpc,observe,children,signal,execution}){
 const root=join(profile.stagingRoot,'cothink-'+h.helperId),privateRoot=join(root,'runtime');
 const source=readRemoteTree(realpathSync(h.cwd)),resourceFiles=readRemoteTree(realpathSync(resources)),runtime={};
 for(const name of ['native-remote-runtime.js','native-remote-supervisor.js','native-remote-files.js','native-background.js','plugin-helper-extension.js'])runtime[name]=file(readFileSync(join(sourceRoot,name)));
 runtime['package.json']=file('{"type":"module"}\n');
 for(const tree of ['src','bundle'])for(const [path,value] of Object.entries(readRemoteTree(realpathSync(join(pluginRoot,tree)))))runtime['plugin/'+tree+'/'+path]=value;
 runtime['plugin/package.json']=file(readFileSync(join(pluginRoot,'package.json')));
 const toolNames=(input.tools??['read','write','edit','bash','grep','find','ls']).filter(name=>!(input.excludeTools??[]).includes(name));
 if(toolNames.some(name=>!['read','write','edit','bash','grep','find','ls','cothink_helper_result','contact_supervisor'].includes(name)))throw fault('Remote selected tool needs a connected native owner adapter');
 const credential=profile.credentials?.[h.model.provider];if(!credential)throw fault('Selected provider has no explicit remote credential source');
 const docker=toolNames.includes('bash')?await remoteDockerPolicy(profile,execution):null;
 const remoteSkills=(hostPrompt.skills??[]).map(skill=>({...skill,path:join(root,'resources',skill.name,'SKILL.md')}));
 const systemPrompt=hostPrompt.prefix+'\n\n'+`You are helper ${h.helperId}; creator=${hostPrompt.creator}; original task follows verbatim. Work only in your independent copy. Do not claim acceptance. Treat nested results explicitly before final delivery.\nOriginal user input:\n${hostPrompt.originalTask}\nFrozen skills: ${JSON.stringify(remoteSkills)}\nTask resources: ${join(root,'resources')}\nWrite scope=${JSON.stringify(h.scope)}; readOnly=${h.readOnly}.`;
 const contract={launchId:h.helperId,cwd:join(root,'source'),resourceRoot:join(root,'resources'),thinking:input.thinking??'off',sourceDigest:sha(JSON.stringify(source)),execution:docker?{mode:docker.mapping.mode,context:docker.mapping.context,daemonId:docker.daemon.ID,image:docker.image[0].Id,limits:execution.limits,network:'none'}:null,resourceDigest:sha(JSON.stringify(resourceFiles)),
  tools:{scope:h.scope,readOnly:h.readOnly,outputCap:h.effectiveOutputCap,expectedModel:{...h.model,api:expectedModel.api,baseUrl:expectedModel.baseUrl}},
  resources:{agent:input.childAgentName,skills:input.remoteSkillNames??[],tools:toolNames,inheritGlobalContext:false,inheritProjectContext:false,inheritSkills:false,systemPrompt}};
 const contractDigest=sha(JSON.stringify(contract));
 const record=h.native.remote={profile:machine.id,root,cwd:contract.cwd,contractDigest,status:'preparing',runnerId:h.helperId};task.save();
 let ready,shutdown=false,activatedResolve;const activated=new Promise(resolve=>activatedResolve=resolve),pendingRpc=new Map();
 const capability=broker.register({record,assertAllowed:()=>{if(signal.aborted)throw signal.reason;},
  onDisconnect:()=>{if(!shutdown){record.status='outcome_unknown';h.status='outcome_unknown';record.disconnectedAt=new Date().toISOString();task.save();}},
  dispatch:async(action,args,{requestId})=>{
   if(action==='cancelRpc'){pendingRpc.get(args.requestId)?.abort();return null;}
   if(args.launchId!==h.helperId)throw fault('Remote connection cannot control another launch');
   if(signal.aborted&&!['observe','children','shutdown'].includes(action))throw fault('Owner cancelled; new remote operations are closed');
   if(action==='ready'){
    if(typeof args.sessionFile!=='string'||!args.sessionFile.startsWith(privateRoot+'/sessions/')||args.sessionFile.includes('/../'))throw fault('Remote session transcript escaped private job storage');
    if(ready||args.cwd!==contract.cwd||args.contractDigest!==contractDigest||args.model!==h.model.provider+'/'+h.model.modelId||args.api!==expectedModel.api||args.baseUrl!==expectedModel.baseUrl||args.thinking!==contract.thinking||args.sourceDigest!==contract.sourceDigest||args.resourceDigest!==contract.resourceDigest||args.runtimeDigest!==record.runtime?.runtimeDigest||args.piCli!==record.runtime?.piCli)throw fault('Actual remote runtime differs from frozen contract');
    ready=args;record.ready=args;record.status='ready';task.save();return null;
   }
   if(!ready)throw fault('Remote operation before runtime readiness');
   if(action==='activated'){if(args.sessionId!==ready.sessionId)throw fault('Remote activation session mismatch');activatedResolve();record.activatedAt=new Date().toISOString();task.save();return null;}
   if(action==='observe'){observe(args.data);return null;}
   if(action==='children')return children();
   if(action==='shutdown'){if(args.sessionId!==ready.sessionId)throw fault('Remote shutdown identity changed');shutdown=true;record.extensionShutdownAt=new Date().toISOString();task.save();return null;}
   if(action==='rpc'){const controller=new AbortController();pendingRpc.set(requestId,controller);try{return await rpc(args.action,args.args,AbortSignal.any([signal,controller.signal]));}finally{pendingRpc.delete(requestId);}}
   throw fault('Unsupported remote owner action');
  }});
 const access=await integration.openHostRemoteAccess(machine);
 const invoke=async(code,payload,maxBuffer=96*1024*1024)=>{const result=await access.runAsync(access.shellCommand('exec "$1" --input-type=module -e "$2"',[profile.runtime.node,code]),{input:JSON.stringify(payload),timeout:60000,maxBuffer});if(result.status!==0)throw fault(result.stderr||result.error?.message||'Remote transport failed');return JSON.parse(result.stdout);};
 const commandRuns=new Set();
 const ports=[capability.port];
 if(profile.forwardModelLoopback){const endpoint=new URL(expectedModel.baseUrl);if(!['127.0.0.1','localhost'].includes(endpoint.hostname)||!endpoint.port)throw fault('Explicit model loopback forwarding needs a loopback URL with port');ports.push(Number(endpoint.port));}
 const forward=await access.forwardHostPorts([...new Set(ports)]);
 let staged=false;
 try{
  forward.assertAlive();if(signal.aborted)throw signal.reason;
  const receipt=await invoke(executeCopy,{action:'init',owner:h.helperId,parent:profile.stagingRoot,exact:true,trees:{source,resources:resourceFiles,runtime}});staged=true;
  if(receipt.root!==root)throw fault('Remote source root mismatch');
  const manifest={privateRoot,contract,contractDigest,broker:capability,node:profile.runtime.node,piCli:join(privateRoot,'node_modules',relative(profile.runtime.nodeModules,profile.runtime.piCli)),runtimeFiles:{}};
  const providerFiles=['@earendil-works/pi-coding-agent/package.json','@earendil-works/pi-coding-agent/dist/cli.js','@earendil-works/pi-coding-agent/dist/main.js','@earendil-works/pi-coding-agent/dist/core/sdk.js','@earendil-works/pi-coding-agent/dist/core/settings-manager.js','@earendil-works/pi-coding-agent/dist/core/extensions/loader.js','@earendil-works/pi-coding-agent/dist/core/extensions/runner.js','@earendil-works/pi-ai/dist/api/openai-completions.js','openai/client.js','openai/client.mjs'];
  const pinnedDependencies=Object.fromEntries(providerFiles.map(path=>[path,sha(readFileSync(new URL('../node_modules/'+path,import.meta.url)))]));
  for(const [path,hash] of Object.entries(pinnedDependencies))manifest.runtimeFiles[join(privateRoot,'node_modules',path)]=hash;
  manifest.runtimeDigest=sha(JSON.stringify(manifest.runtimeFiles));
  for(const [path,value] of Object.entries(runtime))manifest.runtimeFiles[join(privateRoot,path)]=value.contentHash;
  manifest.runtimeDigest=sha(JSON.stringify(manifest.runtimeFiles));
  const bootstrap=await invoke(bootstrapCode,{root,owner:h.helperId,manifest,credential,provider:h.model.provider,model:expectedModel,runtime:profile.runtime});
  record.runtime=bootstrap;record.status='staged';task.save();
  const environment={PI_CODING_AGENT_DIR:join(privateRoot,'agent'),PI_OFFLINE:'1',COTHINK_NO_UPDATE_CHECK:'1',COTHINK_NATIVE_REMOTE_MANIFEST:join(privateRoot,'manifest.json'),PATH:join(privateRoot,'bin')+':/usr/local/bin:/usr/bin:/bin'};
  return {access,invoke,record,ready:()=>ready,forward,execute(command,toolSignal){const run=executeRemoteDocker({task,h,profile,contract,execution,invoke,root,command,signal:AbortSignal.any([signal,toolSignal].filter(Boolean))});commandRuns.add(run);run.finally(()=>commandRuns.delete(run)).catch(()=>{});return run;},async activate(){broker.signal(h.helperId,{action:'activate'});let timer;try{await Promise.race([activated,new Promise((_,reject)=>timer=setTimeout(()=>reject(fault('Remote activation acknowledgement missing')),15000))]);}finally{clearTimeout(timer);}},policy:{environment,args:['--session-dir',join(privateRoot,'sessions'),'--no-extensions','-e',join(privateRoot,'plugin/bundle/index.js'),'-e',join(privateRoot,'native-remote-runtime.js'),'--no-context-files','--no-skills','--no-prompt-templates','--no-mcp','--no-approve','--model',h.model.provider+'/'+h.model.modelId,'--thinking',contract.thinking],resources:{agent:input.childAgentName,contractDigest}},
   async stop(){broker.signal(h.helperId,{action:'shutdown'});await Promise.allSettled([...commandRuns]);if(h.executions?.some(e=>!e.stopConfirmed||e.resultTransferred===false))throw fault('Remote Docker writer stop remains unknown');const deadline=Date.now()+15000;let fact;
    while(Date.now()<deadline){fact=await invoke(stopEvidenceCode,{root,owner:h.helperId,contractDigest});if(fact.exit)break;await new Promise(resolve=>setTimeout(resolve,50));}
    if(!fact?.exit||fact.exit.owner!==h.helperId||fact.exit.contractDigest!==contractDigest||fact.exit.pid!==fact.start?.pid||fact.exit.childStartTime!==fact.start?.childStartTime||fact.exit.supervisorStartTime!==fact.start?.supervisorStartTime||fact.exit.piCli!==fact.start?.piCli||fact.exit.cwd!==contract.cwd)throw fault('Exact owned remote Pi process exit not confirmed');
    record.processStart=fact.start;record.processExit=fact.exit;record.status='stopped';task.save();
    if(!fact.shutdown||fact.shutdown.error||!shutdown)throw fault('Remote Pi exit observed but extension/owner shutdown is incomplete');
    const snapshot=await invoke(executeCopy,{action:'scan',root,owner:h.helperId});validateRemoteFiles(snapshot.files);
    if(snapshot.owner!==h.helperId||snapshot.root!==root)throw fault('Remote result owner mismatch');
    await forward.close();return {files:snapshot.files,facts:{disposed:true,shutdownCompleted:true,timedOut:false,errors:[]}};
   }};
 }catch(error){record.status=staged?'outcome_unknown':'failed';record.error=error.message;task.save();await forward.close();throw error;}
}
const bootstrapCode=`import {readFileSync,writeFileSync,mkdirSync,cpSync,lstatSync,realpathSync,readdirSync} from 'node:fs';import {join,relative,isAbsolute} from 'node:path';import {createHash,randomUUID} from 'node:crypto';
const p=JSON.parse(readFileSync(0)),hash=b=>createHash('sha256').update(b).digest('hex');
if(JSON.parse(readFileSync(join(p.root,'owner.json'))).owner!==p.owner)throw Error('owner mismatch');
for(const [path,digest] of Object.entries(p.runtime.hashes))if(hash(readFileSync(path))!==digest)throw Error('approved runtime changed');
const privateRoot=p.manifest.privateRoot;cpSync(p.runtime.nodeModules,join(privateRoot,'node_modules'),{recursive:true,dereference:true});cpSync(p.runtime.pluginNodeModules,join(privateRoot,'plugin/node_modules'),{recursive:true,dereference:true});
for(const [path,digest] of Object.entries(p.manifest.runtimeFiles))if(hash(readFileSync(path))!==digest)throw Error('pinned runtime/dependency bytes differ');
const credential=JSON.parse(readFileSync(p.credential));if(credential.provider!==p.provider||typeof credential.apiKey!=='string'||!credential.apiKey||credential.apiKey.startsWith('!'))throw Error('provider credential binding invalid');
const agent=join(privateRoot,'agent');mkdirSync(agent,{mode:448});
writeFileSync(join(agent,'models.json'),JSON.stringify({providers:{[p.provider]:{api:p.model.api,baseUrl:p.model.baseUrl,apiKey:credential.apiKey,models:[p.model]}}}),{mode:384});
writeFileSync(join(agent,'auth.json'),'{}',{mode:384});
writeFileSync(join(agent,'settings.json'),JSON.stringify({packages:[],extensions:[join(privateRoot,'plugin/bundle/index.js'),join(privateRoot,'native-remote-runtime.js')],retry:{enabled:false,provider:{maxRetries:0,timeoutMs:0}},compaction:{enabled:false},cacheWarming:'off',httpIdleTimeoutMs:0}),{mode:384});
mkdirSync(join(privateRoot,'bin'),{mode:448});
const quote=s=>"'"+s.replaceAll("'","'\\\\''")+"'";
writeFileSync(join(privateRoot,'bin/pi'),'#!/bin/sh\\nexec '+quote(p.runtime.node)+' '+quote(join(privateRoot,'native-remote-supervisor.js'))+' "$@"\\n',{mode:448});
p.manifest.runtimeFiles[p.manifest.node]=p.runtime.hashes[p.runtime.node];p.manifest.runtimeFiles[p.manifest.piCli]=hash(readFileSync(p.manifest.piCli));p.manifest.runtimeDigest=hash(JSON.stringify(p.manifest.runtimeFiles));
writeFileSync(join(privateRoot,'manifest.json'),JSON.stringify(p.manifest),{mode:384});process.stdout.write(JSON.stringify({piCli:p.manifest.piCli,node:p.manifest.node,files:p.manifest.runtimeFiles,runtimeDigest:p.manifest.runtimeDigest,credentialProvider:p.provider,uid:process.getuid(),gid:process.getgid()}));`;
const stopEvidenceCode=`import {readFileSync,existsSync} from 'node:fs';import {join} from 'node:path';const p=JSON.parse(readFileSync(0)),dir=join(p.root,'runtime');if(JSON.parse(readFileSync(join(p.root,'owner.json'))).owner!==p.owner)throw Error('owner mismatch');const read=name=>existsSync(join(dir,name))?JSON.parse(readFileSync(join(dir,name))):null;process.stdout.write(JSON.stringify({start:read('process-start.json'),exit:read('process-exit.json'),shutdown:read('extension-shutdown.json')}));`;

async function executeRemoteDocker({task,h,profile,contract,execution,invoke,root,command,signal}){
 const {mapping,prefix,run,daemon,image}=await remoteDockerPolicy(profile,execution);
 const id='cothink-remote-'+randomUUID(),trace={id,command,status:'pending',location:{machine:profile.machine.id,context:mapping.context,daemonId:daemon.ID,mode:mapping.mode,image:image[0].Id,platform:image[0].Os+'/'+image[0].Architecture},stopConfirmed:false,resultTransferred:true};(h.executions??=[]).push(trace);task.save();
 let commandId,seedId,temp,sourceVolume,resourceVolume,snapshot;
 const kill=()=>{if(commandId)void run(['kill',commandId]).catch(error=>{trace.stopError=error.message;task.save();});};
 signal.addEventListener('abort',kill,{once:true});
 const confirm=async()=>{if(!commandId)return null;const info=JSON.parse(await run(['inspect',commandId]))[0];if(info.Id!==commandId||info.Config.Labels?.['cothink.helper']!==h.helperId||info.State.Running)throw fault('Exact remote Docker writer is not confirmed stopped');trace.stopConfirmed=true;trace.containerState=info.State;task.save();return info;};
 try{
  if(signal.aborted)throw signal.reason;
  let sourceMount='type=bind,src='+contract.cwd+',dst=/workspace',resourceMount='type=bind,src='+contract.resourceRoot+',dst=/resources,readonly';
  if(mapping.mode==='fixture-copy-volume'){
   snapshot=await invoke(executeCopy,{action:'scan',root,owner:h.helperId});validateRemoteFiles(snapshot.files);
   temp=realpathSync(mkdtempSync(join(tmpdir(),'cothink-remote-volume-')));const source=join(temp,'source'),resources=join(temp,'resources');materialize(source,snapshot.files);
   // Frozen resource bytes came from the registered task, never from arbitrary host mounts.
   const frozen=task.record.work.skillResources??[];const files={};for(const skill of frozen)for(const [path,value] of Object.entries(readRemoteTree(realpathSync(skill.root))))files[skill.name+'/'+path]=value;materialize(resources,files);
   sourceVolume=await run(['volume','create','--label','cothink.helper='+h.helperId,id+'-source']);resourceVolume=await run(['volume','create','--label','cothink.helper='+h.helperId,id+'-resources']);
   trace.volumes=[sourceVolume,resourceVolume];task.save();
   seedId=await run(['create','--network','none','--cap-drop','ALL','--cap-add','CHOWN','--security-opt','no-new-privileges','--label','cothink.helper='+h.helperId,'--mount','type=volume,src='+sourceVolume+',dst=/workspace','--mount','type=volume,src='+resourceVolume+',dst=/resources',execution.image,'chown','-R','0:0','/workspace','/resources']);
   await run(['cp',source+'/.',seedId+':/workspace']);await run(['cp',resources+'/.',seedId+':/resources']);await run(['start','-a',seedId]);await run(['rm',seedId]);seedId=null;
   sourceMount='type=volume,src='+sourceVolume+',dst=/workspace';resourceMount='type=volume,src='+resourceVolume+',dst=/resources,readonly';
  }
  if(h.readOnly)sourceMount+=',readonly';
  const limits=execution.limits;
  const runtimeUser=h.native.remote.runtime;const user=mapping.mode==='fixture-copy-volume'?'0:0':`${runtimeUser.uid}:${runtimeUser.gid}`;if(!/^\d+:\d+$/.test(user))throw fault('Remote execution user not attested');trace.user=user;
  commandId=await run(['create','--name',id,'--user',user,'--label','cothink.helper='+h.helperId,'--label','cothink.task='+task.record.id,'--network','none','--cap-drop','ALL','--security-opt','no-new-privileges','--memory',String(limits.memoryBytes),'--cpus',String(limits.cpus),'--pids-limit',String(limits.pids),'--mount',sourceMount,'--mount',resourceMount,'-w','/workspace',execution.image,'sh','-lc',command]);
  trace.containerId=commandId;trace.status='created';task.save();
  if(signal.aborted){await run(['rm',commandId]);commandId=null;trace.stopConfirmed=true;trace.status='cancelled';task.save();return trace;}
  trace.startRequestedAt=new Date().toISOString();if(mapping.mode==='fixture-copy-volume')trace.resultTransferred=false;task.save();
  const completed=await new Promise((resolve,reject)=>{const child=spawn('docker',[...prefix,'start','-a',commandId],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';trace.status='running';task.save();child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal,stdout,stderr}));});
  Object.assign(trace,{stdout:completed.stdout,stderr:completed.stderr});const info=await confirm();trace.exitCode=info.State.ExitCode;
  if(mapping.mode==='fixture-copy-volume'){
   const output=join(temp,'output');mkdirSync(output);await run(['cp',commandId+':/workspace/.',output]);const files=readRemoteTree(output);
   await invoke(executeCopy,{action:'replace',root,owner:h.helperId,expectedDigest:sha(JSON.stringify(snapshot.files)),files});trace.resultTransferred=true;
  }
  trace.status=signal.aborted?'cancelled':trace.exitCode===0?'completed':'failed';task.save();return trace;
 }catch(error){if(!trace.startRequestedAt)trace.stopConfirmed=true;if(commandId&&!trace.stopConfirmed)try{kill();await confirm();}catch(stopError){trace.stopError=stopError.message;}
  trace.status=trace.stopConfirmed?'failed':'outcome_unknown';trace.error=error.message;task.save();throw error;
 }finally{
  signal.removeEventListener('abort',kill);
  // Never remove an unconfirmed writer or erase its only recoverable result evidence.
  if(trace.stopConfirmed&&trace.resultTransferred){for(const args of [commandId&&['rm',commandId],seedId&&['rm',seedId],sourceVolume&&['volume','rm',sourceVolume],resourceVolume&&['volume','rm',resourceVolume]].filter(Boolean))try{await run(args);}catch(error){(trace.cleanupErrors??=[]).push(error.message);}if(temp)rmSync(temp,{recursive:true,force:true});task.save();}
 }
}
function materialize(root,files){validateRemoteFiles(files);mkdirSync(root,{mode:0o700});for(const [path,value] of Object.entries(files)){const target=join(root,path);mkdirSync(join(target,'..'),{recursive:true});writeFileSync(target,Buffer.from(value.contentBase64,'base64'));chmodSync(target,value.mode==='100755'?0o755:0o644);}}

async function remoteDockerPolicy(profile,execution){
 const mapping=profile.execution;
 if(!mapping||!['docker-context','fixture-copy-volume'].includes(mapping.mode)||typeof mapping.context!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(mapping.context)||typeof mapping.daemonId!=='string')throw fault('Remote Shell requires explicit Docker context, daemon identity and source mapping');
 if(!execution?.image||!/^([\w./:-]+@)?sha256:[a-f0-9]{64}$/.test(execution.image)||execution.network!=='none')throw fault('Remote Shell requires the same fixed offline Docker policy');
 const prefix=['--context',mapping.context],run=async args=>(await promisify(execFile)('docker',[...prefix,...args],{encoding:'utf8',maxBuffer:8*1024*1024,timeout:30000})).stdout.trim();
 const daemon=JSON.parse(await run(['info','--format','{{json .}}']));if(daemon.ID!==mapping.daemonId)throw fault('Selected Docker daemon identity changed');
 const image=JSON.parse(await run(['image','inspect',execution.image]));if(!image[0]?.Id?.startsWith('sha256:'))throw fault('Fixed remote image unavailable');
 if(mapping.mode==='fixture-copy-volume'){
  if(!/^[a-f0-9]{64}$/.test(mapping.fixtureContainerId??''))throw fault('Fixture mapping needs exact owned container ID');
  const fixture=JSON.parse(await run(['inspect',mapping.fixtureContainerId]))[0];
  if(fixture.Id!==mapping.fixtureContainerId||fixture.Config.Labels?.['cothink.fixture']!=='native-remote'||fixture.HostConfig.Privileged||fixture.Mounts?.length)throw fault('Owned fixture mapping changed');
 }
 return {mapping,prefix,run,daemon,image};
}
