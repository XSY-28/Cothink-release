import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { backend, begin, replace, accept, git } from "./helpers/repository.js";
test("C10 CAS success with lost derived write is unknown then queryable, idempotent, authorization ended", async (t) => {
  let v;
  const repo = await backend(t, {
    onOperation: (e) => {
      if (e.action === "ref_updated")
        chmodSync(join(v.directory, "changes"), 0o500);
    },
  });
  v = repo.v;
  t.after(() => chmodSync(join(v.directory, "changes"), 0o700));
  const c = await begin(v, "c");
  await replace(v, c, "a.txt", "done", "edit");
  const p = await v.prepareChange(c.changeId, { requestId: "p" });
  const input = {
    changeId: c.changeId,
    candidateVersion: p.candidateVersion,
    requestId: "lost",
  };
  const r = await v.acceptChange(input);
  assert.equal(r.status, "unknown");
  chmodSync(join(v.directory, "changes"), 0o700);
  const fact = await v.inspect({ requestId: "lost" });
  assert.equal(fact.status, "accepted");
  assert.equal((await v.inspect()).version, fact.acceptedVersion);
  assert.equal(
    (await v.acceptChange(input)).acceptedVersion,
    fact.acceptedVersion,
  );
  assert.equal((await v.inspect({ changeId: c.changeId })).status, "accepted");
  const next = await begin(v, "next");
  assert.equal(next.status, "open");
});
test("C10 cancellation vs CAS is decided at boundary; external advance yields stale without overwrite", async (t) => {
  let mode = "cancel",
    v;
  const controller = new AbortController();
  const repo = await backend(t, {
    onOperation: (e) => {
      if (e.action === "before_ref_update") {
        if (mode === "cancel") controller.abort();
        else if (mode === "advance")
          git(
            repo.project,
            "update-ref",
            v.integrationRef,
            repo.baseVersion,
            e.expectedTip,
          );
      }
    },
  });
  v = repo.v;
  const c = await begin(v, "c");
  await replace(v, c, "a.txt", "new", "e");
  const p = await v.prepareChange(c.changeId, { requestId: "p" });
  const r = await v.acceptChange(
    {
      changeId: c.changeId,
      candidateVersion: p.candidateVersion,
      requestId: "cancel",
    },
    { signal: controller.signal },
  );
  assert.equal(r.status, "cancelled");
  assert.equal((await v.inspect()).version, repo.baseVersion);
  mode = "none";
  assert.equal((await accept(v, c, "actual")).status, "accepted");
  const b = await begin(v, "b");
  await replace(v, b, "a.txt", "next", "eb");
  mode = "advance";
  const stale = await accept(v, b, "cas-race");
  assert.equal(stale.status, "stale");
  assert.equal((await v.inspect()).version, repo.baseVersion);
});

