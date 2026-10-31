// Private remote-copy transport program. Invoked over the admitted SSH connection,
// never registered as a model tool and never an agent-sync writer.
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,readdirSync,lstatSync,realpathSync,chmodSync,rmSync,cpSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=message=>{throw new Error('REMOTE_COPY: '+message);};
const limit=64*1024*1024;
function pathOf(value){if(typeof value!=='string'||!value||value.startsWith('/')||/[\\\0]/.test(value)||value.split('/').some(p=>!p||p==='.'||p==='..'||p.toLowerCase()==='.git'))fail('invalid relative path');return value;}
function regular(file){const s=lstatSync(file);if(!s.isFile()||s.nlink!==1||s.isSymbolicLink())fail('not an unlinked regular file');return s;}
function directory(file){if(!lstatSync(file).isDirectory()||lstatSync(file).isSymbolicLink()||realpathSync(file)!==resolve(file))fail('directory is not canonical');}
export function readRemoteTree(root){directory(root);const files={},aliases=new Set();let total=0;
 const walk=(dir,prefix='')=>{for(const name of readdirSync(dir).sort()){
  const path=pathOf(prefix+name),key=path.normalize('NFC').toLowerCase();if(aliases.has(key))fail('case/Unicode alias');aliases.add(key);
  const file=join(dir,name),s=lstatSync(file);if(s.isSymbolicLink())fail('symbolic link');
  if(s.isDirectory()){walk(file,path+'/');continue;}regular(file);total+=s.size;if(total>limit)fail('source transfer exceeds 64 MiB');
  const bytes=readFileSync(file);files[path]={contentHash:hash(bytes),contentBase64:bytes.toString('base64'),mode:s.mode&0o111?'100755':'100644'};
 }};walk(root);return files;
}
export function validateRemoteFiles(files){if(!files||Array.isArray(files)||typeof files!=='object')fail('missing files');let total=0;const aliases=new Map();
 for(const [path,file] of Object.entries(files)){
  pathOf(path);for(let part=path;part!=='.';part=dirname(part)){const key=part.normalize('NFC').toLowerCase();if(aliases.has(key)&&aliases.get(key)!==part)fail('case/Unicode alias');aliases.set(key,part);}
  if(!file||!['100644','100755'].includes(file.mode)||typeof file.contentBase64!=='string'||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.contentBase64))fail('invalid mode/encoding');
  const bytes=Buffer.from(file.contentBase64,'base64');total+=bytes.length;if(total>limit||hash(bytes)!==file.contentHash)fail('invalid content digest/size');
  for(let parent=dirname(path);parent!=='.';parent=dirname(parent))if(Object.hasOwn(files,parent))fail('file/directory collision');
 }
 return files;
}
function writeFreshTree(root,files){validateRemoteFiles(files);mkdirSync(root,{mode:0o700});
 for(const [path,file] of Object.entries(files)){const dest=join(root,path);mkdirSync(dirname(dest),{recursive:true,mode:0o700});writeFileSync(dest,Buffer.from(file.contentBase64,'base64'),{flag:'wx',mode:file.mode==='100755'?0o755:0o644});}
}
export function remoteCopyOperation(input){
 if(typeof input.owner!=='string'||!/^[a-f0-9-]{36}$/.test(input.owner))fail('invalid owner identity');
 if(input.action==='init'){
  directory(input.parent);const root=input.exact?join(input.parent,'cothink-'+input.owner):mkdtempSync(join(input.parent,'cothink-'+input.owner+'-'));if(input.exact)mkdirSync(root,{mode:0o700});chmodSync(root,0o700);
  writeFileSync(join(root,'owner.json'),JSON.stringify({owner:input.owner}),{flag:'wx',mode:0o600});
  // Validate all trees before creating any runnable source/runtime. Partial init stays inspectable.
  for(const files of Object.values(input.trees??{}))validateRemoteFiles(files);
  for(const [name,files] of Object.entries(input.trees??{})){if(!['source','resources','runtime'].includes(name))fail('invalid tree name');writeFreshTree(join(root,name),files);}
  return {root,owner:input.owner,trees:Object.fromEntries(Object.entries(input.trees??{}).map(([name,files])=>[name,hash(JSON.stringify(files))]))};
 }
 const root=resolve(input.root);directory(root);regular(join(root,'owner.json'));
 if(JSON.parse(readFileSync(join(root,'owner.json'),'utf8')).owner!==input.owner)fail('owner mismatch');
 if(input.action==='scan')return {owner:input.owner,root,files:readRemoteTree(join(root,'source'))};
 if(input.action==='replace'){
  const source=join(root,'source'),before=readRemoteTree(source);if(hash(JSON.stringify(before))!==input.expectedDigest)fail('source changed during remote Docker operation');
  validateRemoteFiles(input.files);const candidate=join(root,'source-candidate-'+randomUUID());writeFreshTree(candidate,input.files);
  if(hash(JSON.stringify(readRemoteTree(source)))!==input.expectedDigest)fail('source changed before remote Docker publication');
  cpSync(source,join(root,'source-before-'+randomUUID()),{recursive:true});
  // Keep cwd inode stable for the actual native Pi process; managed source operations are held.
  for(const name of readdirSync(source))rmSync(join(source,name),{recursive:true});
  cpSync(candidate,source,{recursive:true});return {owner:input.owner,digest:hash(JSON.stringify(readRemoteTree(source)))};
 }
 fail('unsupported operation');
}
// Keep import usable for bounded local verification without performing transport side effects.
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const raw=readFileSync(0);if(raw.length>96*1024*1024)fail('request too large');process.stdout.write(JSON.stringify(remoteCopyOperation(JSON.parse(raw))));}
 catch(error){process.stderr.write(String(error.message)+'\n');process.exitCode=1;}
}
