import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./helpers/pi-fixture.js";
import { repository } from "./helpers/git-fixture.js";
import { execution } from "./helpers/agent-sync-fixture.js";
import { runTurn } from "../src/discussion.js";
import { parsePreviewOutput } from "../src/visual-preview.js";
const tool = (name, args = {}) => ({ toolCalls: [{ name, args }] });
function setup(f) {
  const file = join(f.home, "pi", "models.json"),
    catalog = JSON.parse(readFileSync(file));
  for (const m of catalog.providers.fixture.models) m.input = ["text", "image"];
  writeFileSync(file, JSON.stringify(catalog));
  const skill = join(f.home, "frontend.md");
  writeFileSync(
    skill,
    "---\nname: frontend-design\ndescription: HTML SVG composition\n---\nCheck subjects and motion.",
  );
  return {
    formatVersion: 2,
    ...f.models,
    piResources: { skills: [skill] },
    work: {
      checks: [],
      execution: {
        ...execution,
        image: JSON.parse(
          readFileSync(
            new URL("../docker/visual-preview-manifest.json", import.meta.url),
          ),
        ).image,
      },
    },
  };
}
function images(body) {
  const result = [];
  function visit(v) {
    if (!v || typeof v !== "object") return;
    if (v.type === "image_url") result.push(v.image_url.url);
    for (const x of Object.values(v)) if (typeof x === "object") visit(x);
  }
  visit(body);
  return result;
}
const html = (color) =>
  `<meta charset="utf-8"><h1>作品</h1><svg width="200" height="100"><rect width="200" height="100" fill="${color}"/></svg>`;
test("ONE writes red, receives real PNG, revises blue, accepts, then receives final integrated PNG before completion", async (t) => {
  const seen = [];
  const f = await fixture(t, (call, n) => {
    if (n === 1)
      return tool("write", { path: "index.html", content: html("red") });
    if (n === 2)
      return tool("preview_html", { entry: "index.html", frameTimesMs: [0] });
    if (n === 3) {
      seen.push(images(call.body).at(-1));
      assert.ok(seen[0]?.startsWith("data:image/png;base64,"));
      return tool("write", { path: "index.html", content: html("blue") });
    }
    if (n === 4)
      return tool("preview_html", { entry: "index.html", frameTimesMs: [0] });
    if (n === 5) {
      seen.push(images(call.body).at(-1));
      assert.notEqual(seen[0], seen[1]);
      return tool("accept_change");
    }
    if (n === 6) return { text: "Ready for final visual check" };
    assert.equal(n, 7, "must not repeatedly prompt without new evidence");
    assert.ok(images(call.body).length);
    assert.match(JSON.stringify(call.body), /integrationVersion/);
    return tool("submit_visual_review", {verdict:"match",observation:"A blue rectangle is visible.",reasons:"Matches the requested color and shape."});
  });
  const repo = repository(t);
  const task = await runTurn({
    home: f.home,
    cwd: repo.project,
    config: setup(f),
    input: "Make a blue rectangle",
    singleModel: true,
    workRequest: { kind: "html-svg" },
  });
  assert.equal(task.record.status, "completed", task.record.error);
  assert.equal(f.calls.length, 7);
  assert.ok(f.calls.every((c) => c.body.model === "main"));
  assert.equal(task.record.members.length, 0);
  const ev = task.record.work.visualEvidence;
  assert.equal(ev.length, 3);
  assert.ok(ev.every((e) => e.imageRequestId && e.contentUnchanged));
  assert.notEqual(ev[0].images[0].sha256, ev[1].images[0].sha256);
  assert.equal(ev[2].integrationVersion, task.record.work.version);
  assert.ok(ev[2].reviewedRequestId);
  assert.match(
    readFileSync(join(task.record.work.resultWorkspace, "index.html"), "utf8"),
    /blue/,
  );
});
test("invalid and oversized preview output never becomes a successful image result", () => {
  const input = {
    entry: "index.html",
    viewport: { width: 10, height: 10 },
    frameTimesMs: [0],
  };
  for (const output of [
    "no JSON",
    JSON.stringify({ protocol: 1, status: "failed", error: "missing browser" }),
    " ".repeat(16 * 1024 * 1024 + 1),
    JSON.stringify({
      protocol: 1,
      status: "captured",
      entry: "index.html",
      viewport: input.viewport,
      images: [{ data: "bad" }],
    }),
  ])
    assert.throws(() => parsePreviewOutput(output, input));
});

