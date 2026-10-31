// Required by the real plugin child. No alternate model loop: these are scoped file/IPC tools.
import { createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createLsToolDefinition, createGrepToolDefinition, createFindToolDefinition } from '@earendil-works/pi-coding-agent';
import {spawnSync} from 'node:child_process';
import { readFile, writeFile, mkdir, access, readdir, lstat, realpath } from 'node:fs/promises';
import { resolve, relative, dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Type } from 'typebox';
const waiting = new Map();
process.on('message',message=>{
  if(message?.type!=='rpc-result')return;
  const pending=waiting.get(message.id); if(!pending)return;waiting.delete(message.id);
  if(message.error)pending.reject(Object.assign(new Error(message.error.message),{code:message.error.code}));else pending.resolve(message.value);
});
const rpc=(action,args,signal)=>new Promise((resolve,reject)=>{const id=randomUUID();const abort=()=>{waiting.delete(id);reject(signal.reason??new Error('Cancelled'));};if(signal?.aborted)return abort();signal?.addEventListener('abort',abort,{once:true});waiting.set(id,{resolve:value=>{signal?.removeEventListener('abort',abort);resolve(value);},reject:error=>{signal?.removeEventListener('abort',abort);reject(error);}});process.send({type:'rpc',id,action,args});});
export default function(pi) {
  return managedHelperExtension({root:process.env.COTHINK_HELPER_CWD,resources:process.env.COTHINK_HELPER_RESOURCES,
    scope:JSON.parse(process.env.COTHINK_HELPER_SCOPE??'[]'),readOnly:process.env.COTHINK_HELPER_READONLY==='1',
    outputCap:process.env.COTHINK_HELPER_OUTPUT_CAP?Number(process.env.COTHINK_HELPER_OUTPUT_CAP):null,rpc,
    observe:data=>{if(process.connected)process.send({type:'request-observation',data});}})(pi);
}
/** Same scoped tools for native in-process SDK children; no process-wide env changes. */
export function managedHelperExtension({root,resources,scope,readOnly,outputCap=null,rpc,observe,assertAllowed=()=>{},native=false,expectedModel,runSource,verifyCopy=()=>{},childResults}) {
 return function(pi) {
  if(!root)throw new Error('Missing task-owned helper cwd');
  async function checked(path,write=false) {
    assertAllowed();
    const absolute=resolve(root,path), rel=relative(root,absolute);
    const allowed=rel===''||(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('../'));
    const resourceRel=resources&&relative(resources,absolute);
    const resourceAllowed=!write&&resources&&(resourceRel===''||(!isAbsolute(resourceRel)&&resourceRel!=='..'&&!resourceRel.startsWith('../')));
    if(!allowed&&!resourceAllowed)throw new Error('HELPER_PATH: path outside independent copy/task resources');
    const portable=rel.replaceAll('\\','/');
    if(write&&(readOnly||!scope.some(path=>path==='.'||path===portable||portable.startsWith(path+'/'))))
      throw new Error('SCOPE: helper write outside assigned scope');
    if(rel.split(/[\\/]/).some(p=>p.toLowerCase()==='.git'))throw new Error('HELPER_PATH: .git is not source');
    const base=allowed?root:resources;
    let current=base;
    for(const part of relative(base,absolute).split(/[\\/]/).filter(Boolean)) {
      current=join(current,part);
      try {const s=await lstat(current);if(s.isSymbolicLink()||(!s.isDirectory()&&(!s.isFile()||s.nlink!==1)))throw new Error('HELPER_PATH: links/special files forbidden');}
      catch(error){if(error.code!=='ENOENT')throw error;}
    }
    return absolute;
  }
  const read=path=>checked(path).then(path=>readFile(path));
  const write=async(path,bytes)=>{path=await checked(path,true);await mkdir(dirname(path),{recursive:true});assertAllowed();await writeFile(path,bytes);};
  const definitions=[
    createReadToolDefinition(root,{operations:{readFile:read,access:path=>checked(path).then(path=>access(path)),detectImageMimeType:async()=>null}}),
    createWriteToolDefinition(root,{operations:{writeFile:write,mkdir:async path=>{await checked(path);}}}),
    createEditToolDefinition(root,{operations:{readFile:read,access:read,writeFile:write}}),
    createLsToolDefinition(root,{operations:{exists:async path=>{try{await access(await checked(path));return true;}catch{return false;}},stat:async path=>lstat(await checked(path)),readdir:async path=>readdir(await checked(path))}}),
    {name:'cothink_helper',label:'cothink_helper',description:'Launch a managed independent nested helper; raw user task and scope remain unchanged. Result must be reviewed using cothink_helper_result.',parameters:Type.Object({assignment:Type.String()}),execute:async(_id,args,signal)=>({content:[{type:'text',text:JSON.stringify(await rpc('launch',args,signal))}]})},
    {name:'cothink_helper_result',label:'cothink_helper_result',description:'Inspect actual diff or adopt/reject a helper result. Explain treatment; adoption changes only this creator copy.',parameters:Type.Object({helperId:Type.String(),decision:Type.Union([Type.Literal('inspect'),Type.Literal('adopt'),Type.Literal('reject')]),reason:Type.Optional(Type.String())}),execute:async(_id,args,signal)=>({content:[{type:'text',text:JSON.stringify(await rpc('result',args,signal))}]})},
    {name:'helper_exec',label:'helper_exec',description:'Execute in fixed offline Docker image; project copy at /workspace, frozen resources at /resources. No host shell fallback.',parameters:Type.Object({command:Type.String()}),execute:async(_id,args,signal)=>({content:[{type:'text',text:JSON.stringify(await rpc('exec',args,signal))}]})},
  ];
  if(native) {
    const searches=[createGrepToolDefinition(root,{operations:{isDirectory:async path=>(await lstat(await checked(path))).isDirectory(),readFile:async path=>(await read(path)).toString('utf8')}}),createFindToolDefinition(root,{operations:{exists:async path=>{try{await access(await checked(path));return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}}})];
    for(const definition of searches) {
      const execute=definition.execute;
      definitions.push({...definition,execute:async(id,args,signal,onUpdate,ctx)=>{
        const path=await checked(args.path??'.');verifyCopy();
        const binaries=definition.name==='grep'?['rg']:['fd','fdfind'];
        if(!binaries.some(binary=>!spawnSync(binary,['--version'],{stdio:'ignore'}).error))throw new Error('NATIVE_SEARCH_UNAVAILABLE: install '+binaries.join('/')+' explicitly; managed tools do not download executables');
        return execute(id,{...args,path},signal,onUpdate,ctx);
      }});
    }
  }
  let sourceQueue=Promise.resolve();
  for(const definition of definitions.filter(d=>!native||!['cothink_helper','helper_exec'].includes(d.name))) {
    const execute=definition.execute;
    pi.registerTool({...definition,execute(...args){
      const operation=()=>{assertAllowed();return execute(...args);};
      if(runSource)return runSource(operation);
      const run=sourceQueue.catch(()=>{}).then(operation);sourceQueue=run;return run;
    }});
  }
  if(native) {
    const exec=definitions.find(d=>d.name==='helper_exec');
    pi.registerTool({...exec,name:'bash',label:'bash',execute:async(...args)=>{const operation=()=>{assertAllowed();return exec.execute(...args);};return runSource?runSource(operation):operation();}});
    pi.on('tool_call',()=>{assertAllowed();});
    pi.on('tool_result',async event=>{
      if(!['subagent','subagents_enable'].includes(event.toolName))return;
      const results=await childResults?.()??[];
      if(results.length&&['subagent','subagents_enable'].includes(event.toolName))return {content:[...event.content,{type:'text',text:JSON.stringify({nativeHostResults:results,instruction:'Creator must inspect/adopt/reject using cothink_helper_result; text dependency never incorporates files.'})}]};
    });
  }
  let usageSeen=false;
  pi.on('before_provider_request',(event,ctx)=>{
    assertAllowed();
    if(expectedModel&&(ctx.model?.provider!==expectedModel.provider||ctx.model?.id!==expectedModel.modelId))throw new Error('PLUGIN_MODEL_UNBOUND: provider request differs from frozen admitted model');
    if(expectedModel&&(ctx.model?.api!==expectedModel.api||ctx.model?.baseUrl!==expectedModel.baseUrl))throw new Error('PLUGIN_MODEL_UNBOUND: provider API/endpoint differs from frozen owner runtime');
    usageSeen=false;const payload=event.payload;
    const cap=outputCap;
    const optional=['openai-completions','openai-responses','openai-codex-responses','google-generative-ai'].includes(ctx.model?.api);
    if(cap===null&&!optional)throw new Error('REQUIRED_OUTPUT_LIMIT: this provider requires an explicit output cap');
    if(payload&&typeof payload==='object') {
      for(const key of ['max_tokens','max_completion_tokens','max_output_tokens'])if(cap===null)delete payload[key];else if(key in payload)payload[key]=cap;
      if(payload.generationConfig){if(cap===null)delete payload.generationConfig.maxOutputTokens;else payload.generationConfig.maxOutputTokens=cap;}
    }
    return payload;
  });
  pi.on('provider_stream_event',event=>{const data=event.data;if(data?.usage||data?.message?.usage||data?.response?.usage||data?.choices?.[0]?.usage||data?.usageMetadata)usageSeen=true;});
  pi.on('message_end',event=>{if(event.message?.role==='assistant')observe?.({usageSeen,status:event.message.stopReason,model:event.message.model,usage:usageSeen?event.message.usage:null,text:event.message.content?.filter(c=>c.type==='text').map(c=>c.text).join('')??''});});
  pi.on('session_before_compact',()=>({cancel:true}));
};
}
