import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fixture } from "./helpers/pi-fixture.js";
import {
  startRelay,
  classifyTransient,
  retryDelay,
  waitForRetry,
} from "../scripts/visual-bench/relay.mjs";
const until = async (f) => {
  const end = Date.now() + 5000;
  while (!f()) {
    assert.ok(Date.now() < end, "condition did not become true");
    await new Promise((r) => setTimeout(r, 5));
  }
};
async function setup(t, handler, retryWait, workRequest) {
  const dir = mkdtempSync(join(tmpdir(), "visual-retry-"));
  const f = await fixture(t, handler);
  const ids = [randomUUID(), randomUUID()];
  const config = {
    models: [
      {
        modelId: "main",
        contextWindow: 32000,
        maxTokens: 8192,
        baseUrl: f.endpoint,
      },
      {
        modelId: "r1",
        contextWindow: 32000,
        maxTokens: 8192,
        baseUrl: f.endpoint,
      },
    ],
    limits: { maxMinutes: null, maxCalls: null, outputTokens: null },
    budgets: [0, 1].map(() => ({
      currency: "CNY",
      limit: null,
      inputPerMillion: 1,
      outputPerMillion: 1,
    })),
  };
  const relay = await startRelay({
    round: { config, ...(workRequest ? {workRequest} : {}), attempts: ids.map((id, group) => ({ id, group })) },
    dir,
    auth: [{ apiKey: "fixture-secret" }, { apiKey: "fixture-secret" }],
    retryWait,
  });
  t.after(async () => {
    await relay.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const send = (slot, signal) =>
    fetch(`${relay.origin}/${ids[slot]}/${slot}/v1/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        authorization: "Bearer " + relay.tokens.get(ids[slot]),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: slot ? "r1" : "main",
        stream: true,
        messages: [{ role: "user", content: "same prompt" }],
      }),
    });
  return { f, relay, send, ids };
}
function reject(res, status, error, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify({ error }));
  return null;
}
test("retry classification is conservative and Retry-After is a minimum", () => {
  assert.equal(
    classifyTransient(
      429,
      JSON.stringify({
        error: { type: "engine_overloaded_error", message: "overloaded" },
      }),
    ),
    "overloaded",
  );
  assert.equal(
    classifyTransient(
      429,
      JSON.stringify({
        error: { code: "rate_limit", message: "rate limit exceeded" },
      }),
    ),
    "rate_limited",
  );
  assert.equal(
    classifyTransient(
      503,
      JSON.stringify({ error: { message: "Service temporarily unavailable" } }),
    ),
    "unavailable",
  );
  for (const [status, body] of [
    [401, { error: { message: "try later" } }],
    [429, { error: { type: "insufficient_quota", message: "quota exceeded" } }],
    [503, { error: { message: "unknown" } }],
    [
      503,
      {
        error: { type: "service_unavailable" },
        choices: [{ delta: { content: "partial" } }],
      },
    ],
    [
      429,
      {
        error: { type: "engine_overloaded_error" },
        usage: { completion_tokens: 2 },
      },
    ],
  ])
    assert.equal(classifyTransient(status, JSON.stringify(body)), null);
  assert.equal(
    classifyTransient(503, "<html>Service Unavailable</html>"),
    null,
  );
  assert.equal(
    retryDelay({ "retry-after": "7" }, 0, 0, () => 0),
    7000,
  );
  assert.equal(
    retryDelay(
      { "retry-after": "Thu, 01 Jan 1970 00:00:20 GMT" },
      0,
      10000,
      () => 0,
    ),
    10000,
  );
  assert.deepEqual(
    [0, 1, 2, 3, 20].map((i) => retryDelay({}, i, 0, () => 0)),
    [20000, 40000, 80000, 120000, 120000],
  );
  assert.ok(retryDelay({ "retry-after": "7" }, 0, 0, () => 0.9) >= 7000);
});
test("429 then 503 retry the exact payload; an independent task completes while waiting", async (t) => {
  let main = 0,
    release;
  const waits = [];
  const s = await setup(
    t,
    (c, _n, _req, res) => {
      if (c.body.model === "r1") return { text: "independent done" };
      main++;
      if (main === 1)
        return reject(
          res,
          429,
          { type: "engine_overloaded_error", message: "busy fixture-secret" },
          { "retry-after": "7", "msh-request-id": "request-one" },
        );
      if (main === 2)
        return reject(res, 503, {
          type: "service_unavailable",
          message: "temporarily unavailable",
        });
      return { text: "single final result" };
    },
    async (ms, signal) => {
      waits.push(ms);
      if (waits.length === 1)
        await new Promise((r, j) => {
          release = r;
          signal.addEventListener("abort", () => j(signal.reason), {
            once: true,
          });
        });
    },
  );
  const pending = s.send(0).then((r) => r.text());
  await until(() => !!release);
  const good = await s.send(1);
  assert.match(await good.text(), /independent done/);
  assert.equal(main, 1);
  release();
  assert.match(await pending, /single final result/);
  assert.equal(main, 3);
  assert.ok(waits[0] >= 7000 && waits[0] < 12000);
  assert.ok(waits[1] >= 40000);
  const rows = Object.values(s.relay.ledger.state.requests).filter(
    (r) => r.slot === 0,
  );
  assert.equal(new Set(rows.map((r) => r.logicalId)).size, 1);
  assert.equal(new Set(rows.map((r) => r.payloadSha256)).size, 1);
  assert.deepEqual(
    rows.map((r) => r.retryNumber),
    [0, 1, 2],
  );
  assert.equal(rows[0].responseHeaders["msh-request-id"], "request-one");
  assert.ok(!rows[0].responseBody.includes("fixture-secret"));
  assert.ok(rows.slice(0, 2).every((r) => r.waitEndedAt && r.cost === null));
  assert.equal(rows[2].status, "settled");
  const bodies = s.f.calls
    .filter((c) => c.body.model === "main")
    .map((c) => c.body);
  assert.deepEqual(bodies[0], bodies[1]);
  assert.deepEqual(bodies[1], bodies[2]);
});
test("cancelling a real backoff wait stops without another upstream request", async (t) => {
  const s = await setup(t, (_c, _n, _req, res) =>
    reject(
      res,
      429,
      { type: "engine_overloaded_error", message: "busy" },
      { "retry-after": "120" },
    ),
  );
  const controller = new AbortController();
  const pending = s
    .send(0, controller.signal)
    .then((r) => r.text())
    .catch((e) => e);
  await until(() =>
    Object.values(s.relay.ledger.state.progress).some(
      (p) => p.phase === "waiting_retry",
    ),
  );
  controller.abort();
  await pending;
  await until(() =>
    Object.values(s.relay.ledger.state.progress).some(
      (p) => p.phase === "cancelled",
    ),
  );
  assert.equal(s.f.calls.length, 1);
  assert.equal(Object.values(s.relay.ledger.state.requests)[0].transport.abort.source, "downstream_close");
  assert.equal(
    Object.values(s.relay.ledger.state.requests)[0].waitOutcome,
    "cancelled",
  );
});
test("partial stream and connection loss are preserved as unknown and never retried", async (t) => {
  const s = await setup(t, (_c, _n, _req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      "data: " +
        JSON.stringify({
          choices: [{ delta: { content: "partial output" } }],
        }) +
        "\n\n",
    );
    setTimeout(() => res.destroy(), 30);
    return null;
  });
  const response = await s.send(0);
  let partial = "";
  try {
    for await (const b of response.body) partial += Buffer.from(b).toString();
  } catch {}
  assert.match(partial, /partial output/);
  await until(() =>
    Object.values(s.relay.ledger.state.requests).some(
      (r) => r.status === "unknown",
    ),
  );
  const trace = Object.values(s.relay.ledger.state.requests)[0].transport;
  assert.equal(trace.httpStatus, 200);
  assert.ok(trace.bodyBytes > 0 && trace.firstBodyAt && trace.lastBodyAt);
  assert.equal(trace.bodyComplete, false);
  assert.equal(trace.phase, "reading_upstream");
  assert.equal(trace.error.cause.code, "UND_ERR_SOCKET");
  assert.equal(trace.abort, undefined, "relay teardown must not be misreported as caller cancellation");
  assert.equal(s.f.calls.length, 1);
  assert.equal((await s.send(0)).status, 400);
  assert.equal(s.f.calls.length, 1);
});
test("a successful stream carrying an error is not retried or counted as settled", async (t) => {
  const s = await setup(t, (_c, _n, _req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      "data: " +
        JSON.stringify({
          error: { type: "engine_overloaded_error" },
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }) +
        "\n\ndata: [DONE]\n\n",
    );
    return null;
  });
  await (await s.send(0)).text();
  assert.equal(s.f.calls.length, 1);
  const row = Object.values(s.relay.ledger.state.requests)[0];
  assert.equal(row.status, "unknown");
  assert.equal(row.transport.firstSseError.error.type, "engine_overloaded_error");
  assert.ok(row.transport.doneSentinelAt);
  assert.equal(row.transport.terminal, false);
});

import { retryWaitDuration } from "../scripts/visual-bench/viewer.mjs";
test("overlapping member retry waits are not double-counted as elapsed time", () => {
  const time = (n) => new Date(n).toISOString();
  const rows = [
    [10, 50],
    [30, 80],
    [90, 120],
  ].map(([a, b]) => ({ waitStartedAt: time(a), waitEndedAt: time(b) }));
  assert.equal(retryWaitDuration(rows, time(0), time(100)), 80);
  assert.equal(retryWaitDuration(rows, undefined, undefined), null);
});


import OpenAI from "openai";
test("SDK completion with fragmented DONE before HTTP EOF permits the next logical request", async (t) => {
  const s = await setup(t, (_c, _n, _req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: ' + JSON.stringify({id:'complete', object:'chat.completion.chunk', choices:[{index:0, delta:{content:'complete answer',tool_calls:[{index:0,id:'call-read',type:'function',function:{name:'read',arguments:'{\"path\":\"index.html\"}'}}]}, finish_reason:'tool_calls'}], usage:{prompt_tokens:10,completion_tokens:2}}) + '\r\n\r\ndata: [DO');
    setImmediate(() => res.write('NE]\r\n\r\n'));
    // Keep HTTP open: application completion must not depend on EOF.
    return null;
  });
  const client = new OpenAI({apiKey:s.relay.tokens.get(s.ids[0]),baseURL:`${s.relay.origin}/${s.ids[0]}/0/v1`,maxRetries:0});
  for (let i=0;i<2;i++) {
    let text='', tool;
    for await (const chunk of await client.chat.completions.create({model:'main',stream:true,messages:[{role:'user',content:'next logical step'}]})) {
      text += chunk.choices?.[0]?.delta?.content ?? '';
      tool ??= chunk.choices?.[0]?.delta?.tool_calls?.[0];
    }
    assert.equal(text,'complete answer');
    assert.equal(tool.function.name,'read');
    assert.deepEqual(JSON.parse(tool.function.arguments),{path:'index.html'});
    await until(() => Object.values(s.relay.ledger.state.requests).every(r=>r.status!=='reserved'));
    assert.ok(Object.values(s.relay.ledger.state.requests).every(r=>r.status==='settled'),'complete response must not block the next tool/model step');
  }
  assert.equal(s.f.calls.length,2);
  assert.ok(Object.values(s.relay.ledger.state.requests).every(r=>!r.transport.abort));
});

test("an incomplete DONE event followed by connection loss is unknown and never resent", async (t) => {
  const s = await setup(t, (_c, _n, _req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: '+JSON.stringify({choices:[{delta:{content:'partial'}}],usage:{prompt_tokens:10,completion_tokens:2}})+'\n\ndata: [DONE]\n');
    setTimeout(()=>res.destroy(),30);
    return null;
  });
  const response=await s.send(0);
  try { await response.text(); } catch {}
  await until(()=>Object.values(s.relay.ledger.state.requests)[0]?.status==='unknown');
  assert.equal((await s.send(0)).status,400);
  assert.equal(s.f.calls.length,1);
});


test("HTTP EOF without a complete DONE event does not authorize another request", async (t) => {
  for (const suffix of ['', 'data: [DONE]\n']) {
    const s = await setup(t, (_c, _n, _req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: '+JSON.stringify({choices:[{delta:{content:'saved output'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:2}})+'\n\n'+suffix);
      return null;
    });
    assert.match(await (await s.send(0)).text(), /saved output/);
    assert.equal(Object.values(s.relay.ledger.state.requests)[0].status,'unknown');
    assert.equal((await s.send(0)).status,400);
    assert.equal(s.f.calls.length,1);
  }
});

test("cancelling before DONE preserves partial output and never resends it", async (t) => {
  const s = await setup(t, (_c, _n, _req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: '+JSON.stringify({choices:[{delta:{content:'partial output'}}]})+'\n\n');
    return null;
  });
  const response=await s.send(0),reader=response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value),/partial output/);
  await reader.cancel();reader.releaseLock();
  await until(()=>Object.values(s.relay.ledger.state.requests)[0]?.status==='unknown');
  assert.equal((await s.send(0)).status,400);
  assert.equal(s.f.calls.length,1);
});

test("new HTML production rounds retain a transient rejection without automatic retry",async t=>{
 let waits=0;
 const {f,send}=await setup(t,(_call,_n,_req,res)=>reject(res,503,{type:"engine_overloaded_error",message:"overloaded"}),async()=>{waits++;},{kind:"html-svg"});
 const response=await send(0);assert.equal(response.status,503);await response.text();assert.equal(f.calls.length,1);assert.equal(waits,0);
});
