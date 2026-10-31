// One process owns one actual public plugin delegation; latch control before any SDK/plugin await.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
let cancelled=false,disconnected=false,shuttingDown=false,delegationStarted=false;
let pi,identity,resolveRelease;
const release=new Promise(resolve=>resolveRelease=resolve);
const cancel=()=>{cancelled=true;if(pi&&identity&&delegationStarted&&!shuttingDown)pi.events.emit('prompt-template:subagent:cancel',identity);};
process.on('message',message=>{if(message?.type==='cancel')cancel();else if(message?.type==='release')resolveRelease();});
process.on('disconnect',()=>{disconnected=true;cancel();resolveRelease();});
const input=JSON.parse(readFileSync(process.argv[2],'utf8'));
const send=message=>{if(process.connected)process.send(message);};
const {acquireSessionWriter,assertPackageReadable}=await import('./storage.js');
const lease=acquireSessionWriter(join(input.packageHome,'pi'),input.helperId);
let registration,required,runtime,response;
try {
  assertPackageReadable(input.packageHome);
  const {createRuntime}=await import('./pi-runtime.js');
  const {registerAgentViaEvents}=await import(pathToFileURL(join(input.pluginRoot,'bundle/agents.js')));
  const {registerRequiredChildExtensions}=await import(pathToFileURL(join(input.pluginRoot,'bundle/required-child-extensions.js')));
  runtime=await createRuntime({home:input.home,cwd:input.cwd,modelRef:input.model,
    packageSnapshot:{packages:[],extensions:[join(input.pluginRoot,'bundle/index.js')],skills:[],prompts:[],themes:[],diagnostics:[]},
    extensionFactories:[{name:'cothink-helper-owner',factory:api=>{pi=api;}}],
  });
  await runtime.session.bindExtensions({mode:'rpc'});
  identity={requestId:input.helperId,ownerRunId:input.taskId,nodeId:input.helperId};
  if(!cancelled&&!disconnected) {
    registration=registerAgentViaEvents({pi,name:'cothink-managed',definition:{
      description:'CoThink managed independent helper',systemPrompt:input.systemPrompt,systemPromptMode:'replace',
      inheritGlobalContext:false,inheritProjectContext:false,inheritSkills:false,
      tools:['read','write','edit','ls','cothink_helper','cothink_helper_result','helper_exec'],
      model:input.model.provider+'/'+input.model.modelId,allowNestedSubagents:false,
    }});
    required=registerRequiredChildExtensions({sessionId:runtime.sessionManager.getSessionId(),requireForAllRunners:true,extensions:[{id:'cothink-managed-tools',path:fileURLToPath(new URL('./plugin-helper-extension.js',import.meta.url))}]});
    let resolveResponse;const terminal=new Promise(resolve=>resolveResponse=resolve);
    for(const name of ['started','update','response'])pi.events.on('prompt-template:subagent:'+name,data=>{
      if(data.requestId!==identity.requestId)return;
      send({type:name,data});if(name==='response'){response=data;resolveResponse();}
    });
    send({type:'ready',pid:process.pid});
    // No await between this final cancellation check and the actual public dispatch.
    if(!cancelled&&!disconnected) {
      delegationStarted=true;
      pi.events.emit('prompt-template:subagent:request',{...identity,agent:'cothink-managed',task:input.assignment,context:'fresh',cwd:input.cwd,
        model:input.model.provider+'/'+input.model.modelId,thinking:runtime.session.thinkingLevel,timeoutMs:0,skill:false,artifacts:false,result:{kind:'text'}});
      await terminal;
    }
  }
  shuttingDown=true;
  if(!delegationStarted)send({type:'cancelled-before-launch'});
  await runtime.session.abort();required?.dispose();registration?.dispose();await runtime.dispose();
  send({type:'shutdown-ready'});await release;
  lease.release();send({type:'shutdown',response});if(process.connected)process.disconnect();
} catch(error) {
  send({type:'fatal',error:{message:error.message,code:error.code}});
  try{await runtime?.session.abort();await runtime?.dispose();}catch{}
  if(process.connected)process.disconnect();process.exitCode=1;
}
