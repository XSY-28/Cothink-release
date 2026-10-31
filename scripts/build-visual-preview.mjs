/** CI/build-time asset preparation only. Models never invoke this downloader. */
import {mkdtempSync,cpSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const supplied=process.argv.indexOf('--context');
const context=supplied>=0?resolve(process.argv[supplied+1]):mkdtempSync(join(tmpdir(),'cothink-renderer-build-'));
const run=(cmd,args,options={})=>execFileSync(cmd,args,{cwd:root,stdio:'inherit',...options});
const manifestPath=join(root,'docker/visual-preview-manifest.json');
const manifest=JSON.parse(readFileSync(manifestPath));
try {
 if(supplied<0){
  if(process.platform!=='linux'||process.arch!=='arm64')throw Error('Asset download currently requires Linux ARM64; supply a verified Linux ARM64 build context on other hosts.');
  const core=join(root,'node_modules/playwright-core');
  if(JSON.parse(readFileSync(join(core,'package.json'))).version!==manifest.playwright)throw Error('Playwright version mismatch');
  cpSync(core,join(context,'playwright-core'),{recursive:true});
  run(process.execPath,[join(core,'cli.js'),'install','--only-shell','chromium'],{env:{...process.env,PLAYWRIGHT_BROWSERS_PATH:join(context,'browsers')}});
  cpSync(join(context,'browsers',`chromium_headless_shell-${manifest.chromiumRevision}`),join(context,`chromium_headless_shell-${manifest.chromiumRevision}`),{recursive:true});
 }
 for(const required of ['playwright-core',`chromium_headless_shell-${manifest.chromiumRevision}`])if(!existsSync(join(context,required)))throw Error('Missing build asset: '+required);
 cpSync(join(root,'scripts/visual-preview.mjs'),join(context,'visual-preview.mjs'));
 cpSync(join(root,'docker/visual-preview.Dockerfile'),join(context,'Dockerfile'));
 writeFileSync(join(context,'.dockerignore'),'browsers\n*.zip\nbrowser-part-*\n');
 run('docker',['build','--progress=plain','-t','cothink-visual-preview:ci',context]);
 const image=run('docker',['image','inspect','cothink-visual-preview:ci','--format','{{.Id}}'],{encoding:'utf8',stdio:'pipe'}).trim();
 if(!/^sha256:[a-f0-9]{64}$/.test(image))throw Error('Invalid built image identity');
 const packages=run('docker',['run','--rm','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--entrypoint','dpkg-query',image,'-W','-f=${Package}=${Version}\n'],{encoding:'utf8',stdio:'pipe'});
 writeFileSync(join(root,'docker/visual-preview-packages.lock'),packages);
 Object.assign(manifest,{image,rendererSha256:createHash('sha256').update(readFileSync(join(root,'scripts/visual-preview.mjs'))).digest('hex'),packagesSha256:createHash('sha256').update(packages).digest('hex')});
 writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
 console.log(JSON.stringify({image,rendererSha256:manifest.rendererSha256,platform:'linux/arm64'}));
} finally {if(supplied<0)rmSync(context,{recursive:true,force:true});}
