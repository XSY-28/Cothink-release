import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { managed, execution } from "./helpers/agent-sync-fixture.js";

// A path-only reply, stale source image, or unblocked external request must fail these checks.
const manifest = () =>
  JSON.parse(
    readFileSync(
      new URL("../docker/visual-preview-manifest.json", import.meta.url),
    ),
  );
async function fixture(t, html, artifactPaths = []) {
  const f = await managed(t, {
    scope: ["index.html"],
    readScope: [],
    execution: { ...execution, image: manifest().image, artifactPaths },
  });
  const c = f.binding.current;
  await f.v.edit(c.changeId, {
    requestId: randomUUID(),
    expectedVersion: c.privateVersion,
    edits: [
      {
        path: "index.html",
        oldHash: null,
        contentBase64: Buffer.from(html).toString("base64"),
      },
    ],
  });
  return f;
}
async function render(f, input, options = {}, prefix = "") {
  const c = await f.v.inspect({ changeId: f.binding.current.changeId });
  const id = randomUUID();
  const r = await f.v.exec(
    c.changeId,
    {
      requestId: id,
      expectedVersion: c.privateVersion,
      command: `${prefix}node /opt/preview/visual-preview.mjs ${Buffer.from(JSON.stringify({ input, visibility: { scope: [...c.scope, ...c.readScope], artifactPaths: (await f.v.inspect()).execution.artifactPaths ?? [] } })).toString("base64")}`,
      timeoutMs: 30000,
    },
    options,
  );
  let offset = 0;
  const chunks = [];
  for (;;) {
    const p = await f.v.read({ outputRef: id, offset, limit: 1048576 });
    chunks.push(Buffer.from(p.contentBase64, "base64"));
    if (p.eof) break;
    offset = p.nextOffset;
    assert.ok(offset <= 16 * 1024 * 1024);
  }
  const output = Buffer.concat(chunks).toString();
  if (r.status === "completed") {
    assert.deepEqual(r.changedFiles, []);
    assert.deepEqual(
      await f.v.inspect({
        fromVersion: c.privateVersion,
        toVersion: r.privateVersion,
      }),
      { files: [], text: "", binaryFiles: [] },
    );
  }
  return { r, output };
}
test("offline preview renders Chinese animation at multiple times and desktop/mobile sizes without changing source", async (t) => {
  const f = await fixture(
    t,
    '<meta charset="utf-8"><h1>中文动画</h1><style>@keyframes move{to{transform:translateX(240px)}}svg{animation:move 1s linear infinite alternate}</style><svg width="100" height="100"><circle cx="50" cy="50" r="40" fill="red"/></svg>',
  );
  for (const viewport of [
    { width: 800, height: 600 },
    { width: 390, height: 844 },
  ]) {
    const { r, output } = await render(f, {
      entry: "index.html",
      viewport,
      frameTimesMs: [0, 500, 1000],
    });
    assert.equal(r.exitCode, 0, output);
    const result = JSON.parse(output);
    assert.equal(result.images.length, 3);
    const hashes = new Set();
    for (const frame of result.images) {
      const b = Buffer.from(frame.data, "base64");
      assert.equal(b.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      assert.equal(b.readUInt32BE(16), viewport.width);
      assert.equal(b.readUInt32BE(20), viewport.height);
      assert.ok(Number.isFinite(frame.capturedAtMs));
      hashes.add(frame.sha256);
    }
    assert.ok(hashes.size > 1, "animation must produce different pixels");
  }
});
test("preview reports page errors, missing resources and blocked HTTP/WebSocket; external trap receives zero requests", async (t) => {
  let hits = 0;
  const trap = createServer((q, s) => {
    hits++;
    s.end("trap");
  });
  trap.on("upgrade", () => hits++);
  await new Promise((r) => trap.listen(0, "0.0.0.0", r));
  t.after(() => new Promise((r) => trap.close(r)));
  const port = trap.address().port;
  const f = await fixture(
    t,
    `<img src="missing.png"><img src="http://host.docker.internal:${port}/image"><script>fetch('http://host.docker.internal:${port}/fetch').catch(()=>{});new WebSocket('ws://host.docker.internal:${port}/ws');setTimeout(()=>{throw Error('visible error')},10)</script>`,
  );
  const { r, output } = await render(f, {
    entry: "index.html",
    frameTimesMs: [100],
  });
  assert.equal(r.exitCode, 0, output);
  const result = JSON.parse(output);
  assert.ok(result.diagnostics.blocked.length >= 2);
  assert.ok(result.diagnostics.resourceErrors.length);
  assert.ok(
    result.diagnostics.pageErrors.some((e) => e.includes("visible error")),
  );
  assert.equal(hits, 0);
});
test("preview rejects host/URL/traversal inputs and unavailable source, never returns fake images", async (t) => {
  const f = await fixture(t, "hello");
  for (const entry of [
    "../secret.html",
    "/etc/passwd",
    "file:///etc/passwd",
    "https://example.com/",
    "ungranted.html",
  ]) {
    const { r, output } = await render(f, { entry, frameTimesMs: [0] });
    assert.notEqual(r.exitCode, 0);
    const result = JSON.parse(output);
    assert.equal(result.status, "failed");
    assert.equal(result.images, undefined);
  }
});
test("task cancellation terminates a looping page through the public executor", async (t) => {
  const f = await fixture(t, "<script>while(true){}</script>");
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 1500);
  try {
    const { r } = await render(
      f,
      { entry: "index.html" },
      { signal: abort.signal },
    );
    assert.equal(r.status, "cancelled");
    const c = await f.v.inspect({ changeId: f.binding.current.changeId });
    assert.equal(c.status, "interrupted");
  } finally {
    clearTimeout(timer);
  }
});

