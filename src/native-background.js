// Transport only: task records, authority and side effects remain in createHelperWork.
import {createServer,createConnection} from 'node:net';
import {randomUUID,createHash,timingSafeEqual} from 'node:crypto';
const fault=(code,message)=>Object.assign(new Error(message),{code});
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const equal=(a,b)=>typeof a==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export async function createNativeBroker({task,epoch}) {
  const credentials=new Map(),connections=new Set();let closed=false;
  const server=createServer(socket=>{
    connections.add(socket);let binding,buffer='';let queue=Promise.resolve();
    const send=value=>{if(!socket.destroyed)socket.write(JSON.stringify(value)+'\n');};
    socket.on('error',()=>{});
    socket.on('close',()=>{connections.delete(socket);binding?.onDisconnect?.();});
    socket.on('data',data=>{
      buffer+=data;if(buffer.length>8*1024*1024){socket.destroy();return;}
      let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
        void Promise.resolve().then(async()=>{
          let msg;try{msg=JSON.parse(line);
            if(!binding){const candidate=credentials.get(msg.runnerId);if(closed||msg.action!=='hello'||msg.epoch!==epoch||msg.taskId!==task.record.id||!candidate||!equal(msg.token,candidate.token)||candidate.connected)throw fault('NATIVE_AUTH','Runner capability is invalid, stale or already bound');
              candidate.assertAllowed();candidate.connected=true;binding=candidate;binding.send=send;binding.record.connection={epoch,at:new Date().toISOString()};task.save();send({id:msg.id,value:{connected:true}});return;}
            if(msg.action==='query'){const request=binding.record.requests?.find(r=>r.id===msg.args?.requestId);send({id:msg.id,value:request??null});return;}
            const payloadDigest=hash({action:msg.action,args:msg.args});const ledger=binding.record.requests??=[];
            const prior=ledger.find(r=>r.id===msg.id);
            if(prior){if(prior.payloadDigest!==payloadDigest)throw fault('NATIVE_REPLAY','Request ID payload changed');if(msg.action==='claimStart')throw fault('NATIVE_START_CLAIMED','A repeated start request is observation only; query its original receipt');send({id:msg.id,...(prior.status==='done'?{value:prior.value}:prior.error?{error:prior.error}:{error:{code:'OUTCOME_UNKNOWN',message:'Original request is unresolved; no replay'}})});return;}
            const entry={id:msg.id,action:msg.action,payloadDigest,status:'pending'};ledger.push(entry);task.save();
            try{entry.value=await binding.dispatch(msg.action,msg.args,{send,requestId:msg.id});entry.status='done';task.save();send({id:msg.id,value:entry.value});}
            catch(error){entry.status='failed';entry.error={code:error.code,message:error.message};task.save();send({id:msg.id,error:entry.error});}
          }catch(error){send({id:msg?.id,error:{code:error.code,message:error.message}});if(!binding)socket.end();}
        });
      }
    });
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {
    register({record,dispatch,assertAllowed,onDisconnect}){if(closed)throw fault('NATIVE_CLOSED','Broker closed');const token=randomUUID()+randomUUID();credentials.set(record.runnerId,{token,record,dispatch,assertAllowed,onDisconnect,connected:false});return {port:server.address().port,host:'127.0.0.1',taskId:task.record.id,epoch,runnerId:record.runnerId,token};},
    signal(runnerId,value){credentials.get(runnerId)?.send?.({event:'control',...value});},
    async close(){closed=true;for(const socket of connections)socket.destroy();await new Promise(resolve=>server.close(resolve));}
  };
}
export async function connectNativeBroker(manifest,{onControl,onDisconnect}) {
  const socket=createConnection({host:manifest.host,port:manifest.port});const pending=new Map();let buffer='',alive=true,closing=false;
  const request=(action,args,id=randomUUID())=>{const promise=new Promise((resolve,reject)=>{if(!alive)return reject(fault('NATIVE_OWNER_LOST','Owner connection closed; no replay'));pending.set(id,{resolve,reject});socket.write(JSON.stringify({id,action,args})+'\n');});promise.requestId=id;return promise;};
  socket.on('error',()=>{});
  socket.on('close',()=>{alive=false;for(const p of pending.values())p.reject(fault('OUTCOME_UNKNOWN','Owner connection lost; query original request ID, never replay generation'));pending.clear();if(!closing)onDisconnect?.();});
  socket.on('data',data=>{buffer+=data;let end;while((end=buffer.indexOf('\n'))>=0){let msg;try{msg=JSON.parse(buffer.slice(0,end));}catch{socket.destroy();return;}buffer=buffer.slice(end+1);if(msg.event==='control'){onControl?.(msg);continue;}const p=pending.get(msg.id);if(!p)continue;pending.delete(msg.id);msg.error?p.reject(fault(msg.error.code,msg.error.message)):p.resolve(msg.value);}});
  await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});
  const id=randomUUID();await new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});socket.write(JSON.stringify({id,action:'hello',...manifest})+'\n');});
  return {request,assertAlive(){if(!alive)throw fault('NATIVE_OWNER_LOST','Owner disconnected');},close(){closing=true;socket.end();}};
}
