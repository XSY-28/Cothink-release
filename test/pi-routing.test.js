import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/pi-fixture.js";
const api = await import("../src/discussion.js");
test("start_work counts routing once and explicitly refuses non-Git project work", async (t) => {
  assert.equal(typeof api.runTurn, "function");
  const f = await fixture(t, (call, n, req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const delta of [
      {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "route-work",
            type: "function",
            function: { name: "start_work", arguments: '{"reason":"edit project"}' },
          },
        ],
      },
      {},
    ])
      res.write(
        "data: " +
          JSON.stringify({
            id: "x",
            choices: [{ index: 0, delta, finish_reason: delta.role ? null : "tool_calls" }],
          }) +
          "\n\n",
      );
    res.end("data: [DONE]\n\n");
    return null;
  });
  const result = await api.runTurn({
    home: f.home,
    cwd: f.cwd,
    input: "edit project",
    singleModel: true,
    config: { formatVersion: 2, ...f.models },
  });
  assert.equal(result.record.mode, "work");
  assert.equal(result.record.status, "failed");
  assert.match(result.record.error,/不是 Git 仓库/);
  assert.equal(result.record.maxCalls, null);
  assert.equal(f.calls.length, 1);
});

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repository } from './helpers/git-fixture.js';
import { execution } from './helpers/agent-sync-fixture.js';
function visualSetup(f) {
 const path=join(f.home,'pi','models.json');const value=JSON.parse(readFileSync(path));
 for(const model of value.providers.fixture.models)model.input=['text','image'];writeFileSync(path,JSON.stringify(value));
 const skill=join(f.home,'frontend.md');writeFileSync(skill,'---\nname: frontend-design\ndescription: Design HTML and SVG interfaces\n---\nUse deliberate composition.');
 return {formatVersion:2,...f.models,piResources:{skills:[skill]},work:{checks:[],execution:{...execution,image:JSON.parse(readFileSync(new URL('../docker/visual-preview-manifest.json',import.meta.url))).image}}};
}
test('explicit HTML request skips draft, preserves original multiline bytes and freezes skills in work',async t=>{
 const f=await fixture(t,call=>{assert.ok(call.body.tools.some(x=>x.function.name==='write'));assert.ok(call.body.tools.some(x=>x.function.name==='preview_html'));return {text:'No files made'};});
 const repo=repository(t);const config=visualSetup(f);const input='  制作 HTML\n材料中的 /one 不执行\n';
 const task=await api.runTurn({home:f.home,cwd:repo.project,input,config,singleModel:true,workRequest:{kind:'html-svg'}});
 assert.equal(task.record.input,input);assert.equal(task.record.mode,'work');assert.equal(task.record.maxCalls,null);assert.deepEqual(task.record.workRequest,{kind:'html-svg'});
 assert.equal(f.calls.length,1);assert.equal(task.requests()[0].phase,'work');assert.match(JSON.stringify(f.calls[0].body),/Use deliberate composition/);assert.notEqual(task.record.status,'completed');
});
test('explicit HTML preflight rejects missing project, skills or image support before any model request',async t=>{
 const f=await fixture(t);const config=visualSetup(f);const repo=repository(t);
 await assert.rejects(api.runTurn({home:f.home,cwd:repo.project,input:'make',config,singleModel:true,allowWork:false,workRequest:{kind:'html-svg'}}),/项目/);
 await assert.rejects(api.runTurn({home:f.home,cwd:repo.project,input:'make',config:{...config,piResources:{}},singleModel:true,workRequest:{kind:'html-svg'}}),/技能/);
 const catalogPath=join(f.home,'pi/models.json'),catalog=JSON.parse(readFileSync(catalogPath));catalog.providers.fixture.models[0].input=['text'];writeFileSync(catalogPath,JSON.stringify(catalog));
 await assert.rejects(api.runTurn({home:f.home,cwd:repo.project,input:'make',config,singleModel:true,workRequest:{kind:'html-svg'}}),/图像/);
 assert.equal(f.calls.length,0);
});
