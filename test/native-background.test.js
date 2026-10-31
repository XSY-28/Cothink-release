import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeBroker,connectNativeBroker} from '../src/native-background.js';

test('authenticated native request ledger queries original receipts and denies repeated start permission',async t=>{
 let starts=0,saves=0;const record={runnerId:'runner',requests:[]},task={record:{id:'task'},save(){saves++;}};
 const broker=await createNativeBroker({task,epoch:'epoch'});t.after(()=>broker.close());
 const capability=broker.register({record,assertAllowed(){},dispatch(action){if(action==='claimStart'){starts++;return {claimed:true};}throw Error('Unexpected action');}});
 const client=await connectNativeBroker(capability,{});t.after(()=>client.close());
 // Losing/discarding a reply permits only observation by original request ID.
 await client.request('claimStart',{launchId:'launch'},'original-request');
 const receipt=await client.request('query',{requestId:'original-request'});assert.equal(receipt.status,'done');assert.equal(receipt.value.claimed,true);
 await assert.rejects(client.request('claimStart',{launchId:'launch'},'original-request'),/observation only/);
 await assert.rejects(client.request('claimStart',{launchId:'changed'},'original-request'),/payload changed/);
 assert.equal(starts,1);assert.ok(saves>=3);
 await assert.rejects(connectNativeBroker({...capability,epoch:'old'},{}),/invalid, stale or already bound/);
});

test('native intent persistence failure prevents the side effect',async t=>{
 let calls=0,fail=false;const record={runnerId:'runner',requests:[]},task={record:{id:'task'},save(){if(fail)throw Error('disk unavailable');}};
 const broker=await createNativeBroker({task,epoch:'epoch'});t.after(()=>broker.close());
 const capability=broker.register({record,assertAllowed(){},dispatch(){calls++;return {};}}),client=await connectNativeBroker(capability,{});t.after(()=>client.close());
 fail=true;await assert.rejects(client.request('claimStart',{launchId:'launch'}),/disk unavailable/);assert.equal(calls,0);
});

test('cancelled task display retains unknown native runner before its first child',async()=>{
 const {taskDisplayStatus}=await import('../src/task.js');
 assert.equal(taskDisplayStatus({status:'cancelled',cancelRequestedAt:'now',cancelSettledAt:'now',tools:[{nativeBackground:true,status:'outcome_unknown'}]}),'stop_unknown');
 assert.equal(taskDisplayStatus({status:'cancelled',cancelRequestedAt:'now',cancelSettledAt:'now',tools:[{nativeBackground:true,status:'running'}]}),'cancelling');
});
