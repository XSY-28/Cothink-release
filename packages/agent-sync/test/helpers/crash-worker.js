import { createAgentSync } from "../../src/index.js";
import { readFileSync } from "node:fs";
const config = JSON.parse(readFileSync(process.argv[2]));
const sync = await createAgentSync({
  ...config,
  onOperation: (e) => {
    if (
      e.action === config.crashAt &&
      (!e.requestId || e.requestId === "crash-accept")
    )
      process.kill(process.pid, "SIGKILL");
  },
});
const c = await sync.beginChange({
  requestId: "crash-begin",
  actor: "worker",
  intent: "crash evidence",
  scope: ["a.txt"],
});
const a = await sync.read({ changeId: c.changeId, path: "a.txt" });
await sync.edit(c.changeId, {
  requestId: "crash-edit",
  expectedVersion: c.privateVersion,
  edits: [
    {
      path: "a.txt",
      oldHash: a.contentHash,
      contentBase64: "Y3Jhc2gtY29udGVudA==",
    },
  ],
});
const p = await sync.prepareChange(c.changeId, { requestId: "crash-prepare" });
await sync.acceptChange({
  changeId: c.changeId,
  candidateVersion: p.candidateVersion,
  requestId: "crash-accept",
});
await sync.close();