test("CoThink member receives pixels and original task/skill, leader gives concrete feedback and checks final integration", async (t) => {
  let mainN = 0,
    workerN = 0,
    memberId;
  const f = await fixture(t, (call) => {
    if (call.body.model === "r1") {
      if (JSON.stringify(call.body.messages.findLast(m=>m.role==='user')).includes('Independent task preparation')) {
        assert.ok(!JSON.stringify(call.body.messages).includes('Make the blue rectangle'));
        return {text:'原题要求蓝色矩形，自行车骑鹈鹕，不能交换主客体。'};
      }
      workerN++;
      assert.ok(!call.body.tools.some(t=>["delegate","next_change","refresh_change","prepare_change","accept_change"].includes(t.function.name)));
      assert.match(JSON.stringify(call.body.messages), /自行车骑鹈鹕/);
      assert.match(JSON.stringify(call.body.messages), /blue rectangle/);
      assert.match(
        JSON.stringify(call.body.messages),
        /Check subjects and motion/,
      );
      if (workerN === 1)
        return tool("write", { path: "index.html", content: html("red") });
      if (workerN === 2)
        return tool("preview_html", { entry: "index.html", frameTimesMs: [0] });
      if (workerN === 3) {
        assert.ok(images(call.body).length);
        return { text: "Red draft ready for feedback" };
      }
      if (workerN === 4) {
        assert.match(JSON.stringify(call.body), /red violates blue/);
        return tool("write", { path: "index.html", content: html("blue") });
      }
      if (workerN === 5)
        return tool("preview_html", { entry: "index.html", frameTimesMs: [0] });
      assert.equal(workerN, 6);
      assert.ok(images(call.body).length >= 2);
      return { text: "Revised blue candidate" };
    }
    mainN++;
    if (mainN === 1) {
      writeFileSync(
        join(f.home, "frontend.md"),
        "---\nname: changed\ndescription: Changed after submission\n---\nMUTATED_SKILL_MUST_NOT_ENTER",
      );
      return tool("delegate", {
        model: "fixture/r1",
        assignment: "Make the blue rectangle",
        implementationAdvice:
          "Original requirement: blue rectangle; actual HTML file and screenshots",
        reason:
          "This member handles the frontend implementation while I review the goal.",
        scope: ["index.html"],
      });
    }
    if (mainN === 2) {
      const msg = call.body.messages.findLast((m) => m.role === "tool");
      memberId = JSON.parse(msg.content).memberId;
      return tool("collect", { memberIds: [memberId] });
    }
    if (mainN === 3) {
      const collected = JSON.parse(call.body.messages.findLast(m=>m.role==='tool').content).members[0];
      assert.ok(collected.capabilities.registeredTools.includes('preview_html'));
      assert.equal(collected.preview.successful,1);
      assert.equal(collected.preview.evidence[0].imageRequestCompleted,true);
      return tool("feedback", {
        memberId,
        feedback:
          "The red violates blue in the original task; change the rectangle to blue and preview again.",
      });
    }
    if (mainN === 4) return tool("collect", { memberIds: [memberId] });
    if (mainN === 5) return tool("accept_change", { memberId });
    if (mainN === 6)
      return { text: "Candidate integrated; ready for final check" };
    assert.equal(mainN, 7);
    assert.ok(images(call.body).length);
    return tool("submit_visual_review", {verdict:"match",observation:"A blue rectangle.",reasons:"Blue in the requested viewport."});
  });
  const repo = repository(t);
  const task = await runTurn({
    home: f.home,
    cwd: repo.project,
    config: setup(f),
    input: "Make a blue rectangle; 保留自行车骑鹈鹕的原题关系，不交换主客体。",
    workRequest: { kind: "html-svg" },
  });
  assert.equal(task.record.status, "completed", task.record.error);
  assert.equal(workerN, 6);
  assert.equal(mainN, 7);
  assert.equal(task.record.members[0].status, "accepted");
  assert.ok(
    !JSON.stringify(f.calls).match(
      /MUTATED_SKILL_MUST_NOT_ENTER|Changed after submission/,
    ),
  );
  assert.ok(
    task.record.work.visualEvidence.some(
      (e) => e.actor.startsWith("member:") && e.imageRequestId,
    ),
  );
  assert.ok(
    task.record.work.visualEvidence.some(
      (e) =>
        e.actor === "main" &&
        e.integrationVersion === task.record.work.version &&
        e.reviewedRequestId,
    ),
  );
});
test("accepted files survive final render errors and cannot be reported completed", async (t) => {
  const f = await fixture(t, (_, n) =>
    n === 1
      ? tool("write", {
          path: "index.html",
          content: '<h1>Kept</h1><script>throw Error("unresolved")</script>',
        })
      : n === 2
        ? tool("accept_change")
        : _.body.tools?.some(x=>x.function.name==='submit_visual_review')
        ? tool('submit_visual_review',{verdict:'match',observation:'Kept heading',reasons:'Visible heading'})
        : { text: "Claimed complete" },
  );
  const repo = repository(t);
  const task = await runTurn({
    home: f.home,
    cwd: repo.project,
    config: setup(f),
    input: "Make HTML",
    singleModel: true,
    workRequest: { kind: "html-svg" },
  });
  assert.equal(task.record.status, "partial");
  assert.match(task.record.error, /Visual review remains unresolved/);
  assert.ok(task.record.work.acceptance.some((a) => a.status === "accepted"));
  assert.equal(task.record.work.resultWorkspace, undefined);
});
test("a final visual mismatch sends concrete feedback and a new version needs a new independent image request", async (t) => {
  const f = await fixture(t, (c, n) => {
    if (n === 1) return tool("write", { path: "index.html", content: html("red") });
    if (n === 2) return tool("accept_change");
    if (n === 3) return { text: "First finish intent" };
    if (n === 4) return tool('submit_visual_review',{verdict:'mismatch',observation:'Red rectangle',reasons:'The original task requires blue, but the screenshot is red.'});
    if (n === 5) {
      assert.match(JSON.stringify(c.body),/original task requires blue/);
      return tool("next_change", {reason: "The actual screenshot shows red instead of required blue",scope: ["index.html"]});
    }
    if (n === 6) return tool("read", { path: "index.html" });
    if (n === 7) return tool("write", { path: "index.html", content: html("blue") });
    if (n === 8) return tool("accept_change");
    if (n === 9) return { text: "Revised finish intent" };
    assert.equal(n, 10);
    assert.ok(!JSON.stringify(c.body).includes('Red rectangle'));
    return tool('submit_visual_review',{verdict:'match',observation:'Blue rectangle',reasons:'The current screenshot matches blue.'});
  });
  const repo = repository(t);
  const task = await runTurn({home: f.home,cwd: repo.project,config: setup(f),input: "Make a blue rectangle",singleModel: true,workRequest: { kind: "html-svg" }});
  assert.equal(task.record.status, "completed", task.record.error);
  const ev = task.record.work.visualEvidence;
  assert.equal(ev.length, 2);
  assert.notEqual(ev[0].integrationVersion, ev[1].integrationVersion);
  assert.notEqual(ev[0].images[0].sha256, ev[1].images[0].sha256);
  assert.equal(ev[0].review.verdict,'mismatch');
  assert.equal(ev[1].review.verdict,'match');
  assert.equal(ev[1].integrationVersion, task.record.work.version);
  assert.ok(ev[1].reviewedRequestId);
});

