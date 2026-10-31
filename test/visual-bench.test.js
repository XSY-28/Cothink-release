import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareRound,
  promptFor,
  loadRound,
  extractHtml,
  createLedger,
} from "../scripts/visual-bench/core.mjs";
const config = {
  piResources:{skills:[new URL("./fixtures/visual-skill/SKILL.md",import.meta.url).pathname]},
  models: [
    {
      provider: "fixture",
      modelId: "main",
      contextWindow: 32000,
      maxTokens: 16384,
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1/v1",
      reasoning: false,
      input:["text","image"],
    },
    {
      provider: "fixture",
      modelId: "r1",
      contextWindow: 32000,
      maxTokens: 16384,
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1/v1",
      reasoning: false,
      input:["text","image"],
    },
  ],
  limits: { maxMinutes: 5, maxCalls: 20, outputTokens: 8192 },
  budgets: [
    { currency: "CNY", limit: 20, inputPerMillion: 10, outputPerMillion: 20 },
    { currency: "CNY", limit: 20, inputPerMillion: 10, outputPerMillion: 20 },
  ],
  execution: {
    engine: "docker",
    image: JSON.parse(readFileSync(new URL("../docker/visual-preview-manifest.json",import.meta.url))).image,
    network: "none",
    limits: { memoryBytes: 536870912, cpus: 1, pids: 128 },
    artifactPaths: [],
  },
};
function temp(t) {
  const p = mkdtempSync(join(tmpdir(), "visual-bench-"));
  t.after(() => rmSync(p, { recursive: true, force: true }));
  return p;
}
test("three tasks freeze nine independent attempts, exact prompts and stable blind order", async (t) => {
  const dir = temp(t);
  const r = await prepareRound({
    out: join(dir, "round"),
    tasks: ["自行车骑鹈鹕", "秦始皇骑北极熊", "北极熊骑秦始皇"],
    config,
  });
  assert.equal(r.attempts.length, 9);
  assert.equal(new Set(r.attempts.map((a) => a.id)).size, 9);
  for (const q of r.questions) {
    assert.equal(q.prompt, `做一个${q.title}的动态html界面，svg，不允许联网`);
    assert.equal(r.attempts.filter((a) => a.question === q.id).length, 3);
    assert.equal(new Set(q.order).size, 3);
  }
  assert.deepEqual(
    (await loadRound(join(dir, "round"))).questions,
    r.questions,
  );
  await assert.rejects(
    prepareRound({ out: join(dir, "round"), tasks: ["x"], config }),
    /exist|存在/,
  );
  assert.equal(
    promptFor("自行车骑鹈鹕"),
    "做一个自行车骑鹈鹕的动态html界面，svg，不允许联网",
  );
  const view = await startViewer(join(dir, "round"));
  try {
    const headers = {
      "x-visual-bench": view.token,
      "content-type": "application/json",
      origin: view.origin,
    };
    const response = await fetch(view.origin + "/api/vote", {
      method: "POST",
      headers,
      body: JSON.stringify({
        question: r.questions[0].id,
        selected: [0],
        note: "",
      }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /尚未结束/);
  } finally {
    await view.close();
  }
});
test("artifact extraction preserves animation and never silently chooses among alternatives", () => {
  const html =
    '<!doctype html><html><svg><animate attributeName="x"/></svg><script>setInterval(()=>{},20)</script></html>';
  assert.equal(extractHtml("Here\n```html\n" + html + "\n```"), html);
  assert.equal(
    extractHtml("```html\n" + html + "\n```\n```html\n" + html + "\n```"),
    null,
  );
  assert.equal(extractHtml("no artifact"), null);
});
test("concurrent reservations cannot overspend, missing usage stays held and blocks new sends", (t) => {
  const dir = temp(t),
    c = structuredClone(config);
  c.budgets[0].limit = 0.6;
  const ledger = createLedger(join(dir, "ledger.json"), c);
  const r = ledger.reserve("job", 0);
  assert.throws(() => ledger.reserve("job2", 0), /预算/);
  ledger.settle(r, { prompt_tokens: 100, completion_tokens: 10 }, true);
  const s = ledger.reserve("job2", 0);
  ledger.settle(s, null, false);
  assert.throws(() => ledger.reserve("job3", 1), /未知/);
  const saved = JSON.parse(readFileSync(join(dir, "ledger.json")));
  assert.equal(saved.requests[s].status, "unknown");
  assert.ok(saved.requests[s].reserved > 0);
  const brokenPath = join(dir, "cannot-replace-directory");
  const broken = createLedger(brokenPath, config);
  mkdirSync(brokenPath);
  assert.throws(() => broken.reserve("unsent", 0));
  assert.throws(() => broken.reserve("also-unsent", 1), /未知/);
});

import { fixture } from "./helpers/pi-fixture.js";
import { execution } from "./helpers/agent-sync-fixture.js";
import { runRound, resolveConfig } from "../scripts/visual-bench/runner.mjs";
import {
  startViewer,
  launchViewerBrowser,
  report,
  summarize,
} from "../scripts/visual-bench/viewer.mjs";
import { save } from "../scripts/visual-bench/core.mjs";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
const draw =
  '<!doctype html><html><body><svg width="200" height="160"><circle cx="50" cy="60" r="25"><animate attributeName="cx" values="50;140;50" dur="1s" repeatCount="indefinite"/></circle></svg><script>window.ticks=0;setInterval(()=>window.ticks++,20)</script></body></html>';
const tool = (name, args = {}) => ({ toolCalls: [{ name, args }] });
function toolResults(body) {
  return body.messages
    .filter((m) => m.role === "tool")
    .flatMap((m) => {
      try {
        return [JSON.parse(m.content)];
      } catch {
        return [];
      }
    });
}
test(
  "nine real SDK jobs overlap before any first response; CoThink delegates, isolated work stays offline, rerun sends nothing",
  { timeout: 180000 },
  async (t) => {
    const dir = temp(t);
    writeFileSync(join(dir, "AGENTS.md"), "PARENT_CONTEXT_SENTINEL");
    let first = 0;
    const gates = [];
    let overlap = false;
    const fixtureErrors=[];
    const f = await fixture(t, async (c) => {
      try {
      const b = c.body;
      if (b.tools?.some(t=>t.function.name==='submit_visual_review')) return tool('submit_visual_review',{verdict:'match',observation:'The fixture image is visible.',reasons:'Scripted fixture judgment, not a real-model quality claim.'});
      if (JSON.stringify(b.messages.findLast(m=>m.role==='user')).includes('Independent task preparation')) return {text:'Independently understood the original task.'};
      const n = b.messages.filter((m) => m.role === "tool").length;
      if (n === 0 && b.tools?.some(t => t.function.name === "accept_change")) {
        first++;
        if (first > 9) throw Error("unexpected restarted task");
        await new Promise((resolve) => {
          gates.push(resolve);
          if (gates.length === 9) {
            overlap = true;
            for (const release of gates)
              release();
          }
        });
      }
      const system = b.messages.find((m) => m.role === "system" || m.role === "developer")?.content ?? "";
      const user = b.messages
        .filter((m) => m.role === "user")
        .map((m) =>
          typeof m.content === "string" ? m.content : JSON.stringify(m.content),
        )
        .join("\n");
      const member = !b.tools?.some(t => t.function.name === "accept_change");
      if (member) {
        if (n === 0) return tool("read", { path: "index.html" });
        if (n === 1)
          return tool("write", { path: "index.html", content: draw });
        if (n === 2)
          return tool("bash", {
            command:
              "node -e \"if(Object.values(require('os').networkInterfaces()).flat().some(a=>!a.internal))process.exit(1);console.log('OFFLINE_OK')\"",
          });
        return { text: "drawn" };
      }
      if (user.includes("singleModel=false")) {
        if (n === 0)
          return tool("delegate", {
            model: "visual-1/r1",
            assignment: "draw dynamic HTML with inline SVG in index.html",
            implementationAdvice: "use current blank HTML",
            reason: "frontend",
            scope: ["index.html"],
          });
        if (n === 1) return tool("collect");
        if (n === 2) {
          const id = toolResults(b)
            .find((r) => r.members)
            ?.members.find((m) => m.status === "completed")?.memberId;
          if (!id) throw Error("missing completed member");
          return tool("accept_change", { memberId: id });
        }
        return { text: "delivered" };
      }
      if (n === 0) return tool("read", { path: "index.html" });
      if (n === 1) return tool("write", { path: "index.html", content: draw });
      if (n === 2) return tool("accept_change");
      return { text: "delivered" };
      } catch(e) {fixtureErrors.push(e.message);throw e;}
    });
    const catalogPath=join(f.home,'pi/models.json');
    const reasoningCatalog=JSON.parse(readFileSync(catalogPath));
    for(const model of reasoningCatalog.providers.fixture.models){model.input=["text","image"];model.reasoning=true;model.compat={supportsReasoningEffort:true,thinkingFormat:'openai'};}
    writeFileSync(catalogPath,JSON.stringify(reasoningCatalog));
    // These instructions and history must never reach any request.
    writeFileSync(join(f.home, "AGENTS.md"), "PREVIOUS_ROUND_SENTINEL");
    mkdirSync(join(f.home, "pi/sessions"), { recursive: true });
    writeFileSync(
      join(f.home, "pi/sessions/old.jsonl"),
      "PREVIOUS_ROUND_SENTINEL",
    );
    const c = await resolveConfig({
      ...config,
      sourceHome: f.home,
      models: [f.models.main, f.models.secondary[0]],
      execution:{...execution,image:config.execution.image},
      limits: { maxMinutes: null, maxCalls: null, outputTokens: null },
      budgets: config.budgets.map((b) => ({ ...b, limit: null })),
    });
    const roundDir = join(dir, "round");
    const r = await prepareRound({
      out: roundDir,
      tasks: ["自行车骑鹈鹕", "秦始皇骑北极熊", "北极熊骑秦始皇"],
      config: c,
    });
    const result = await runRound(roundDir);
    assert.equal(result.attempts, 9);
    assert.ok(overlap);
    assert.equal(first, 9);
    for (const c of f.calls) {
      assert.equal(c.body.reasoning_effort, "high");
      assert.equal(c.body.max_tokens, undefined);
      assert.equal(c.body.max_completion_tokens, undefined);
    }
    assert.ok(!JSON.stringify(f.calls).includes("PREVIOUS_ROUND_SENTINEL"));
    assert.ok(!JSON.stringify(f.calls).includes("PARENT_CONTEXT_SENTINEL"));
    const initial = f.calls.filter((c) =>
      c.body.messages.filter(m=>m.role==="tool").length===0 && c.body.tools?.some(t=>t.function.name==="accept_change"),
    );
    const mainPrompt=readFileSync(new URL('../prompts/leader.md',import.meta.url),'utf8').trim();
    for(const c of initial)assert.ok(c.body.messages.find(m=>m.role==='system'||m.role==='developer').content.includes(mainPrompt));
    assert.ok(r.config.models.every(m=>m.thinkingLevel==='high'));
    for (const q of r.questions)
      assert.equal(
        initial.filter(
          (c) =>
            ((v) =>
              typeof v === "string" ? v : v.map((p) => p.text ?? "").join(""))(
              c.body.messages.findLast((m) => m.role === "user").content,
            ).includes(q.prompt),
        ).length,
        3,
      );
    for (const a of r.attempts) {
      const s = JSON.parse(
        readFileSync(join(roundDir, "attempts", a.id, "status.json")),
      );
      assert.equal(s.status, "completed", JSON.stringify(s)+" fixtureErrors="+JSON.stringify(fixtureErrors));
      assert.equal(s.artifact, "index.html");
      assert.equal(
        readFileSync(
          join(roundDir, "attempts", a.id, "artifact/index.html"),
          "utf8",
        ),
        draw,
      );
      if (a.group === 2) assert.equal(s.members[0].status, "accepted");
      assert.equal(
        existsSync(join(roundDir, "attempts", a.id, "home/pi/models.json")),
        false,
      );
    }
    const low = structuredClone(c);
    low.budgets[0].limit = 0.1;
    await prepareRound({
      out: join(dir, "low-budget"),
      tasks: ["a", "b", "c"],
      config: low,
    });
    const before = f.calls.length;
    await assert.rejects(runRound(join(dir, "low-budget")), /预算不足/);
    assert.equal(f.calls.length, before);
    const count = f.calls.length;
    assert.equal((await runRound(roundDir)).status, "already-finished");
    assert.equal(f.calls.length, count);
  },
);

test(
  "dynamic blind viewer blocks external requests and navigation, keeps mapping private, saves and locks votes",
  { timeout: 60000 },
  async (t) => {
    const dir = temp(t),
      r = await prepareRound({ out: join(dir, "round"), tasks: ["x"], config });
    const rd = join(dir, "round");
    let network = 0;
    const trap = createServer((_req, res) => {
      network++;
      res.end("NETWORK_LEAK");
    });
    await new Promise((resolve) => trap.listen(0, "127.0.0.1", resolve));
    t.after(() => trap.close());
    const external = `http://127.0.0.1:${trap.address().port}`;
    for (const a of r.attempts) {
      const p = join(rd, "attempts", a.id, "artifact");
      mkdirSync(p, { recursive: true });
      writeFileSync(
        join(p, "index.html"),
        draw.replace(
          "</body>",
          `<script type="module" src="./local.mjs"></script><img src="${external}/image"><script>fetch('${external}/fetch').catch(()=>{});new WebSocket('ws://127.0.0.1:${trap.address().port}/ws');</script></body>`,
        ),
      );
      writeFileSync(
        join(p, "local.mjs"),
        "window.localAssetLoaded=(await (await fetch('./scene.json')).json()).ok;",
      );
      writeFileSync(join(p, "scene.json"), '{"ok":true}');
      save(join(rd, "attempts", a.id, "status.json"), {
        status: "completed",
        artifact: "index.html",
      });
    }
    writeFileSync(join(rd, "run.lock"), "fixture");
    save(join(rd, "ledger.json"), {
      requests: {},
      progress: {
        waiting: {
          phase: "waiting_retry",
          nextRetryAt: new Date(Date.now() + 60000).toISOString(),
          model: "IDENTITY_MUST_STAY_PRIVATE",
        },
      },
    });
    const view = await startViewer(rd);
    t.after(() => view.close());
    const { browser, page, context } = await launchViewerBrowser(view, {
      headless: true,
    });
    t.after(() => browser.close());
    const state = await page.evaluate(() =>
      fetch("/api/state").then((r) => r.json()),
    );
    assert.equal(state.report, undefined);
    assert.ok(!JSON.stringify(state).includes("fixture"));
    assert.ok(!JSON.stringify(state).includes("CoThink"));
    assert.equal(state.progress.waitingRequests, 1);
    assert.ok(!JSON.stringify(state).includes("IDENTITY_MUST_STAY_PRIVATE"));
    await page.getByRole("status").filter({ hasText: "服务过载" }).waitFor();
    rmSync(join(rd, "run.lock"));
    save(join(rd, "ledger.json"), { requests: {}, progress: {} });
    await page.waitForFunction(
      () => !document.querySelector("#reveal").disabled,
    );
    await page.locator("iframe").first().waitFor();
    await page.frameLocator("iframe").first().locator("svg").waitFor();
    const child = page.frames().find((f) => f.url().includes("/p/"));
    assert.ok(child);
    await child.waitForFunction(
      () => window.ticks > 2 && window.localAssetLoaded === true,
    );
    if (process.env.VISUAL_BENCH_SCREENSHOT) {
      await page.screenshot({
        path: process.env.VISUAL_BENCH_SCREENSHOT,
        fullPage: true,
      });
    }
    assert.ok((await child.evaluate(() => window.ticks)) > 2);
    await child
      .evaluate((url) => {
        location.href = url;
      }, external + "/navigation")
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(network, 0);
    await page.getByText("重播", { exact: true }).first().click();
    await page.getByText("放大", { exact: true }).first().click();
    assert.ok(await page.locator("dialog").isVisible());
    await page.getByText("关闭放大", { exact: true }).click();
    await page.getByText("完成选择，揭晓模型").click();
    await page.getByRole("status").filter({ hasText: "请先完成" }).waitFor();
    await page.getByLabel("选择 A（可多选并列）").check();
    await page.getByRole("status").filter({ hasText: "选择已保存" }).waitFor();
    await page.reload();
    assert.ok(await page.getByLabel("选择 A（可多选并列）").isChecked());
    await page.getByText("完成选择，揭晓模型").click();
    await page.getByText("A →", { exact: false }).waitFor();
    const result = await report(rd);
    assert.deepEqual(result.questions[0].choice.selected, [0]);
    assert.equal(
      (await summarize(dir)).rounds[0].scores.reduce(
        (n, s) => n + s.singleWins,
        0,
      ),
      1,
    );
    await page.getByText("导出报告", { exact: true }).click();
    await page.getByRole("status").filter({ hasText: "报告已保存" }).waitFor();
    assert.ok(existsSync(join(rd, "report.json")));
    const resp = await page.evaluate(
      (q) =>
        fetch("/api/vote", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question: q, selected: [1], note: "" }),
        }).then((r) => r.status),
      r.questions[0].id,
    );
    assert.equal(resp, 400);
  },
);

