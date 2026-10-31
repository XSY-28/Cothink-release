// Extension loaded by the actual remote Pi CLI in its native Herdr pane.
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {connectNativeBroker} from './native-background.js';
import {managedHelperExtension} from './plugin-helper-extension.js';
import {readRemoteTree} from './native-remote-files.js';
export default async function(pi){
 const file=process.env.COTHINK_NATIVE_REMOTE_MANIFEST;
 if(!file)throw new Error('REMOTE_RUNTIME: missing private manifest');
 const manifest=JSON.parse(readFileSync(file,'utf8')),contract=manifest.contract;
 const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
 if(digest(contract)!==manifest.contractDigest||process.cwd()!==contract.cwd)throw new Error('REMOTE_RUNTIME: frozen contract/cwd mismatch');
 let ctx,alive=true,closing=false,sourceClosed=false,activated=false;
 pi.on('before_provider_request',()=>{if(!activated||!alive||closing)throw new Error('REMOTE_RUNTIME: provider request before owner activation');});
 pi.on('tool_call',()=>{if(!activated||!alive||closing)throw new Error('REMOTE_RUNTIME: tool before owner activation');});const pending=new Set();
 const track=promise=>{pending.add(promise);promise.finally(()=>pending.delete(promise)).catch(()=>{});return promise;};
 const abort=()=>{alive=false;ctx?.abort();};
 const client=await connectNativeBroker(manifest.broker,{onDisconnect:abort,onControl:message=>{
  if(message.action==='activate'){activated=true;void client.request('activated',{launchId:contract.launchId,sessionId:ctx?.sessionManager.getSessionId()}).catch(abort);}
  else if(message.action==='shutdown'){closing=true;ctx?.abort();ctx?.shutdown();}
  else if(message.action==='abort')ctx?.abort();
 }});
 const assertAllowed=()=>{client.assertAlive();if(!alive||closing||sourceClosed)throw new Error('REMOTE_OWNER_LOST: remote admission is closed');};
 let tail=Promise.resolve();
 const runSource=operation=>{const next=tail.catch(()=>{}).then(()=>{assertAllowed();return operation();});tail=next;return next;};
 const rpc=(action,args,signal)=>{
  assertAllowed();const promise=client.request('rpc',{launchId:contract.launchId,action,args});
  const cancel=()=>{void client.request('cancelRpc',{requestId:promise.requestId}).catch(abort);};
  signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
  return track(promise.finally(()=>signal?.removeEventListener('abort',cancel)));
 };
 managedHelperExtension({...contract.tools,root:contract.cwd,resources:contract.resourceRoot,native:true,runSource,rpc,assertAllowed,
  verifyCopy:()=>readRemoteTree(contract.cwd),childResults:()=>client.request('children',{launchId:contract.launchId}),
  observe:data=>{void track(client.request('observe',{launchId:contract.launchId,data})).catch(abort);}})(pi);
 let readyResolve;const readyPromise=new Promise(resolve=>readyResolve=resolve);
 const managed={contractDigest:manifest.contractDigest,resources:contract.resources,receipt:null,ready:readyPromise};
 globalThis[Symbol.for('cothink:native-remote')]=managed;
 pi.on('session_start',async(_event,context)=>{
  ctx=context;assertAllowed();
  if(digest(readRemoteTree(contract.cwd))!==contract.sourceDigest)throw new Error('REMOTE_RUNTIME: initial source differs from registered snapshot');
  if(digest(readRemoteTree(contract.resourceRoot))!==contract.resourceDigest)throw new Error('REMOTE_RUNTIME: frozen resource bytes changed');
  pi.setActiveTools(contract.resources.tools);
  if(JSON.stringify([...pi.getActiveTools()].sort())!==JSON.stringify([...contract.resources.tools].sort()))throw new Error('REMOTE_RUNTIME: exact active tools not installed');
  const actual={sessionId:ctx.sessionManager.getSessionId(),sessionFile:ctx.sessionManager.getSessionFile?.(),model:ctx.model?ctx.model.provider+'/'+ctx.model.id:null,api:ctx.model?.api,baseUrl:ctx.model?.baseUrl,thinking:ctx.thinkingLevel??null,pid:process.pid,uid:process.getuid(),gid:process.getgid(),cwd:process.cwd(),contractDigest:manifest.contractDigest,sourceDigest:contract.sourceDigest,resourceDigest:contract.resourceDigest,runtimeDigest:manifest.runtimeDigest,piCli:manifest.piCli,tools:pi.getActiveTools()};
  const expected=contract.tools.expectedModel;
  if(actual.model!==expected.provider+'/'+expected.modelId||actual.api!==expected.api||actual.baseUrl!==expected.baseUrl||actual.thinking!==contract.thinking)throw new Error('REMOTE_RUNTIME: actual model/endpoint/thinking differs from admitted contract');
  await client.request('ready',{launchId:contract.launchId,...actual});managed.receipt=actual;readyResolve();
 });
 pi.on('before_provider_request',()=>{assertAllowed();if(!managed.receipt)throw new Error('REMOTE_RUNTIME: request before owner readiness receipt');});
 pi.on('session_shutdown',async()=>{
  sourceClosed=true;let error;
  try{await tail;await Promise.all([...pending]);await client.request('shutdown',{launchId:contract.launchId,sessionId:managed.receipt?.sessionId});}
  catch(failure){error=failure.message;}
  writeFileSync(join(manifest.privateRoot,'extension-shutdown.json'),JSON.stringify({owner:contract.launchId,sessionId:managed.receipt?.sessionId,error:error??null}),{mode:0o600});
  client.close();if(error)throw new Error(error);
 });
}
