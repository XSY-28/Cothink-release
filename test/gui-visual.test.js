import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { fixture } from "./helpers/pi-fixture.js";
import { repository } from "./helpers/git-fixture.js";
import { pathToFileURL, fileURLToPath } from "node:url";
const packageRoot=resolve(process.env.COTHINK_TEST_PACKAGE_ROOT??fileURLToPath(new URL("..",import.meta.url)));
const load=path=>import(pathToFileURL(join(packageRoot,path)));
const {saveConfig}=await load("src/config.js");
const {createTeamConfig}=await load("src/teams.js");
const {startGuiServer}=await load("src/gui-server.js");
import { execution } from "./helpers/agent-sync-fixture.js";
const tool = (name, args = {}) => ({ toolCalls: [{ name, args }] });
test(
  "actual GUI preserves missing-project draft, submits ONE HTML, shows authenticated final screenshots at three widths",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t, (c, n) =>
      c.body.tools?.some(x=>x.function.name==='submit_visual_review')
        ? tool('submit_visual_review',{verdict:'match',observation:'蓝色矩形',reasons:'当前视口中颜色与原题一致。'})
        : n === 1
        ? tool("write", {
            path: "index.html",
            content:
              '<meta charset="utf-8"><h1>蓝色作品</h1><svg width="240" height="100"><rect width="240" height="100" fill="blue"/></svg>',
          })
        : n === 2
          ? tool("accept_change")
          : { text: "GUI visual delivery" },
    );
    const repo = repository(t);
    const file = join(f.home, "pi/models.json"),
      catalog = JSON.parse(readFileSync(file));
    for (const m of catalog.providers.fixture.models)
      m.input = ["text", "image"];
    writeFileSync(file, JSON.stringify(catalog));
    saveConfig(
      f.home,
      createTeamConfig(
        {
          formatVersion: 2,
          ...f.models,
          piResources: {
            skills: [
              new URL("./fixtures/visual-skill/SKILL.md", import.meta.url)
                .pathname,
            ],
          },
          work: {
            checks: [],
            execution: {
              ...execution,
              image: JSON.parse(
                readFileSync(
                  new URL(
                    "../docker/visual-preview-manifest.json",
                    import.meta.url,
                  ),
                ),
              ).image,
            },
          },
        },
        "Visual fixture",
        "7c8094cd-3476-4bfa-8f53-055d87972896",
      ),
    );
    const h = await startGuiServer({
      home: f.home,
      cwd: repo.project,
      open: false,
    });
    t.after(() => h.close());
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await page.goto(h.url);
    await page.getByRole("dialog", { name: "本次更新" }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByLabel("输入问题").fill("Keep my draft");
    await page
      .getByRole("button", { name: "制作HTML/SVG", exact: true })
      .click();
    await page
      .getByText("制作HTML/SVG需要先选择项目；草稿已保留。", { exact: true })
      .waitFor();
    assert.equal(
      await page.getByLabel("输入问题").inputValue(),
      "Keep my draft",
    );
    assert.equal(f.calls.length, 0);
    await page.getByRole("button", { name: /打开项目/ }).click();
    await page.getByLabel("项目绝对路径").fill(repo.project);
    await page
      .getByRole("button", { name: "只读检查项目", exact: true })
      .click();
    await page.getByRole("button", { name: "为此项目新建对话" }).click();
    await page
      .getByRole("dialog", { name: "打开项目" })
      .waitFor({ state: "hidden" });
    await page.getByLabel("对话模式").selectOption("one");
    await page.getByLabel("输入问题").fill("制作一个蓝色矩形");
    await page
      .getByRole("button", { name: "制作HTML/SVG", exact: true })
      .dblclick();
    await page
      .getByText("GUI visual delivery", { exact: false })
      .first()
      .waitFor({ timeout: 30000 });
    await page.getByRole("button", { name: "查看变更与检查" }).click();
    await page.getByRole("button", { name: "检查", exact: true }).click();
    await page
      .getByText("index.html · 最终版本审查完成", { exact: true })
      .waitFor();
    await page.locator(".visual-frame img").first().waitFor();
    assert.ok(
      await page
        .locator(".visual-frame img")
        .first()
        .evaluate((i) => i.complete && i.naturalWidth > 0),
    );
    const out = resolve("work/task-fidelity/gui");
    mkdirSync(out, { recursive: true });
    for (const [width, height] of [
      [1280, 800],
      [1024, 768],
      [800, 600],
    ]) {
      await page.setViewportSize({ width, height });
      if (width === 800)
        await page
          .locator(".visual-frame img")
          .first()
          .scrollIntoViewIfNeeded();
      await page.screenshot({
        path: join(out, `${width}.png`),
        fullPage: true,
      });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
    }
    assert.equal(f.calls.length, 4);
    assert.ok(f.calls.every((c) => c.body.model === "main"));
    assert.deepEqual(errors, []);
  },
);

