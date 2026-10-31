import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, unlinkSync, chmodSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { managed } from './helpers/agent-sync-fixture.js';
import { snapshotHelper, freezeHelperResult, treatHelperResult, helperBlockers } from '../src/plugin-work.js';
async function helper(f,id='helper') {
  const cwd=join(f.home,id),snapshot=await snapshotHelper({versioning:f.v,change:f.binding.current,directory:cwd});
  const h={helperId:id,parentActorId:'main',changeId:f.binding.current.changeId,cwd,snapshot,...snapshot,status:'completed',stoppedAt:new Date().toISOString()};
  f.task.record.work??={helpers:[]};f.task.record.work.helpers.push(h);return h;
}
test('independent public snapshots preserve binary, add/delete/mode and require creator review before import',async t=>{
 const f=await managed(t,{scope:['.']});
 const a=await helper(f,'a'),b=await helper(f,'b');
 assert.notEqual(a.cwd,b.cwd);assert.equal(a.inputVersion,b.inputVersion);
 writeFileSync(join(a.cwd,'binary'),Buffer.from([0,255,3]));unlinkSync(join(a.cwd,'a.txt'));chmodSync(join(a.cwd,'b.txt'),0o755);
 freezeHelperResult(a);assert.equal(helperBlockers(f.task).length,2);
 await assert.rejects(treatHelperResult({task:f.task,versioning:f.v,helper:a,actor:'impostor',binding:f.binding,decision:'adopt',reason:'reviewed'}),{code:'HELPER_PARENT'});
 f.binding.reviewedVersion=a.inputVersion;
 await treatHelperResult({task:f.task,versioning:f.v,helper:a,actor:'main',binding:f.binding,decision:'adopt',reason:'reviewed bytes and intended deletion'});
 assert.equal(f.binding.reviewedVersion,null);
 const got=await f.v.read({changeId:a.changeId,path:'binary'});assert.deepEqual(Buffer.from(got.contentBase64,'base64'),Buffer.from([0,255,3]));
 assert.equal((await f.v.read({changeId:a.changeId,path:'a.txt'})).contentBase64,null);
 assert.equal((await f.v.read({changeId:a.changeId,path:'b.txt'})).mode,process.platform==='win32'?'100644':'100755');
 writeFileSync(join(b.cwd,'a.txt'),'stale sibling');freezeHelperResult(b);
 await assert.rejects(treatHelperResult({task:f.task,versioning:f.v,helper:b,actor:'main',binding:f.binding,decision:'adopt',reason:'stale'}),{code:'STALE_PRIVATE'});
 assert.equal(b.import,undefined);assert.equal(readFileSync(join(f.project,'a.txt'),'utf8'),'base A\n');
});
test('readonly text handles without synthetic import; unauthorized/link results retained and rejected',async t=>{
 const f=await managed(t,{readOnly:true,scope:[],readScope:['a.txt']});const a=await helper(f);freezeHelperResult(a);
 const result=await treatHelperResult({task:f.task,versioning:f.v,helper:a,actor:'main',binding:f.binding,decision:'adopt',reason:'read-only findings reviewed'});
 assert.equal(result.status,'text_adopted');assert.equal(a.import,undefined);
 const b=await helper(f,'bad');writeFileSync(join(b.cwd,'escape'),'bad');assert.throws(()=>freezeHelperResult(b),{code:'SCOPE'});assert.equal(readFileSync(join(b.cwd,'escape'),'utf8'),'bad');
 const c=await helper(f,'link');symlinkSync(join(f.project,'a.txt'),join(c.cwd,'link'));assert.throws(()=>freezeHelperResult(c),{code:'HELPER_FILE_TYPE'});
});
test('uncertain import is recovered by original request ID only; no new edit after response loss',async t=>{
 const f=await managed(t,{scope:['.']});const a=await helper(f);writeFileSync(join(a.cwd,'a.txt'),'candidate');freezeHelperResult(a);
 const edit=f.v.edit;let calls=0;f.v.edit=async(...args)=>{calls++;await edit(...args);throw Error('lost response');};
 await assert.rejects(treatHelperResult({task:f.task,versioning:f.v,helper:a,actor:'main',binding:f.binding,decision:'adopt',reason:'reviewed'}),/lost response/);
 const id=a.import.requestId;
 const inspect=f.v.inspect;
 f.v.inspect=async input=>input.requestId===id?{status:'not_found'}:inspect(input);
 await assert.rejects(treatHelperResult({task:f.task,versioning:f.v,helper:a,actor:'main',binding:f.binding,decision:'reject',reason:'Do not hide unknown import'}),{code:'OPERATION_UNKNOWN'});
 assert.equal(helperBlockers(f.task).length,1);assert.equal(a.treatment,undefined);assert.equal(calls,1);
 f.v.inspect=inspect;
 await assert.rejects(treatHelperResult({task:f.task,versioning:f.v,helper:a,actor:'main',binding:f.binding,decision:'reject',reason:'Reject after actual applied edit'}),{code:'HELPER_IMPORT_APPLIED'});
 assert.equal(a.treatment.decision,'adopted');assert.equal(a.import.status,'applied');assert.equal(helperBlockers(f.task).length,0);
 const fact=await treatHelperResult({task:f.task,versioning:f.v,helper:a,actor:'main',binding:f.binding,decision:'adopt',reason:'recover'});
 assert.equal(fact.status,'applied');assert.equal(calls,1);assert.equal(a.import.requestId,id);
 assert.equal(readFileSync(join(f.binding.current.workspace,'a.txt'),'utf8'),'candidate');
 const newerBinding={current:{changeId:'new-current-change',privateVersion:'new-current-version',workspace:'new-independent-copy'},reviewedVersion:'reviewed-new-version'};const beforeNewer=structuredClone(newerBinding);
 await treatHelperResult({task:f.task,versioning:f.v,helper:a,actor:'main',binding:newerBinding,decision:'adopt',reason:'Observe original receipt only'});assert.deepEqual(newerBinding,beforeNewer);assert.equal(calls,1);
 const cancelled=await helper(f,'cancel-after-inspect');writeFileSync(join(cancelled.cwd,'cancelled-owner.txt'),'AFTER_OWNER_CANCEL');freezeHelperResult(cancelled);
 const owner=new AbortController();
 f.v.inspect=async input=>{const fact=await inspect(input);if(input.changeId===cancelled.changeId)owner.abort();return fact;};
 await assert.rejects(treatHelperResult({task:f.task,versioning:f.v,helper:cancelled,actor:'main',binding:f.binding,decision:'adopt',reason:'Cancel during current-version inspection',signal:owner.signal,
   assertAllowed:()=>{if(owner.signal.aborted)throw Object.assign(Error('Owner cancelled'),{code:'CANCELLED'});}}),{code:'CANCELLED'});
 assert.equal(cancelled.import,undefined);assert.equal(calls,1);f.v.inspect=inspect;
 assert.equal((await f.v.read({changeId:cancelled.changeId,path:'cancelled-owner.txt'})).contentBase64,null);
});
