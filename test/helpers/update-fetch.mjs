// Test-process preload only. Production endpoint remains fixed and unconfigurable.
import { appendFileSync } from 'node:fs';
// Let Pi capture the original fetch before installing this deliberate test override.
import '@earendil-works/pi-coding-agent';
const original=globalThis.fetch;
globalThis.fetch=async(url,options)=>{
  if (String(url) !== 'https://registry.npmjs.org/cothink-v2/latest') return original(url,options);
  if (process.env.COTHINK_TEST_UPDATE_LOG) appendFileSync(process.env.COTHINK_TEST_UPDATE_LOG,'request\n');
  if (process.env.COTHINK_TEST_UPDATE_HANG === '1') return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(Error('abort')),{once:true}));
  if (process.env.COTHINK_TEST_UPDATE_DELAY_MS) await new Promise((yes,no)=>{const timer=setTimeout(yes,Number(process.env.COTHINK_TEST_UPDATE_DELAY_MS));options.signal.addEventListener('abort',()=>{clearTimeout(timer);no(Error('abort'));},{once:true});});
  return new Response(process.env.COTHINK_TEST_UPDATE_BODY || JSON.stringify({name:'cothink-v2',version:'99.0.0-pre.10'}),{status:Number(process.env.COTHINK_TEST_UPDATE_STATUS||200)});
};
