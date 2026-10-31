// A process-exit witness around the real Pi CLI, not a model/session runner.
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,renameSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const manifest=JSON.parse(readFileSync(process.env.COTHINK_NATIVE_REMOTE_MANIFEST,'utf8'));
const write=(name,value)=>{const target=join(manifest.privateRoot,name),temp=target+'.tmp';writeFileSync(temp,JSON.stringify(value),{flag:'wx',mode:0o600});renameSync(temp,target);};
for(const [file,expected] of Object.entries(manifest.runtimeFiles)){
 const stat=lstatSync(file);if(!stat.isFile()||stat.nlink!==1||createHash('sha256').update(readFileSync(file)).digest('hex')!==expected)throw new Error('REMOTE_RUNTIME: executable/module digest changed');
}
const startTime=pid=>{const stat=readFileSync('/proc/'+pid+'/stat','utf8');return stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];};
const child=spawn(manifest.node,[manifest.piCli,...process.argv.slice(2)],{cwd:manifest.contract.cwd,env:process.env,stdio:'inherit'});
const identity={owner:manifest.contract.launchId,contractDigest:manifest.contractDigest,supervisorPid:process.pid,supervisorStartTime:startTime(process.pid),pid:child.pid,childStartTime:startTime(child.pid),piCli:manifest.piCli,cwd:manifest.contract.cwd};
write('process-start.json',{...identity,at:new Date().toISOString()});
for(const signal of ['SIGTERM','SIGINT','SIGHUP'])process.on(signal,()=>{child.kill(signal);});
child.on('error',error=>{write('process-exit.json',{owner:manifest.contract.launchId,contractDigest:manifest.contractDigest,pid:child.pid??null,error:error.message,code:null,signal:null});process.exitCode=1;});
child.on('close',(code,signal)=>{write('process-exit.json',{...identity,code,signal,at:new Date().toISOString()});process.exitCode=code??1;});