test("C10 six process-death boundaries recover only authoritative facts, no second commit/check", async (t) => {
  const { repository } = await import("./helpers/repository.js");
  const { writeFileSync } = await import("node:fs");
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const { createAgentSync } = await import("../src/index.js");
  for (const boundary of [
    "prepared_receipt",
    "checks_complete",
    "before_ref_update",
    "ref_updated",
    "records_saved",
    "before_response",
  ]) {
    const repo = repository(t),
      config = join(repo.root, "crash.json");
    writeFileSync(config, JSON.stringify({ ...repo, crashAt: boundary }));
    const worker = spawn(
      process.execPath,
      [new URL("./helpers/crash-worker.js", import.meta.url).pathname, config],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let err = "";
    worker.stderr.on("data", (b) => (err += b));
    const [code, signal] = await once(worker, "exit");
    assert.equal(signal, "SIGKILL", boundary + " " + err);
    const v = await createAgentSync(repo);
    try {
      const fact = await v.inspect({ requestId: "crash-accept" }),
        after = ["ref_updated", "records_saved", "before_response"].includes(
          boundary,
        );
      assert.equal(fact.status, after ? "accepted" : "unknown", boundary);
      assert.equal(
        (await v.inspect()).version,
        after ? fact.acceptedVersion : repo.baseVersion,
      );
      const size = (await v.inspect({ history: { limit: 100 } })).versions
        .length;
      if (after) {
        const again = await v.acceptChange({
          changeId: fact.changeId,
          candidateVersion: fact.candidateVersion,
          requestId: "crash-accept",
        });
        assert.equal(again.acceptedVersion, fact.acceptedVersion);
      }
      assert.equal(
        (await v.inspect({ history: { limit: 100 } })).versions.length,
        size,
      );
    } finally {
      await v.close();
    }
  }
});

test("C05/C10 private edit I/O before request has no effect; loss after private CAS is queryable", async (t) => {
  let v,
    fail = false;
  const repo = await backend(t, {
    onOperation: (e) => {
      if (fail && e.action === "private_ref_updated")
        chmodSync(join(v.directory, "changes"), 0o500);
    },
  });
  v = repo.v;
  const c = await begin(v, "io");
  const a = await v.read({ changeId: c.changeId, path: "a.txt" }),
    input = {
      requestId: "io-edit",
      expectedVersion: c.privateVersion,
      edits: [{ path: "a.txt", oldHash: a.contentHash, contentBase64: "aW8=" }],
    };
  chmodSync(join(v.directory, "requests"), 0o500);
  try {
    await assert.rejects(v.edit(c.changeId, input));
  } finally {
    chmodSync(join(v.directory, "requests"), 0o700);
  }
  assert.equal(
    (await v.inspect({ changeId: c.changeId })).privateVersion,
    c.privateVersion,
  );
  fail = true;
  let r;
  try {
    r = await v.edit(c.changeId, input);
  } finally {
    chmodSync(join(v.directory, "changes"), 0o700);
  }
  assert.equal(r.status, "unknown");
  const { createAgentSync } = await import("../src/index.js");
  const ro = await createAgentSync({
    project: repo.project,
    home: repo.home,
    readOnly: true,
  });
  try {
    assert.equal(
      Buffer.from(
        (await ro.read({ changeId: c.changeId, path: "a.txt" })).contentBase64,
        "base64",
      ).toString(),
      "io",
    );
  } finally {
    await ro.close();
  }
  const fact = await v.inspect({ requestId: "io-edit" });
  assert.equal(fact.status, "applied");
  assert.notEqual(fact.privateVersion, c.privateVersion);
  fail = false;
  assert.equal(
    (await v.edit(c.changeId, input)).privateVersion,
    fact.privateVersion,
  );
});

test("C06/C10 refresh CAS crash recovers base and expanded scope without treating other accepted work as own delta", async (t) => {
  const { repository } = await import("./helpers/repository.js"),
    { writeFileSync } = await import("node:fs"),
    { spawn } = await import("node:child_process"),
    { once } = await import("node:events"),
    { createAgentSync } = await import("../src/index.js");
  const repo = repository(t),
    config = join(repo.root, "refresh.json");
  writeFileSync(config, JSON.stringify(repo));
  const p = spawn(
    process.execPath,
    [
      new URL("./helpers/refresh-crash-worker.js", import.meta.url).pathname,
      config,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let err = "";
  p.stderr.on("data", (b) => (err += b));
  const [, signal] = await once(p, "exit");
  assert.equal(signal, "SIGKILL", err);
  const v = await createAgentSync(repo);
  try {
    const a = await v.inspect({ requestId: "a-begin" }),
      b = await v.inspect({ requestId: "b-accept" }),
      c = await v.inspect({ changeId: a.changeId });
    assert.equal(c.baseVersion, b.acceptedVersion);
    assert.deepEqual(c.scope, ["a.txt", "c.txt"]);
    const refreshed = await v.refreshChange(c.changeId, {
      requestId: "resume-refresh",
      reason: "explicit post-crash recovery",
    });
    assert.equal(refreshed.status, "open");
    assert.equal(
      Buffer.from(
        (await v.read({ changeId: c.changeId, path: "a.txt" })).contentBase64,
        "base64",
      ).toString(),
      "ours",
    );
  } finally {
    await v.close();
  }
});

test("C10 JSON success cache alone cannot confirm acceptance after external formal-history rewrite", async (t) => {
  const { v, project, baseVersion } = await backend(t),
    c = await begin(v, "rewritten");
  await replace(v, c, "a.txt", "accepted once", "rewritten-edit");
  const accepted = await accept(v, c, "rewritten-accept");
  assert.equal(accepted.status, "accepted");
  git(
    project,
    "update-ref",
    v.integrationRef,
    baseVersion,
    accepted.acceptedVersion,
  );
  const fact = await v.inspect({ requestId: "rewritten-accept" });
  assert.equal(fact.status, "unknown");
  assert.equal(fact.acceptedVersion, undefined);
  const state = await v.inspect({ changeId: c.changeId });
  assert.equal(state.status, "outcome_unknown");
  assert.equal(state.acceptedVersion, undefined);
});