import { startRelay } from "../scripts/visual-bench/relay.mjs";
import { randomUUID } from "node:crypto";
test("real HTTP missing usage is retained, no retry or next upstream request, unauthorized model rejected", async (t) => {
  const dir = temp(t),
    f = await fixture(t, () => ({ text: "saved partial", noUsage: true }));
  const c = await resolveConfig({
    ...config,
    sourceHome: f.home,
    models: [f.models.main, f.models.secondary[0]],
  });
  const id = randomUUID(),
    relay = await startRelay({
      round: { config: c, attempts: [{ id, group: 0 }] },
      dir,
      auth: [{ apiKey: "fixture-secret" }, { apiKey: "fixture-secret" }],
    });
  t.after(() => relay.close());
  const send = (model) =>
    fetch(`${relay.origin}/${id}/0/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + relay.tokens.get(id),
      },
      body: JSON.stringify({
        model,
        stream: true,
        messages: [{ role: "user", content: "x" }],
      }),
    });
  assert.equal((await send("r1")).status, 400);
  assert.equal(f.calls.length, 0);
  const first = await send("main");
  assert.equal(first.status, 200);
  assert.match(await first.text(), /saved partial/);
  assert.equal((await send("main")).status, 400);
  assert.equal(f.calls.length, 1);
  assert.equal(Object.values(relay.ledger.state.requests)[0].status, "unknown");
});

test("explicit unlimited settings admit concurrent jobs without local money, call or output caps", (t) => {
  const dir = temp(t),
    c = structuredClone(config);
  c.limits = { maxMinutes: null, maxCalls: null, outputTokens: null };
  c.budgets.forEach((b) => (b.limit = null));
  const ledger = createLedger(join(dir, "unlimited.json"), c);
  ledger.preflight(Array.from({ length: 9 }, () => ({ group: 2 })));
  for (let n = 0; n < 30; n++) {
    const id = ledger.reserve("one-attempt", 1);
    ledger.settle(id, { prompt_tokens: 100, completion_tokens: 20000 }, true);
  }
  assert.equal(Object.values(ledger.state.requests).length, 30);
  assert.ok(
    Object.values(ledger.state.requests).every(
      (r) => r.status === "settled" && r.reserved === null,
    ),
  );
});

test("permanent HTTP rejection retains its body and affects only its attempt in unlimited mode", async (t) => {
  const dir = temp(t),
    f = await fixture(t, (call, _n, _req, res) => {
      if (call.body.model === "main") {
        res.writeHead(401, {
          "content-type": "application/json",
          "retry-after": "7",
          "x-ratelimit-limit": "3",
        });
        res.end(
          JSON.stringify({
            error: {
              message: "invalid credentials fixture-secret",
              code: "authentication_error",
            },
          }),
        );
        return null;
      }
      return { text: "healthy task completes" };
    });
  const c = await resolveConfig({
    ...config,
    sourceHome: f.home,
    models: [f.models.main, f.models.secondary[0]],
    limits: { maxMinutes: null, maxCalls: null, outputTokens: null },
    budgets: config.budgets.map((b) => ({ ...b, limit: null })),
  });
  const ids = [randomUUID(), randomUUID()];
  const relay = await startRelay({
    round: { config: c, attempts: ids.map((id, group) => ({ id, group })) },
    dir,
    auth: [{ apiKey: "fixture-secret" }, { apiKey: "fixture-secret" }],
  });
  t.after(() => relay.close());
  const send = (slot) =>
    fetch(`${relay.origin}/${ids[slot]}/${slot}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + relay.tokens.get(ids[slot]),
      },
      body: JSON.stringify({
        model: slot ? "r1" : "main",
        stream: true,
        messages: [{ role: "user", content: "x" }],
      }),
    });
  const bad = await send(0);
  assert.equal(bad.status, 401);
  const body = await bad.text();
  assert.match(body, /invalid credentials/);
  assert.ok(!body.includes("fixture-secret"));
  assert.equal(bad.headers.get("retry-after"), "7");
  const good = await send(1);
  assert.equal(good.status, 200);
  assert.match(await good.text(), /healthy task completes/);
  assert.equal((await send(0)).status, 400);
  assert.equal(f.calls.length, 2);
  const row = Object.values(relay.ledger.state.requests).find(
    (r) => r.slot === 0,
  );
  assert.equal(row.httpStatus, 401);
  assert.equal(row.cost, null);
  assert.equal(row.responseHeaders["x-ratelimit-limit"], "3");
});

