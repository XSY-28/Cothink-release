import { randomUUID } from "node:crypto";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { redact } from "./storage.js";
import { problem } from "./task.js";
const optionalApis = new Set([
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "google-generative-ai",
]);
const textOf = (m) =>
  m?.content
    ?.filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n") ?? "";
export { textOf };
export function createRequestPolicy({ getBinding, getSecrets = () => [] }) {
  return {
    stream(model, context, options, send) {
      const output = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        const binding = getBinding();
        let call, task, stage;
        const failure = (error) => ({
          role: "assistant",
          api: model.api,
          model: model.id,
          provider: model.provider,
          content: [],
          stopReason: "error",
          errorMessage: error.message,
          timestamp: Date.now(),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        });
        try {
          if (!binding)
            throw problem("UNMANAGED_REQUEST", "模型请求没有绑定 CoThink 任务；已阻止发送。");
          ({ task, stage } = binding);
          if (task.record.status !== "running")
            throw problem("TASK_ENDED", "任务已结束，拒绝新的模型请求。");
          binding.assertOwned?.();
          if (task.ioError) throw task.ioError;
          if (task.signal.aborted) throw task.signal.reason;
          const secrets = await getSecrets(model);
          const clean = (v) => redact(v, secrets);
          call = {
            id: randomUUID(),
            taskId: task.record.id,
            stageId: stage.id,
            displayId: randomUUID(),
            phase: stage.phase,
            role: stage.role,
            requestedModel: stage.modelRef,
            actualModel: {
              provider: model.provider,
              modelId: model.id,
              api: model.api,
              baseUrl: model.baseUrl,
            },
            status: "preparing",
            sent: false,
            createdAt: new Date().toISOString(),
            context: clean(context),
            events: [],
            usage: null,
            estimatedCost: null,
            _secrets: secrets,
          };
          task.register(call);
          stage.callIds.push(call.id);
          task.writeRequest(call);
          task.save();
          const signal = options?.signal
            ? AbortSignal.any([options.signal, task.signal])
            : task.signal;
          let usageSeen = false;
          const opts = {
            ...options,
            signal,
            maxTokens:
              binding.maxOutputTokens ?? binding.modelRef?.maxOutputTokens ?? options?.maxTokens,
            fetch: async (url, init) => {
              if (signal.aborted) throw signal.reason;
              const response = await (options?.fetch ?? globalThis.fetch)(url, init);
              call.httpStatus = response.status;
              if (!response.ok) call.rawErrorBody = clean(await response.clone().text());
              task.writeRequest(call);
              return response;
            },
            timeoutMs: binding.timeout ?? 0,
            maxRetries: 0,
            onPayload: async (payload, actual) => {
              if (signal.aborted) throw signal.reason;
              if (binding.error) throw binding.error;
              binding.assertOwned?.();
              if (task.ioError) throw task.ioError;
              const body = (await options?.onPayload?.(payload, actual)) ?? payload;
              if (binding.error) throw binding.error;
              binding.assertOwned?.();
              if (task.ioError) throw task.ioError;
              if (!body || typeof body !== "object")
                throw problem("INVALID_PAYLOAD", "服务请求格式无效");
              const outputCap = binding.maxOutputTokens ?? binding.modelRef?.maxOutputTokens;
              if (outputCap != null) {
                for (const key of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
                  if (key in body) body[key] = outputCap;
                }
                if (body.generationConfig) body.generationConfig.maxOutputTokens = outputCap;
              } else if (optionalApis.has(actual.api)) {
                delete body.max_tokens;
                delete body.max_completion_tokens;
                delete body.max_output_tokens;
                if (body.generationConfig) delete body.generationConfig.maxOutputTokens;
              } else
                throw problem(
                  "REQUIRED_OUTPUT_LIMIT",
                  `${actual.api} 协议要求输出额度，请在模型配置中明确 maxOutputTokens。`,
                );
              if (signal.aborted) throw signal.reason;
              if (task.record.maxCalls !== null && task.usage().calls >= task.record.maxCalls)
                throw problem("CALL_BUDGET", "实际请求数超过本条预算");
              call.actualModel = {
                provider: actual.provider,
                modelId: actual.id,
                api: actual.api,
                baseUrl: actual.baseUrl,
              };
              call.payload = clean(body);
              call.limits = {
                maxOutputTokens:
                  binding.maxOutputTokens ?? binding.modelRef?.maxOutputTokens ?? null,
                timeoutMs: binding.timeout ?? null,
                retries: 0,
              };
              call.status = "in_flight";
              call.sent = true;
              task.writeRequest(call);
              task.save();
              return body;
            },
            onResponse: async (response) => {
              call.httpStatus = response.status;
              task.writeRequest(call);
              await options?.onResponse?.(response);
            },
            onProviderStreamEvent: async (data, actual) => {
              const raw = clean(data);
              call.events.push(raw);
              if (
                data?.usage ||
                data?.message?.usage ||
                data?.response?.usage ||
                data?.choices?.[0]?.usage ||
                data?.usageMetadata
              )
                usageSeen = true;
              task.writeRequest(call);
              await options?.onProviderStreamEvent?.(data, actual);
            },
          };
          const source = await send(model, context, opts);
          for await (const originalEvent of source) {
            const event = clean(originalEvent);
            const message = event.message ?? event.partial ?? event.error;
            if (message && typeof message === "object") {
              message.cothinkMessageId = call.displayId;
              message.cothinkTaskId = task.record.id;
              message.cothinkPhase = stage.phase;
              if (message.content) message.content = clean(message.content);
              if (message.errorMessage) message.errorMessage = clean(message.errorMessage);
            }
            if (event.type === "done" || event.type === "error") {
              call.response = clean(message);
              call.text = textOf(message);
              call.usage = usageSeen ? message.usage : null;
              call.usageSource = usageSeen ? "provider_stream" : null;
              call.estimatedCost =
                usageSeen &&
                Object.values(model.cost ?? {}).some(
                  (value) => typeof value === "number" && value > 0,
                ) &&
                typeof message.usage?.cost?.total === "number"
                  ? message.usage.cost.total
                  : null;
              call.status = signal.aborted
                ? call.sent
                  ? "outcome_unknown"
                  : "not_sent"
                : message.stopReason === "length"
                  ? "partial"
                  : message.stopReason === "error"
                    ? call.httpStatus
                      ? "failed"
                      : call.sent
                        ? "outcome_unknown"
                        : "failed"
                    : message.stopReason === "aborted"
                      ? call.sent
                        ? "outcome_unknown"
                        : "not_sent"
                      : message.stopReason === "stop" || message.stopReason === "toolUse"
                        ? "completed"
                        : "partial";
              if (
                call.status === "completed" &&
                !call.text.trim() &&
                !message.content?.some((c) => c.type === "toolCall")
              )
                call.status = "failed";
              call.endedAt = new Date().toISOString();
              task.writeRequest(call);
              task.save();
            }
            output.push(event);
          }
          output.end();
        } catch (error) {
          if (binding) binding.error = error;
          if (call) {
            call.error = redact(error.message, call._secrets);
            call.status = call.sent ? "outcome_unknown" : "failed";
            try {
              task.writeRequest(call);
            } catch {
              /* memory remains available to host recovery */
            }
          }
          output.push({ type: "error", reason: "error", error: failure(error) });
          output.end();
        }
      });
      return output;
    },
  };
}
