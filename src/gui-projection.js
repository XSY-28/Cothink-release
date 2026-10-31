import { finalText } from "./presentation.js";
import { taskDisplayStatus } from "./task.js";
const clone = (value) => (value === undefined ? null : structuredClone(value));
export function taskOutputRefs(record) {
  const refs = new Set();
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (key === "outputRef" && typeof item === "string") refs.add(item);
      else if (item && typeof item === "object") visit(item);
    }
  };
  visit(record.work);
  visit(record.tools);
  visit(record.members);
  return [...refs];
}
export function publicModel(ref) {
  return ref &&
    typeof ref.provider === "string" &&
    typeof (ref.modelId ?? ref.id) === "string"
    ? {
        provider: ref.provider,
        modelId: ref.modelId ?? ref.id,
        ...(ref.thinkingLevel !== undefined
          ? { thinkingLevel: ref.thinkingLevel }
          : {}),
        ...(ref.maxOutputTokens !== undefined
          ? { maxOutputTokens: ref.maxOutputTokens }
          : {}),
      }
    : null;
}
export function publicTeam(team) {
  return team
    ? {
        id: team.id,
        name: team.name,
        main: publicModel(team.main),
        secondary: team.secondary.map(publicModel),
      }
    : null;
}
export function projectGuiTask(record, requests = [], sessionEntries = []) {
  const messages = requests.map((call) => {
    const stage = record.stages.find((s) => s.id === call.stageId);
    return {
      id: call.id,
      role: stage?.role ?? null,
      phase: stage?.phase ?? null,
      model: publicModel(
        call.actualModel ??
          call.model ??
          call.requestedModel ??
          call.modelRef ??
          stage?.modelRef,
      ),
      status: call.status,
      text: call.text ?? "",
    };
  });
  const roster = record.team
    ? [
        { id: "main", role: "main", model: publicModel(record.team.main) },
        ...record.team.secondary.map((m, i) => ({
          id: `reviewer-${i + 1}`,
          role: `reviewer-${i + 1}`,
          model: publicModel(m),
        })),
      ]
    : [
        { id: "main", role: "main", model: publicModel(record.models?.main) },
        ...(record.models?.secondary ?? []).map((m, i) => ({
          id: `reviewer-${i + 1}`,
          role: `reviewer-${i + 1}`,
          model: publicModel(m),
        })),
      ];
  const participants = roster.map((p) => {
    const calls = messages.filter((m) => m.role === p.role);
    return {
      ...p,
      status: calls.at(-1)?.status ?? "not_called",
      participated: calls.length > 0,
    };
  });
  for (const member of record.members ?? [])
    participants.push({
      id: member.memberId,
      role: "member",
      model: publicModel(member.model),
      status: member.status,
      participated: messages.some(
        (m) =>
          record.stages.find(
            (s) => s.id === requests.find((r) => r.id === m.id)?.stageId,
          )?.role ===
          "member:" + member.memberId,
      ),
    });
  const w = record.work;
  const work = w
    ? {
        helpers: (w.helpers ?? []).map(h=>({helperId:h.helperId,parentActorId:h.parentActorId,parentHelperId:h.parentHelperId??null,
          model:publicModel(h.model),status:h.status,stoppedAt:h.stoppedAt??null,text:h.text??null,
          result: h.result ? {digest:h.result.digest,files:h.result.edits.map(e=>({path:e.path,deleted:e.contentBase64===null,mode:e.mode??null}))}:null,
          treatment:clone(h.treatment),import:clone(h.import),usage:clone(h.usage),usageSource:h.usageSource,error:clone(h.error),resultError:clone(h.resultError)})),
        root: w.root ?? null,
        startVersion: w.startVersion ?? null,
        version: w.version ?? null,
        integrationRef: w.integrationRef ?? null,
        resultWorkspace: w.resultWorkspace ?? null,
        finalCheck: clone(w.finalCheck),
        visualEvidence: (w.visualEvidence ?? []).map(e => {
          const imageRequestCompleted = !!e.imageRequestId && requests.some(r => r.id === e.imageRequestId && r.status === "completed");
          const checked = imageRequestCompleted && e.review?.status === "completed" &&
            e.review.requestId === e.imageRequestId && e.reviewedRequestId === e.review.requestId &&
            e.integrationVersion === w.version && e.review.integrationVersion === w.version &&
            e.images.length > 0 && JSON.stringify(e.review.imageHashes) === JSON.stringify(e.images.map(i=>i.sha256));
          return {
            toolCallId:e.toolCallId, actor:e.actor, sourceVersion:e.sourceVersion, privateVersion:e.privateVersion, integrationVersion:e.integrationVersion??null,
            entry:e.entry, viewport:clone(e.viewport), result:e.result, error:e.error??null, diagnostics:clone(e.diagnostics), imageRequestId:e.imageRequestId,
            imageRequestCompleted, checked, semanticMatch: checked && e.review.verdict === "match", review:clone(e.review),
            images:e.images.map((i,index)=>({ref:e.outputRef,index,sha256:i.sha256,capturedAtMs:i.capturedAtMs})),
          };
        }),
        outputRefs: taskOutputRefs(record),
        members: (record.members ?? []).map((m) => ({
          id: m.memberId,
          model: publicModel(m.model),
          status: m.status,
          text:
            messages.findLast(
              (message) => message.role === "member:" + m.memberId,
            )?.text ?? "",
          readOnly: !!m.readOnly,
          assignment: m.assignment ?? m.task ?? null,
          understanding: m.understanding ?? null,
          taskConflict: clone(m.taskConflict),
          feedback: clone(m.feedback ?? []),
        })),
        activities: [
          ...projectWorkHandoffs(record, requests, sessionEntries),
          ...(w.operations ?? []).map((o) => ({
            action: o.action,
            status: o.status,
            explanation: o.explanation,
            changedFiles: clone(o.changedFiles),
          })),
        ],
        acceptance: clone(w.acceptance ?? []),
      }
    : null;
  return {
    id: record.id,
    sessionId: record.sessionId,
    createdAt: record.createdAt ?? null,
    endedAt: record.endedAt ?? null,
    input: record.input,
    status: taskDisplayStatus(record),
    phase: record.phase,
    mode: record.singleModel ? "one" : "cothink",
    singleModel: !!record.singleModel,
    team: publicTeam(record.team),
    participants,
    messages,
    usage: clone(record.usage),
    error: record.error ?? null,
    workRequest: clone(record.workRequest),
    answerSkills: clone(record.answerSkills??[]),
    work,
  };
}
export function finalGuiText(record, requests) {
  return finalText(record, requests, {localArtifacts:false});
}