test("provider rejection of the final PNG preserves accepted work without retries or text-only fallback", async (t) => {
  const f = await fixture(t, (_, n) =>
    n === 1
      ? tool("write", { path: "index.html", content: html("blue") })
      : n === 2
        ? tool("accept_change")
        : n === 3
          ? { text: "Ready" }
          : { error: 400 },
  );
  const repo = repository(t);
  const task = await runTurn({
    home: f.home,
    cwd: repo.project,
    config: setup(f),
    input: "Make blue",
    singleModel: true,
    workRequest: { kind: "html-svg" },
  });
  assert.equal(task.record.status, "partial");
  assert.equal(f.calls.length, 4);
  assert.ok(images(f.calls[3].body).length);
  assert.ok(task.record.work.acceptance.some((r) => r.status === "accepted"));
  assert.equal(task.record.work.resultWorkspace, undefined);
  assert.equal(task.record.work.visualEvidence[0].reviewedRequestId, undefined);
});
test("natural start_work HTML contract joins the same final-image loop without adding a classifier", async (t) => {
  const f = await fixture(t, (_, n) =>
    n === 1
      ? tool("start_work", {
          reason: "make the HTML file",
          scope: ["index.html"],
          deliverableKind: "html-svg",
        })
      : n === 2
        ? tool("write", { path: "index.html", content: html("blue") })
        : n === 3
          ? tool("accept_change")
          : n === 4 ? { text: "Visual final" }
            : tool('submit_visual_review',{verdict:'match',observation:'Blue rectangle',reasons:'The screenshot matches blue.'}),
  );
  const repo = repository(t);
  const task = await runTurn({
    home: f.home,
    cwd: repo.project,
    config: setup(f),
    input: "Make blue",
    singleModel: true,
  });
  assert.equal(task.record.status, "completed", task.record.error);
  assert.equal(f.calls.length, 5);
  assert.deepEqual(task.record.workRequest, { kind: "html-svg" });
  assert.ok(task.record.work.visualEvidence[0].reviewedRequestId);
});
test("textual image claims and file paths are not provider image payload evidence", async () => {
  const { payloadImageHashes } = await import("../src/visual-preview.js");
  assert.equal(
    payloadImageHashes({
      messages: [
        { role: "user", content: "I saw /tmp/image.png and iVBORw0KGgo=" },
      ],
    }).size,
    0,
  );
  assert.equal(
    payloadImageHashes({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "data:image/png;base64,iVBORw0KGgo=" },
          ],
        },
      ],
    }).size,
    0,
  );
});

