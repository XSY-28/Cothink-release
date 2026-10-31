import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,appendFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createTask,readRequests} from '../src/task.js';
function setup(t){const home=mkdtempSync(join(tmpdir(),'request-journal-'));t.after(()=>rmSync(home,{recursive:true,force:true}));const task=createTask({home,input:'offline',models:{main:{provider:'fixture',modelId:'main'},secondary:[]}});const call={id:randomUUID(),taskId:task.record.id,status:'in_flight',sent:true,actualModel:{api:'openai-completions'},events:[],usage:null,_secrets:['private-probe-key']};task.register(call);task.writeRequest(call);return {home,task,call,path:join(home,'requests',call.id+'.json'),journal:join(home,'requests',call.id+'.events.jsonl')};}
test('long events append without rewriting metadata; finalized JSON remains independently readable',t=>{
 const f=setup(t),before=readFileSync(f.path);const events=Array.from({length:4000},(_,i)=>({choices:[{index:0,delta:{content:`片段${i} private-probe-key\n`}}]}));
 for(const e of events)f.task.appendRequestEvent(f.call,e);
 assert.deepEqual(readFileSync(f.path),before,'stream events must not rewrite the growing snapshot');
 const bytes=statSync(f.path).size+statSync(f.journal).size;assert.ok(bytes<2*Buffer.byteLength(JSON.stringify(events)),'persistence volume stays proportional to event content');
 const recovered=readRequests(f.home,f.task.record)[0];assert.equal(recovered.status,'outcome_unknown');assert.equal(recovered.events.length,4000);assert.match(recovered.text,/片段3999/);assert.doesNotMatch(JSON.stringify(recovered),/private-probe-key/);
 f.call.status='completed';f.call.text='final answer';f.task.writeRequest(f.call);
 const full=JSON.parse(readFileSync(f.path));assert.equal(full.events.length,4000);assert.equal(full.text,'final answer');
 rmSync(f.journal);assert.equal(readRequests(f.home,f.task.record)[0].status,'completed');
 f.task.finish('completed');
});
test('incomplete journal tail recovers committed prefix without editing evidence or claiming completion',t=>{
 const f=setup(t);f.task.appendRequestEvent(f.call,{choices:[{delta:{content:'已收到内容'}}]});
 appendFileSync(f.journal,'{"sequence":1,"event":');const before=readFileSync(f.journal);
 const r=readRequests(f.home,f.task.record)[0];assert.equal(r.text,'已收到内容');assert.equal(r.events.length,1);assert.equal(r.status,'outcome_unknown');assert.equal(r.journalRecovery.incompleteTail,true);assert.deepEqual(readFileSync(f.journal),before);
 f.task.finish('failed');
});
test('journal corruption or wrong ownership is visible instead of silently discarding events',t=>{
 const f=setup(t);f.task.appendRequestEvent(f.call,{choices:[{delta:{content:'x'}}]});
 const lines=readFileSync(f.journal,'utf8').trim().split('\n');const event=JSON.parse(lines[1]);event.sequence=3;writeFileSync(f.journal,lines[0]+'\n'+JSON.stringify(event)+'\n');
 assert.throws(()=>readRequests(f.home,f.task.record),/序号|损坏/);
 const header=JSON.parse(lines[0]);header.taskId=randomUUID();writeFileSync(f.journal,JSON.stringify(header)+'\n'+lines[1]+'\n');assert.throws(()=>readRequests(f.home,f.task.record),/归属|损坏/);
 f.task.finish('failed');
});
test('legacy snapshots remain readable without a journal',t=>{
 const f=setup(t);f.task.finish('failed');writeFileSync(f.path,JSON.stringify({id:f.call.id,taskId:f.task.record.id,status:'completed',text:'old reply',events:[{old:true}]}));rmSync(f.journal);assert.equal(readRequests(f.home,f.task.record)[0].text,'old reply');
});

import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
test('killing the writer recovers acknowledged events from disk without finishing or sending anything',async t=>{
 const home=mkdtempSync(join(tmpdir(),'request-crash-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
 const source=`import {createTask} from ${JSON.stringify(new URL('../src/task.js',import.meta.url).href)};
 import {randomUUID} from 'node:crypto';
 globalThis.fetch=()=>{throw Error('network forbidden');};
 const task=createTask({home:process.argv[1],input:'crash',models:{}});
 const call={id:randomUUID(),taskId:task.record.id,status:'in_flight',sent:true,events:[],usage:null};
 task.register(call);task.writeRequest(call);task.save();
 for(let i=0;i<32;i++)task.appendRequestEvent(call,{choices:[{delta:{content:'片段'+i+'\\n'}}]});
 process.stdout.write(JSON.stringify(task.record)+'\\n');setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['--input-type=module','-e',source,home],{stdio:['ignore','pipe','pipe']});
 t.after(()=>child.kill('SIGKILL'));
 const record=await new Promise((resolve,reject)=>{let out='';child.stdout.on('data',b=>{out+=b;if(out.includes('\n'))resolve(JSON.parse(out.split('\n')[0]));});child.on('error',reject);child.on('exit',()=>reject(Error('writer exited before acknowledgement')));});
 const exited=once(child,'exit');child.kill('SIGKILL');await exited;
 const r=readRequests(home,record)[0];assert.equal(r.status,'outcome_unknown');assert.equal(r.events.length,32);assert.match(r.text,/片段31/);assert.equal(r.usage,null);
});
test('a partial journal write aborts the task, keeps the durable prefix and allows a terminal recovery snapshot',t=>{
 const f=setup(t);f.task.appendRequestEvent(f.call,{choices:[{delta:{content:'first'}}]});
 const original=fs.writeSync;
 try{
   fs.writeSync=(fd,buffer,offset,length)=>{original(fd,buffer,offset,Math.min(length,12));throw Object.assign(Error('disk full'),{code:'ENOSPC'});};syncBuiltinESMExports();
   assert.throws(()=>f.task.appendRequestEvent(f.call,{choices:[{delta:{content:'second'}}]}),/disk full/);
 }finally{fs.writeSync=original;syncBuiltinESMExports();}
 assert.equal(f.task.ioError.code,'ENOSPC');assert.equal(f.task.signal.aborted,true);
 const r=readRequests(f.home,f.task.record)[0];assert.equal(r.events.length,1);assert.equal(r.journalRecovery.incompleteTail,true);
 f.call.status='outcome_unknown';f.task.writeRequest(f.call);
 const recovered=readRequests(f.home,f.task.record)[0];assert.equal(recovered.events.length,2);assert.equal(recovered.status,'outcome_unknown');
 f.task.finish('partial');
});