import { capturedOutcome } from '../scripts/visual-bench/viewer.mjs';
import { hash } from '../scripts/visual-bench/core.mjs';
test('review copies expose saved HTML without rewriting partial outcomes or revealing identities',async t=>{
 const dir=temp(t),rd=join(dir,'round');const r=await prepareRound({out:rd,tasks:['x'],config});const id=r.attempts[0].id,root=join(rd,'attempts',id);
 mkdirSync(join(root,'artifact'),{recursive:true});save(join(root,'status.json'),{status:'partial',error:'original failure'});const before=readFileSync(join(root,'status.json'));
 writeFileSync(join(root,'artifact/index.html'),draw);save(join(root,'artifact-capture.json'),{artifact:'index.html',artifactSource:'last-materialized-draft',originalStatusSha256:hash(before),files:{'index.html':hash(draw)}});
 assert.equal(capturedOutcome(rd,id).status,'partial');assert.equal(capturedOutcome(rd,id).artifact,'index.html');assert.deepEqual(readFileSync(join(root,'status.json')),before);
 const view=await startViewer(rd);try{const data=await(await fetch(view.origin+'/api/state',{headers:{'x-visual-bench':view.token}})).json();assert.deepEqual(data.presentation,{available:1,partial:1,missing:2});assert.equal(data.report,undefined);assert.ok(!JSON.stringify(data).includes('fixture'));}finally{await view.close();}
 writeFileSync(join(root,'artifact/index.html'),'changed');assert.throws(()=>capturedOutcome(rd,id),/校验失败/);assert.deepEqual(readFileSync(join(root,'status.json')),before);
});


