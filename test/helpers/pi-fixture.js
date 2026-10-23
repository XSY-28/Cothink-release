import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
export async function fixture(t, handler = () => ({ text: "fixture answer" })) {
  const home = mkdtempSync(join(tmpdir(), "cothink-pi-test-"));
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const call = { body, url: req.url, headers: req.headers };
    calls.push(call);
    try {
      const reply = await handler(call, calls.length, req, res);
      if (reply === null) return;
      if (reply.error) {
        res.writeHead(reply.error, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "fixture failure", type: "fixture" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (delta, finish_reason = null, usage) =>
        res.write(
          "data: " +
            JSON.stringify({
              id: "fixture",
              object: "chat.completion.chunk",
              created: 1,
              model: body.model,
              choices: [{ index: 0, delta, finish_reason }],
              ...(usage ? { usage } : {}),
            }) +
            "\n\n",
        );
      chunk(reply.toolCalls ? {role:"assistant", tool_calls:reply.toolCalls.map((c,index)=>({index,id:c.id??`tool-${calls.length}-${index}`,type:"function",function:{name:c.name,arguments:JSON.stringify(c.args)}}))} : { role: "assistant", content: reply.text ?? "fixture answer" });
      chunk(
        {},
        reply.toolCalls ? "tool_calls" : (reply.finish ?? "stop"),
        reply.noUsage ? undefined : { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
      );
      res.end("data: [DONE]\n\n");
    } catch (error) {
      res.destroy(error);
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  mkdirSync(join(home, "pi"), { recursive: true });
  writeFileSync(
    join(home, "pi", "models.json"),
    JSON.stringify({
      providers: {
        fixture: {
          api: "openai-completions",
          baseUrl: endpoint,
          apiKey: "fixture-secret",
          models: ["main", "r1", "r2", "r3"].map((id) => ({
            id,
            name: id,
            reasoning: false,
            input: ["text"],
            cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32000,
            maxTokens: 4096,
          })),
        },
      },
    }),
  );
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    rmSync(home, { recursive: true, force: true });
  });
  return {
    home,
    cwd: home,
    calls,
    endpoint,
    models: {
      main: { provider: "fixture", modelId: "main" },
      secondary: [
        { provider: "fixture", modelId: "r1" },
        { provider: "fixture", modelId: "r2" },
        { provider: "fixture", modelId: "r3" },
      ],
    },
  };
}
