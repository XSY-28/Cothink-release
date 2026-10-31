import React, { useRef } from "react";
import { shouldSubmit, modelName } from "./view.js";
const h = React.createElement;
export function Composer({
  session,
  boot,
  draft,
  onDraft,
  onSubmit,
  onChange,
  busy,
  submitting,
  pending,
  onSettings,
}) {
  const composing = useRef(false),
    team = session?.team;
  const model = boot.models.find(
    (m) =>
      m.provider === team?.main.provider && m.modelId === team?.main.modelId,
  );
  const levels = model?.thinkingLevels || [];
  const disabled = !session || session.readOnly || !!session.selectionError;
  const blocks =
    disabled || busy || submitting || pending || !team || !draft.trim();
  return h(
    "form",
    {
      className: "composer",
      onKeyDown: (e) => {
        if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey &&
            (e.code === "KeyM" || (!e.code && e.key.toLowerCase() === "m")) &&
            !composing.current && !e.nativeEvent?.isComposing && e.keyCode !== 229) {
          e.preventDefault();
          if (!e.repeat && !disabled && !submitting && !pending)
            onChange("session.mode", { mode: session.mode === "one" ? "cothink" : "one" });
        }
      },
      onSubmit: (e) => {
        e.preventDefault();
        if (!blocks) onSubmit();
      },
    },
    session?.selectionError &&
      h(
        "p",
        { className: "error-text", role: "alert" },
        session.selectionError,
      ),
    !team &&
      h(
        "p",
        { className: "composer-notice" },
        "选择具名 Team 后开始。历史阵容缺失时，需要明确绑定。 ",
        h("button", { type: "button", onClick: onSettings }, "配置模型"),
      ),
    session?.readOnly && !session?.selectionError &&
      h(
        "p",
        { className: "composer-notice" },
        "此会话被其他入口占用，当前只读。",
      ),
    h("label", { className: "sr-only", htmlFor: "message-input" }, "输入问题"),
    h("textarea", {
      id: "message-input",
      placeholder: busy
        ? "任务进行中，可以继续写草稿……"
        : "输入问题，或描述项目中要完成的工作……",
      value: draft,
      disabled,
      onChange: (e) => onDraft(e.target.value),
      onCompositionStart: () => {
        composing.current = true;
      },
      onCompositionEnd: () => {
        composing.current = false;
      },
      onKeyDown: (e) => {
        if (
          shouldSubmit({
            ...e,
            keyCode: e.keyCode,
            isComposing: composing.current || e.nativeEvent?.isComposing,
          })
        ) {
          e.preventDefault();
          if (!blocks) onSubmit();
        }
      },
      rows: 3,
    }),
    h(
      "div",
      { className: "composer-options" },
      h(
        "label",
        { className: "control-label" },
        busy ? "下一条模式 · ⌥M" : "模式 · ⌥M",
        h(
          "select",
          {
            "aria-label": "对话模式",
            "aria-keyshortcuts": "Alt+M",
            title: "Option+M / Alt+M 切换模式（输入区内）",
            value: session?.mode || "cothink",
            disabled,
            onChange: (e) => onChange("session.mode", { mode: e.target.value }),
          },
          h("option", { value: "cothink" }, "CoThink"),
          h("option", { value: "one" }, "ONE"),
        ),
      ),
      h(
        "label",
        { className: "control-label" },
        "Team",
        h(
          "select",
          {
            "aria-label": "下一条 Team",
            value: team?.id || "",
            disabled: disabled || busy,
            onChange: (e) =>
              onChange("session.team", { teamId: e.target.value }),
          },
          h("option", { value: "", disabled: true }, "选择 Team"),
          team &&
            !boot.teams.some((t) => t.id === team.id) &&
            h("option", { value: team.id }, `${team.name}（历史快照）`),
          ...boot.teams.map((t) =>
            h("option", { key: t.id, value: t.id }, t.name),
          ),
        ),
      ),
      h(
        "label",
        { className: "control-label" },
        busy ? "下一条思考" : "思考",
        h(
          "select",
          {
            "aria-label": "思考档位",
            disabled: disabled || !levels.length,
            value: session?.thinking ?? team?.main?.thinkingLevel ?? "",
            onChange: (e) =>
              onChange("session.thinking", { level: e.target.value }),
          },
          h(
            "option",
            { value: "", disabled: true },
            model?.reasoning ? "默认 high" : levels.length ? "默认（不启用思考）" : "此模型不可用",
          ),
          ...levels.map((level) =>
            h("option", { key: level, value: level }, level),
          ),
        ),
      ),
      h(
        "button",
        {
          type: "button",
          className: "text-button",
          onClick: onSettings,
          title: team ? modelName(team.main) : "模型设置",
        },
        "配置…",
      ),
    ),
    h(
      "div",
      { className: "composer-footer" },
      h(
        "span",
        null,
        `纯答 ${session?.mode === "one" ? "1" : "3"} 次 · 工作不设调用次数上限`,
        h(
          "small",
          null,
          busy
            ? "当前任务使用提交时的模式和阵容；草稿不会排队。"
            : "Enter 发送 · Shift+Enter 换行 · 不自动重试",
        ),
      ),
      h("button", {type:"button",disabled:blocks,onClick:()=>onSubmit({kind:"html-svg"}),title:"仅本条制作；继承当前ONE/CoThink模式，需要关联项目"}, "制作HTML/SVG"),
      h(
        "button",
        { type: "submit", className: "primary send", disabled: blocks },
        submitting
          ? "确认提交…"
          : pending
            ? "待确认"
            : busy
              ? "草稿保留"
              : "发送",
        h("span", { "aria-hidden": true }, " ↑"),
      ),
    ),
  );
}
