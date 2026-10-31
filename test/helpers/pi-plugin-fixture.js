import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,cpSync,existsSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import assert from 'node:assert/strict';

/** Reconstruct migration input from the actual integrity-pinned npm tarball, not an inverse patch heuristic. */
export function restorePinnedPlugin(f,plugin,patch,revision) {
  const packed=JSON.parse(execFileSync('npm',['pack',patch.package+'@'+patch.version,'--offline','--ignore-scripts','--json','--pack-destination',f.home],{cwd:f.home,encoding:'utf8',stdio:['ignore','pipe','pipe']}))[0];
  assert.equal(packed.integrity,patch.integrity);
  const original=join(f.home,'pristine-plugin');mkdirSync(original,{recursive:true});
  execFileSync('tar',['-xzf',join(f.home,packed.filename),'-C',original],{stdio:'pipe'});
  for(const file of patch.files) {
    const path=join(plugin,file.path);
    if(file.before===null){if(existsSync(path))unlinkSync(path);continue;}
    cpSync(join(original,'package',file.path),path);
  }
  if(!revision){if(existsSync(join(plugin,'cothink-compatibility.json')))unlinkSync(join(plugin,'cothink-compatibility.json'));return;}
  for(const file of revision.files) {
    const path=join(plugin,file.path);let text=readFileSync(path,'utf8');
    for(const [before,after] of file.replacements){assert.equal(text.split(before).length,2);text=text.replace(before,after);}
    writeFileSync(path,text);
  }
  writeFileSync(join(plugin,'cothink-compatibility.json'),JSON.stringify({package:revision.package,version:revision.version,revision:revision.revision,upstreamIntegrity:revision.integrity,files:revision.files.map(({path,before,after})=>({path,upstreamSha256:before,patchedSha256:after}))},null,2)+'\n');
}