/** A handoff exists only when a saved tool call and its tool result agree. */
export function projectWorkHandoffs(record, requests, sessionEntries) {
  const results = new Map(
    sessionEntries
      .filter(
        (entry) =>
          entry.type === "message" && entry.message?.role === "toolResult",
      )
      .map((entry) => [entry.message.toolCallId, entry.message]),
  );
  const activities = [];
  for (const call of requests) {
    for (const tool of call.response?.content ?? []) {
      if (tool.type !== "toolCall") continue;
      const saved = results.get(tool.id);
      // Preserve concrete executor/check failures already recorded by Pi. This is
      // a saved activity, never a synthesized model message or inferred handoff.
      if (!["delegate", "feedback", "collect"].includes(tool.name)) {
        if (saved?.isError) activities.push({
          type: "activity", action: tool.name, callId: call.id,
          toolCallId: tool.id, model: publicModel(call.actualModel ?? call.requestedModel),
          text: (saved.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n"),
          status: "failed",
        });
        continue;
      }
      let result;
      try {
        result = JSON.parse(
          saved?.content
            ?.filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n"),
        );
      } catch {
        /* Legacy incomplete logs remain activities, without an invented recipient. */
      }
      const members =
        tool.name === "collect"
          ? result?.members
          : result?.memberId
            ? [result]
            : [];
      const known = (members ?? []).filter((member) =>
        record.members?.some((m) => m.memberId === member.memberId),
      );
      if (!known.length) {
        activities.push({
          type: "activity",
          action: tool.name,
          callId: call.id,
          toolCallId: tool.id,
          model: publicModel(call.actualModel ?? call.requestedModel),
          text: JSON.stringify(tool.arguments ?? {}),
          status: saved?.isError ? "failed" : "recorded",
        });
        continue;
      }
      for (const member of known)
        activities.push({
          type: "handoff",
          action: tool.name,
          callId: call.id,
          toolCallId: tool.id,
          memberId: member.memberId,
          model: publicModel(call.actualModel ?? call.requestedModel),
          text:
            tool.name === "collect"
              ? (member.result ?? "")
              : (tool.arguments?.feedback ?? tool.arguments?.assignment ?? tool.arguments?.task ?? ""),
          status: saved.isError ? "failed" : "recorded",
          relatedCallIds:
            tool.name === "collect"
              ? requests
                  .filter(
                    (r) =>
                      r.role === "member:" + member.memberId &&
                      r.text === member.result,
                  )
                  .map((r) => r.id)
              : [],
        });
    }
  }
  return activities;
}