for (const verdict of ['match','mismatch','uncertain','missing','503']) {
  test(`isolated fidelity review: ${verdict} controls delivery while retaining accepted files`, async t => {
    const original='蓝色矩形；自行车骑鹈鹕，不能交换主客体。';
    let mainN=0, reviews=0;
    const f=await fixture(t,c=>{
      if(c.body.tools?.some(x=>x.function.name==='submit_visual_review')) {
        reviews++;
        assert.deepEqual(c.body.tools.map(x=>x.function.name),['submit_visual_review']);
        assert.ok(c.body.tools.every(x=>!/[\u4e00-\u9fff]/.test(x.function.description)));
        mkdirSync('work/task-fidelity/requests',{recursive:true});
        writeFileSync('work/task-fidelity/requests/visual-'+verdict+'.json',JSON.stringify(c.body,null,2));
        const payload=JSON.stringify(c.body.messages);
        assert.ok(payload.includes(original));
        assert.ok(!payload.includes('错误委派哨兵'));
        assert.ok(!payload.includes('已经通过哨兵'));
        assert.ok(images(c.body).some(x=>x.startsWith('data:image/png;base64,')));
        assert.match(c.body.messages.find(x=>x.role==='system').content,/user.*language/is);
        if(verdict==='503')return {error:503};
        if(verdict==='missing')return {text:'存在视野缺口，需要更多画面。'};
        return tool('submit_visual_review',{verdict,observation:'看到蓝色矩形，但没有骑乘主体。',reasons:'按原题核对；裁切区域无法确认。',integrationVersion:'MODEL_FORGED_VERSION',imageHashes:['MODEL_FORGED_HASH'],model:{modelId:'MODEL_FORGED_ID'}});
      }
      mainN++;
      if(mainN===1)return tool('write',{path:'index.html',content:html('blue')});
      if(mainN===2)return tool('accept_change');
      if(mainN===3)return {text:'错误委派哨兵 已经通过哨兵'};
      assert.equal(mainN,4,'no repeated feedback without new evidence');
      assert.match(JSON.stringify(c.body),/裁切区域|视野缺口/);
      return {text:'保留已有作品，未解决审查问题。'};
    });
    const repo=repository(t);
    const task=await runTurn({home:f.home,cwd:repo.project,config:setup(f),input:original,singleModel:true,workRequest:{kind:'html-svg'}});
    assert.equal(reviews,1);
    assert.equal(task.record.status,verdict==='match'?'completed':'partial',task.record.error);
    assert.ok(f.calls.every(c=>c.body.model==='main'));
    assert.equal(task.record.members.length,0);
    const ev=task.record.work.visualEvidence.find(e=>e.review);
    assert.equal(ev.review.verdict,['missing','503'].includes(verdict)?'uncertain':verdict);
    assert.equal(ev.review.integrationVersion,ev.integrationVersion);
    assert.deepEqual(ev.review.imageHashes,ev.images.map(i=>i.sha256));
    assert.equal(ev.review.model.modelId,'main');
    const calls=task.requests().filter(r=>r.sent);
    for(let i=1;i<calls.length;i++)assert.ok(calls[i].createdAt>=calls[i-1].endedAt,'ONE reviewer and leader must run sequentially');
    if(verdict==='503')assert.notEqual(ev.review.status,'completed');
    else { assert.equal(ev.review.status,'completed');assert.ok(ev.imageRequestId); }
    assert.ok(task.record.work.acceptance.some(a=>a.status==='accepted'));
    const accepted=task.record.work.changes.find(c=>c.status==='accepted');
    assert.match(readFileSync(join(accepted.workspace,'index.html'),'utf8'),/blue/);
  });
}

