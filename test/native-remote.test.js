import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,chmodSync,realpathSync,unlinkSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {remoteCopyOperation,validateRemoteFiles} from '../src/native-remote-files.js';
const file=(bytes,mode='100644')=>({contentBase64:Buffer.from(bytes).toString('base64'),contentHash:createHash('sha256').update(bytes).digest('hex'),mode});
test('private remote copy preserves binary/mode/deletion and rejects result escape',t=>{
 const parent=realpathSync(mkdtempSync(join(tmpdir(),'remote-copy-')));t.after(()=>rmSync(parent,{recursive:true,force:true}));const owner=randomUUID();
 const original=join(parent,'original');writeFileSync(original,'untouched');
 const copy=remoteCopyOperation({action:'init',owner,parent,trees:{source:{'binary':file(Buffer.from([0,255,1])),'remove':file('old'),'mode':file('tool','100755')},resources:{'skill/SKILL.md':file('frozen')}}});
 assert.notEqual(copy.root,parent);assert.deepEqual(readFileSync(join(copy.root,'source/binary')),Buffer.from([0,255,1]));
 unlinkSync(join(copy.root,'source/remove'));chmodSync(join(copy.root,'source/mode'),0o644);
 const result=remoteCopyOperation({action:'scan',root:copy.root,owner});assert.equal(result.files.remove,undefined);assert.equal(result.files.mode.mode,'100644');assert.equal(result.files.binary.contentBase64,'AP8B');assert.equal(readFileSync(original,'utf8'),'untouched');
 assert.throws(()=>remoteCopyOperation({action:'scan',root:copy.root,owner:randomUUID()}),/owner mismatch/);
 symlinkSync(original,join(copy.root,'source/link'));assert.throws(()=>remoteCopyOperation({action:'scan',root:copy.root,owner}),/symbolic link/);
});
test('remote transfer rejects bad bytes, traversal and case aliases before materializing files',()=>{
 for(const files of [{'../x':file('x')},{'.git/x':file('x')},{'x':{...file('x'),contentBase64:'!!'}},{'x':{...file('x'),contentHash:'0'.repeat(64)}},{'A/x':file('x'),'a/y':file('y')},{x:file('x'),'x/y':file('y')}])assert.throws(()=>validateRemoteFiles(files),/REMOTE_COPY/);
});
