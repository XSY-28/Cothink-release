import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { backend, repository, git, begin } from "./helpers/repository.js";
test("C01/C02 reopen same formal ref; explicit ref preserves original history", async (t) => {
  const { v, home, project, baseVersion } = await backend(t);
  const ref = v.integrationRef;
  await v.close();
  const { createAgentSync } = await import("../src/index.js");
  const again = await createAgentSync({ project, home });
  t.after(() => again.close());
  assert.equal((await again.inspect()).version, baseVersion);
  assert.equal(again.integrationRef, ref);
  const repo = repository(t);
  git(repo.project, "update-ref", "refs/heads/existing", repo.baseVersion);
  const adopted = await createAgentSync({
    ...repo,
    integrationRef: "refs/heads/existing",
  });
  t.after(() => adopted.close());
  assert.equal(adopted.integrationRef, "refs/heads/existing");
  assert.equal((await adopted.inspect()).version, repo.baseVersion);
});
test("C10 read-only queries do not write files or metadata; only inspect/read permitted", async (t) => {
  const { v, project, home } = await backend(t);
  const version = (await v.inspect()).version;
  await v.close();
  const snapshot = (p) => {
    const s = statSync(p);
    return s.isDirectory()
      ? Object.fromEntries(readdirSync(p).map((n) => [n, snapshot(join(p, n))]))
      : {
          data: readFileSync(p).toString("base64"),
          mtime: s.mtimeMs,
          mode: s.mode,
        };
  };
  const before = snapshot(home),
    { createAgentSync } = await import("../src/index.js"),
    ro = await createAgentSync({ project, home, readOnly: true });
  await ro.inspect();
  await ro.inspect({ history: { limit: 1 } });
  await ro.read({ version, path: "a.txt" });
  await assert.rejects(begin(ro, "no-write"), { code: "READ_ONLY" });
  await ro.close();
  assert.deepEqual(snapshot(home), before);
});
test("C01 invalid constructor has no data-root side effects and NOT_GIT is explicit", async (t) => {
  const repo = repository(t),
    { createAgentSync } = await import("../src/index.js");
  await assert.rejects(createAgentSync({ ...repo, checks: [{ command: 4 }] }), {
    code: "CHECK_POLICY",
  });
  assert.deepEqual(readdirSync(repo.home), []);
  await assert.rejects(
    createAgentSync({ project: repo.home, home: join(repo.root, "absent") }),
    { code: "NOT_GIT" },
  );
});