test('collect reports real preview capability but a failed image request is not a completed inspection',async t=>{
  let mainN=0,workerN=0,memberId,summary;
  const f=await fixture(t,c=>{
    if(c.body.model==='r1'){
      workerN++;
      if(workerN===1)return {text:'原题要求蓝色矩形。'};
      if(workerN===2)return tool('write',{path:'index.html',content:html('blue')});
      if(workerN===3)return tool('preview_html',{entry:'index.html',frameTimesMs:[0]});
      assert.ok(images(c.body).length);
      return {error:503};
    }
    mainN++;
    if(mainN===1)return tool('delegate',{model:'fixture/r1',assignment:'制作蓝色矩形',reason:'bounded',scope:['index.html']});
    if(mainN===2){memberId=JSON.parse(c.body.messages.findLast(m=>m.role==='tool').content).memberId;return tool('collect',{memberId});}
    if(mainN===3){summary=JSON.parse(c.body.messages.findLast(m=>m.role==='tool').content).members[0];return tool('abandon_member',{memberId,reason:'Retain failed image request and draft'});}
    return {text:'保留草稿，图像请求失败。'};
  });
  const repo=repository(t);
  const task=await runTurn({home:f.home,cwd:repo.project,config:setup(f),input:'制作蓝色矩形',workRequest:{kind:'html-svg'}});
  assert.ok(summary.capabilities.registeredTools.includes('preview_html'));
  assert.equal(summary.preview.successful,1);
  assert.ok(summary.preview.evidence[0].imageRequestId);
  assert.equal(summary.preview.evidence[0].imageRequestCompleted,false);
  assert.notEqual(task.record.status,'completed');
  assert.equal(workerN,4,'503 is not replayed');
});

test('uncertain cropped evidence can be supplemented at a new viewport without changing accepted source',async t=>{
  let n=0;
  const f=await fixture(t,c=>{
    n++;
    if(n===1)return tool('write',{path:'index.html',content:html('blue')});
    if(n===2)return tool('accept_change');
    if(n===3)return {text:'Ready'};
    if(n===4)return tool('submit_visual_review',{verdict:'uncertain',observation:'A blue rectangle',reasons:'Need a narrow viewport to check cropping.'});
    if(n===5)return tool('next_change',{reason:'Capture missing narrow view',scope:['index.html']});
    if(n===6)return tool('preview_html',{entry:'index.html',viewport:{width:375,height:667},frameTimesMs:[0]});
    if(n===7)return {text:'Additional narrow screenshot captured'};
    assert.equal(n,8);
    assert.match(JSON.stringify(c.body),/375/);
    return tool('submit_visual_review',{verdict:'match',observation:'Blue rectangle fits narrow viewport',reasons:'Additional view addresses the missing evidence.'});
  });
  const repo=repository(t);
  const task=await runTurn({home:f.home,cwd:repo.project,config:setup(f),input:'Make blue HTML usable in narrow view',singleModel:true,workRequest:{kind:'html-svg'}});
  assert.equal(task.record.status,'completed',task.record.error);
  assert.equal(task.record.work.acceptance.length,1);
  const reviews=task.record.work.visualEvidence.filter(e=>e.review);
  assert.equal(reviews.length,2);
  assert.equal(reviews[0].integrationVersion,reviews[1].integrationVersion);
  assert.notEqual(reviews[0].images[0].sha256,reviews[1].images[0].sha256);
  assert.equal(reviews[1].viewport.width,375);
});
