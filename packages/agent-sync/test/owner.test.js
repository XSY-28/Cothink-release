import test from "node:test";
import assert from "node:assert/strict";
import { backend, begin } from "./helpers/repository.js";
test("C10 one writer across homes; closing invalidates old authorization and interrupted draft remains", async (t) => {
  const { v, project, home } = await backend(t),
    c = await begin(v, "old");
  const { createAgentSync } = await import("../src/index.js");
  await assert.rejects(createAgentSync({ project, home: home + "-other" }), {
    code: "OWNER_BUSY",
  });
  await v.close();
  const next = await createAgentSync({ project, home });
  t.after(() => next.close());
  assert.equal(
    (await next.inspect({ changeId: c.changeId })).status,
    "interrupted",
  );
  await assert.rejects(v.prepareChange(c.changeId, { requestId: "late" }), {
    code: "OWNER_LOST",
  });
  await assert.rejects(
    next.prepareChange(c.changeId, { requestId: "old-auth" }),
    { code: "OWNER_LOST" },
  );
  const refreshed = await next.refreshChange(c.changeId, {
    requestId: "renew",
    reason: "explicit recovery",
  });
  assert.equal(refreshed.changeId, c.changeId);
});
