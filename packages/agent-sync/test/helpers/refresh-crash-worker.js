import { createAgentSync } from "../../src/index.js";
import { readFileSync } from "node:fs";
const v = await createAgentSync({
  ...JSON.parse(readFileSync(process.argv[2])),
  onOperation: (e) => {
    if (e.action === "refresh_ref_updated")
      process.kill(process.pid, "SIGKILL");
  },
});
async function begin(id, path) {
  return v.beginChange({
    requestId: id + "-begin",
    actor: id,
    intent: "refresh crash fixture",
    scope: [path],
  });
}
async function edit(c, path, data, id) {
  const old = await v.read({ changeId: c.changeId, path });
  return v.edit(c.changeId, {
    requestId: id,
    expectedVersion: c.privateVersion,
    edits: [
      {
        path,
        oldHash: old.contentHash,
        contentBase64: Buffer.from(data).toString("base64"),
      },
    ],
  });
}
const a = await begin("a", "a.txt");
await edit(a, "a.txt", "ours", "a-edit");
const b = await begin("b", "b.txt");
await edit(b, "b.txt", "theirs", "b-edit");
const p = await v.prepareChange(b.changeId, { requestId: "b-prepare" });
await v.acceptChange({
  requestId: "b-accept",
  changeId: b.changeId,
  candidateVersion: p.candidateVersion,
});
await v.refreshChange(a.changeId, {
  requestId: "refresh-crash",
  scope: ["a.txt", "c.txt"],
  reason: "expand after independent acceptance",
});
await v.close();