test("closing the viewer page closes its dedicated browser instead of leaving a windowless app", async (t) => {
  const dir=temp(t),rd=join(dir,'round');
  await prepareRound({out:rd,tasks:['close test'],config});
  const view=await startViewer(rd);
  t.after(()=>view.close());
  const {browser,page}=await launchViewerBrowser(view,{headless:true});
  t.after(()=>browser.close());
  const disconnected=new Promise(resolve=>browser.once('disconnected',()=>resolve(true)));
  await page.close();
  let timer;
  try {
    assert.equal(await Promise.race([disconnected,new Promise(resolve=>{timer=setTimeout(()=>resolve(false),1500);})]),true,'closing the only viewer must release the owned browser');
  } finally {clearTimeout(timer);}
});

test("resizing the viewer window keeps the last question and rejection button reachable", async (t) => {
  const dir=temp(t), rd=join(dir,'round');
  const round=await prepareRound({out:rd,tasks:['first','second','last'],config});
  for(const a of round.attempts)save(join(rd,'attempts',a.id,'status.json'),{status:'failed'});
  const view=await startViewer(rd);t.after(()=>view.close());
  const {browser,page,context}=await launchViewerBrowser(view,{headless:process.env.VISUAL_SCROLL_HEADED !== '1'});t.after(()=>browser.close());
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.getByRole('heading',{name:'last',exact:true}).waitFor();
  const cdp=await context.newCDPSession(page);
  const {windowId}=await cdp.send('Browser.getWindowForTarget');
  for(const size of [{width:1600,height:1000},{width:900,height:650},{width:700,height:450}]){
    await cdp.send('Browser.setWindowBounds',{windowId,bounds:{...size,windowState:'normal'}});
    await page.waitForFunction(({width,height})=>innerWidth<=width&&innerHeight<height,{...size},{timeout:2000});
    // Scroll the outer document, as a person does in its margin; do not use an
    // element locator that would hide a broken viewport by auto-scrolling it.
    await page.evaluate(()=>{
      scrollTo(0,0);
      window.viewerScrollEnded=false;
      addEventListener('scrollend',()=>{window.viewerScrollEnded=true;},{once:true});
    });
    const viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
    await page.mouse.move(4,Math.floor(viewport.height/2));
    await page.mouse.wheel(0,20000);
    await page.waitForFunction(()=>window.viewerScrollEnded,undefined,{timeout:2000});
    const button=page.locator('section.question').last().getByRole('button',{name:'都不合格',exact:true});
    await page.waitForFunction(()=>{
      const button=document.querySelector('section.question:last-child .feedback button');
      const r=button.getBoundingClientRect();
      return r.top>=0&&r.bottom<=innerHeight;
    },undefined,{timeout:2000});
    const bounds=await button.boundingBox();
    assert.ok(bounds.y+bounds.height<size.height,'last button must be inside the physical window');
    await button.click();
    await page.getByRole('status').filter({hasText:'选择已保存'}).waitFor();
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const evidence=await page.evaluate(()=>{
      const b=document.querySelector('section.question:last-child .feedback button').getBoundingClientRect();
      return {width:innerWidth,height:innerHeight,scrollY,scrollHeight:document.documentElement.scrollHeight,button:{top:b.top,bottom:b.bottom},visualHeight:visualViewport.height};
    });
    assert.ok(evidence.button.top>=0&&evidence.button.bottom<=evidence.height);
    if(process.env.VISUAL_SCROLL_SCREENSHOTS){
      writeFileSync(join(process.env.VISUAL_SCROLL_SCREENSHOTS,`window-${size.width}x${size.height}.json`),JSON.stringify(evidence,null,2));
      await page.evaluate(()=>scrollTo(0,0));
      await page.screenshot({path:join(process.env.VISUAL_SCROLL_SCREENSHOTS,`page-${size.width}x${size.height}.png`),fullPage:true,scale:'css'});
    }
  }
  assert.deepEqual(errors,[]);
});