test('actual browser runs installed plugin dialogs and slash commands, rejects native TUI and removes stale commands on reload', {timeout:60000}, async t=>{
  const {runPackageCommand}=await load('src/packages.js');
  const f=await fixture(t),root=join(f.home,'browser-plugin');mkdirSync(root);
  const extension=join(root,'index.js');
  writeFileSync(join(root,'package.json'),JSON.stringify({name:'browser-native',version:'1.0.0',type:'module',pi:{extensions:['index.js']}}));
  writeFileSync(extension,`export default pi=>{
    pi.registerCommand('browser-dialog',{description:'浏览器插件交互',handler:async(_a,ctx)=>{const choice=await ctx.ui.select('插件选择',['A','B']);const text=await ctx.ui.input('插件输入','请输入');const confirmed=await ctx.ui.confirm('插件确认','保存本次选择？');ctx.ui.notify('PLUGIN_DIALOG:'+JSON.stringify({choice,text,confirmed}));}});
    pi.registerCommand('terminal-component',{handler:async(_a,ctx)=>ctx.ui.custom(()=>{throw Error('must not run terminal factory');})});
  };`);
  assert.equal((await runPackageCommand({home:f.home,cwd:f.cwd,command:'install',source:root})).exitCode,0);
  saveConfig(f.home,createTeamConfig({formatVersion:2,...f.models},'Plugin fixture','7c8094cd-3476-4bfa-8f53-055d87972896'));
  const h=await startGuiServer({home:f.home,cwd:f.cwd,open:false});t.after(()=>h.close());
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('status of 400'))errors.push(m.text());});
  const rejected=[];page.on('response',async response=>{if(response.status()===400)rejected.push(await response.json());});
  await page.goto(h.url);await page.getByRole('dialog',{name:'本次更新'}).waitFor();await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'插件命令',exact:true}).click();await page.getByRole('button',{name:'/browser-dialog',exact:true}).click();
  await page.getByRole('dialog',{name:'插件选择'}).waitFor();
  const evidence=join(packageRoot,'work/pi-plugin-compatibility');mkdirSync(evidence,{recursive:true});await page.screenshot({path:join(evidence,'stage3-browser-plugin-select.png')});
  await page.getByLabel('插件选项').selectOption('B');await page.getByRole('button',{name:'继续',exact:true}).click();
  await page.getByRole('dialog',{name:'插件输入'}).waitFor();await page.getByRole('textbox',{name:'插件输入',exact:true}).fill('中文 <script>literal</script>');await page.getByRole('button',{name:'继续',exact:true}).click();
  await page.getByRole('dialog',{name:'插件确认'}).waitFor();await page.getByRole('button',{name:'确认',exact:true}).click();
  await page.getByText('PLUGIN_DIALOG:',{exact:false}).waitFor();assert.equal(await page.locator('script:not([src])').count(),0);
  await page.getByRole('button',{name:'插件命令',exact:true}).click();await page.getByRole('button',{name:'/terminal-component',exact:true}).click();await page.getByRole('alert').filter({hasText:'EXTENSION_UI_UNSUPPORTED'}).waitFor();
  writeFileSync(extension,`export default pi=>pi.registerCommand('browser-new',{description:'重载后的命令',handler:async(_a,ctx)=>ctx.ui.notify('RELOADED_BROWSER')});`);
  await page.getByRole('button',{name:'插件命令',exact:true}).click();await page.getByRole('button',{name:'重载插件',exact:true}).click();await page.getByRole('button',{name:'/browser-new',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'/browser-dialog',exact:true}).count(),0);
  await page.getByRole('button',{name:'/browser-new',exact:true}).click();await page.getByText('RELOADED_BROWSER',{exact:true}).waitFor();
  await page.getByLabel('输入问题').fill('/browser-new');await page.getByLabel('输入问题').press('Enter');
  await page.waitForFunction(()=>document.querySelector('#message-input')?.value==='');
  await page.screenshot({path:join(evidence,'stage3-browser-plugin-complete.png')});assert.equal(f.calls.length,0);assert.deepEqual(errors,[]);assert.equal(rejected.length,1);assert.match(JSON.stringify(rejected[0]),/EXTENSION_UI_UNSUPPORTED.*custom/);
});