test("renderer rejects a real oversized PNG and cleans a dead-loop page at the fixed technical timeout", async (t) => {
  const noisy = await fixture(
    t,
    '<style>body{margin:0}</style><canvas width="1920" height="1080"></canvas><script>let c=document.querySelector("canvas").getContext("2d"),i=c.createImageData(1920,1080);for(let x=0;x<i.data.length;x+=4){i.data[x]=Math.random()*256;i.data[x+1]=Math.random()*256;i.data[x+2]=Math.random()*256;i.data[x+3]=255}c.putImageData(i,0,0)</script>',
  );
  const large = await render(noisy, {
    entry: "index.html",
    viewport: { width: 1920, height: 1080 },
    frameTimesMs: [0],
  });
  assert.notEqual(large.r.exitCode, 0);
  assert.match(JSON.parse(large.output).error, /4MiB/);
  const looping = await fixture(t, "<script>while(true){}</script>");
  const start = Date.now();
  const timed = await render(looping, { entry: "index.html" });
  assert.ok(
    timed.r.status === "cancelled" || timed.r.exitCode !== 0,
    "dead loop must fail",
  );
  assert.ok(
    Date.now() - start < 35000,
    "30-second technical bound plus cleanup",
  );
  const current = await looping.v.inspect({
    changeId: looping.binding.current.changeId,
  });
  if (timed.r.status === "completed") {
    const id = randomUUID();
    await looping.v.exec(current.changeId, {
      requestId: id,
      expectedVersion: current.privateVersion,
      command: 'ps -eo comm | grep -E "chrome|headless" || true',
      timeoutMs: 30000,
    });
    const log = await looping.v.read({ outputRef: id });
    assert.equal(
      Buffer.from(log.contentBase64, "base64").toString().trim(),
      "",
      "browser processes are cleaned after timeout",
    );
  } else assert.equal(current.status, "interrupted");
});

test("bounded click/fill/key actions change the rendered view; file URLs cannot expose outside projection", async (t) => {
  const f = await fixture(
    t,
    '<input aria-label="name"><button onclick="document.querySelector(\'h1\').textContent=document.querySelector(\'input\').value">Apply</button><h1>Before</h1><iframe src="file:///etc/passwd"></iframe>',
  );
  const before = await render(f, { entry: "index.html", frameTimesMs: [0] });
  const after = await render(f, {
    entry: "index.html",
    frameTimesMs: [0],
    actions: [
      { kind: "fill", selector: "input", value: "After" },
      { kind: "key", key: "Tab" },
      { kind: "click", selector: "button" },
    ],
  });
  assert.equal(after.r.exitCode, 0, after.output);
  const a = JSON.parse(after.output);
  assert.notEqual(
    a.images[0].sha256,
    JSON.parse(before.output).images[0].sha256,
  );
  assert.ok(
    a.diagnostics.console.some((e) => /local resource|file:/i.test(e)) ||
      a.diagnostics.blocked.some((e) => e.startsWith("file:")),
  );
  const invalid = await render(f, {
    entry: "index.html",
    actions: Array.from({ length: 7 }, () => ({ kind: "key", key: "Tab" })),
  });
  assert.notEqual(invalid.r.exitCode, 0);
});

test("auxiliary execution artifacts are not exposed as managed website resources", async (t) => {
  const f = await fixture(
    t,
    '<h1>Safe source</h1><iframe src="node_modules/private.html"></iframe>',
    ["node_modules"],
  );
  const c = await f.v.inspect({ changeId: f.binding.current.changeId });
  const prepared=await f.v.exec(c.changeId, {
    requestId: randomUUID(),
    expectedVersion: c.privateVersion,
    command:
      "mkdir -p node_modules; printf '<h1>AUXILIARY_SECRET</h1>' > node_modules/private.html",
  });
  assert.equal(prepared.status,"completed",JSON.stringify(prepared));
  const { r, output } = await render(f, {
    entry: "index.html",
    frameTimesMs: [0],
  });
  assert.equal(r.exitCode, 0, output);
  assert.ok(
    JSON.parse(output).diagnostics.resourceErrors.some((e) =>
      e.includes("node_modules/private.html"),
    ),
    "auxiliary resources must be denied",
  );
});

test("missing browser dependency is an explicit failure without fabricated images",async t=>{
 const f=await fixture(t,"<h1>Available source</h1>");
 const {r,output}=await render(f,{entry:"index.html",frameTimesMs:[0]},{},"PLAYWRIGHT_BROWSERS_PATH=/tmp/missing-browser ");
 assert.equal(r.status,"completed");assert.notEqual(r.exitCode,0);const data=JSON.parse(output);assert.equal(data.status,"failed");assert.match(data.error,/Executable doesn't exist/);assert.equal(data.images,undefined);
});
