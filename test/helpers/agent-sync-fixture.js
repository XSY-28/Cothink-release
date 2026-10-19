import { after } from "node:test";
import { readFileSync, rmSync } from "node:fs";
import { repository } from "./git-fixture.js";
import { createVersioning } from "../../src/versioning.js";
import { createTask } from "../../src/task.js";
import { workspaceTools } from "../../src/workspaces.js";
export const execution = JSON.parse(
  readFileSync(
    new URL(
      "../../packages/agent-sync/execution-manifest.json",
      import.meta.url,
    ),
  ),
).execution;
const resources = [];
after(async () => {
  for (const { v, root } of resources) {
    await v.close();
    rmSync(root, { recursive: true, force: true });
  }
});
export async function managed(
  t,
  {
    scope = ["a.txt", "new.txt"],
    readScope = ["."],
    readOnly = false,
    ...options
  } = {},
) {
  const repo = repository(t, { cleanup: false }),
    v = await createVersioning({ ...repo, ...options });
  resources.push({ v, root: repo.root });
  const task = createTask({
    home: repo.home,
    input: "actual managed tools",
    models: { main: {}, secondary: [] },
  });
  task.record.mode = "work";
  task.record.maxCalls = null;
  const stage = task.beginPhase("work", "main", {}),
    binding = {
      current: await v.beginChange({
        requestId: "begin",
        actor: "main",
        intent: "tools",
        scope: readOnly ? [] : scope,
        readScope,
        readOnly,
      }),
      observations: new Map(),
      reads: new Map(),
    };
  const definitions = workspaceTools({
    task,
    stage,
    versioning: v,
    getChange: () => binding.current,
    binding,
    readOnly,
    onChanged: (c) => Object.assign(binding.current, c),
  });
  const call = (name, id, args, signal = task.signal) =>
    definitions.find((d) => d.name === name).execute(id, args, signal);
  return { ...repo, v, task, stage, binding, definitions, call };
}
