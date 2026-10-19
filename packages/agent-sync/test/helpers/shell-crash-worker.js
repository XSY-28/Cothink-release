import { readFileSync } from "node:fs";
import { createAgentSync } from "../../src/index.js";
const config = JSON.parse(readFileSync(process.argv[2]));
const v = await createAgentSync(config),
  c = await v.beginChange({
    requestId: "host-begin",
    actor: "worker",
    intent: "host death",
    scope: ["a.txt"],
  });
process.send({ changeId: c.changeId });
await v.exec(
  c.changeId,
  {
    requestId: "host-command",
    expectedVersion: c.privateVersion,
    command: "echo command-started; sleep 1000",
  },
  { onData: () => process.send({ started: true }) },
);
await v.close();
