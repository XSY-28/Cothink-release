#!/usr/bin/env node
// C01/C08/C10: concurrent JSONL dispatch over the same deterministic API.
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { createAgentSync } from "./index.js";
const allowed = new Set([
  "beginChange",
  "read",
  "edit",
  "exec",
  "prepareChange",
  "refreshChange",
  "acceptChange",
  "inspect",
  "abandonChange",
  "checkCurrent",
]);
const controllers = new Map(),
  running = new Set();
let sync, ending;
const output = (value) => process.stdout.write(JSON.stringify(value) + "\n");
try {
  const values = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === "--read-only") {
      values.readOnly = true;
      continue;
    }
    if (!["--project", "--home", "--config"].includes(key) || !args[i + 1])
      throw Object.assign(
        new Error("Expected --project --home --config [--read-only]"),
        { code: "INPUT" },
      );
    values[key.slice(2)] = args[++i];
  }
  const config = values.config
    ? JSON.parse(readFileSync(values.config, "utf8"))
    : {};
  sync = await createAgentSync({
    project: values.project,
    home: values.home,
    readOnly: values.readOnly ?? false,
    checks: config.checks,
    execution: config.execution,
  });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  async function handle(line) {
    let req;
    try {
      req = JSON.parse(line);
      const { id, method } = req;
      if (
        typeof id !== "string" ||
        !/^[a-zA-Z0-9_-]{1,200}$/.test(id) ||
        typeof method !== "string"
      )
        throw Object.assign(new Error("Invalid JSONL id/method"), {
          code: "INPUT",
        });
      const params = req.params ?? {};
      if (method === "cancel") {
        controllers.get(params.targetId)?.abort();
        output({
          id,
          result: {
            status: controllers.has(params.targetId)
              ? "cancelled"
              : "not_found",
            targetId: params.targetId,
          },
        });
        return;
      }
      if (!allowed.has(method))
        throw Object.assign(new Error("Unknown method"), { code: "METHOD" });
      if (controllers.has(id))
        throw Object.assign(
          new Error("Request still running; query its saved requestId"),
          { code: "IN_FLIGHT" },
        );
      const controller = new AbortController();
      controllers.set(id, controller);
      const options = { signal: controller.signal, requestId: id };
      let result;
      try {
        switch (method) {
          case "read":
          case "inspect":
            result = await sync[method](params);
            break;
          case "checkCurrent":
            result = await sync.checkCurrent(options);
            break;
          case "beginChange":
          case "acceptChange":
            result = await sync[method]({ ...params, requestId: id }, options);
            break;
          case "edit":
          case "exec": {
            const { changeId, ...input } = params;
            result = await sync[method](
              changeId,
              { ...input, requestId: id },
              {
                ...options,
                onData: (b) =>
                  output({
                    id,
                    event: {
                      type: "output",
                      dataBase64: Buffer.from(b).toString("base64"),
                    },
                  }),
              },
            );
            break;
          }
          case "prepareChange": {
            const { changeId, ...input } = params;
            result = await sync.prepareChange(changeId, {
              ...input,
              ...options,
            });
            break;
          }
          case "refreshChange": {
            const { changeId, ...input } = params;
            result = await sync.refreshChange(
              changeId,
              { ...input, requestId: id },
              options,
            );
            break;
          }
          case "abandonChange":
            result = await sync.abandonChange(params.changeId, options);
            break;
        }
      } finally {
        controllers.delete(id);
      }
      output({ id, result });
    } catch (e) {
      output({
        id: req?.id ?? null,
        error: { code: e.code ?? "INPUT", message: e.message },
      });
    }
  }
  lines.on("line", (line) => {
    const p = handle(line);
    running.add(p);
    p.finally(() => running.delete(p));
  });
  async function end() {
    if (ending) return ending;
    ending = (async () => {
      for (const c of controllers.values()) c.abort();
      await sync.close();
      await Promise.allSettled([...running]);
    })();
    return ending;
  }
  lines.on("close", () => {
    end().catch((e) => {
      process.stderr.write(e.message + "\n");
      process.exitCode = 1;
    });
  });
  for (const s of ["SIGINT", "SIGTERM"])
    process.on(s, () => {
      lines.close();
    });
} catch (e) {
  process.stderr.write(
    JSON.stringify({ error: { code: e.code ?? "INPUT", message: e.message } }) +
      "\n",
  );
  process.exitCode = 1;
  await sync?.close();
}
