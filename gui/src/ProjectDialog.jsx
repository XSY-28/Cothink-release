import React, { useState } from "react";
import { Modal } from "./Modal.jsx";
export function ProjectDialog({
  api,
  projects,
  suggestedProject,
  onOpen,
  onClose,
  active,
}) {
  const [path, setPath] = useState(suggestedProject || ""),
    [result, setResult] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function inspect(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setResult(null);
    try {
      setResult(await api.action("project.inspect", { path }));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="打开项目" onClose={onClose}>
      <form onSubmit={inspect}>
        <p>输入宿主上的 Git 项目路径。先只读检查，再为这个项目新建关联对话。</p>
        <label>
          项目绝对路径
          <input
            autoComplete="off"
            required
            value={path}
            onChange={(e) => {
              setPath(e.target.value);
              setResult(null);
            }}
            placeholder="/Users/you/projects/example"
            list="recent-projects"
          />
        </label>
        <datalist id="recent-projects">
          {projects.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
        <div className="form-actions">
          <button disabled={busy}>只读检查项目</button>
        </div>
      </form>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {result && (
        <div className="project-inspection">
          <h3>{result.valid ? "项目检查结果" : "无法关联项目"}</h3>
          <dl className="facts">
            <dt>目录</dt>
            <dd>{result.path}</dd>
            <dt>Git HEAD</dt>
            <dd>{result.head || "未读取"}</dd>
            <dt>实际正式起点</dt>
            <dd>{result.version || "未读取"}</dd>
            <dt>工作区</dt>
            <dd>
              {result.dirty === null
                ? "未知"
                : result.dirty
                  ? "存在未提交修改"
                  : "干净"}
            </dd>
          </dl>
          {result.dirty && (
            <p className="inset-note">
              未提交内容不会自动进入工作起点，也不会被覆盖。请自行决定是否在现有
              Git 工具中保存。
            </p>
          )}
          <h4>提交前解析的检查</h4>
          <pre>{JSON.stringify(result.checks, null, 2)}</pre>
          <p className="field-note">
            {result.checks?.length
              ? "非空检查需要可用的固定 Docker 环境。"
              : "空检查策略：结果将标为未验证。"}
          </p>
          <h4>执行环境</h4>
          <pre>
            {JSON.stringify(
              result.execution ?? "尚未配置；Shell 与非空正式检查将被阻止",
              null,
              2,
            )}
          </pre>
          {result.error && <p className="error-text">{result.error}</p>}
          {active && (
            <p className="field-note">
              当前还有活跃任务。可先查看，结束后再从新对话提交。
            </p>
          )}
          <div className="form-actions">
            <button
              className="primary"
              disabled={!result.valid || busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onOpen(result.path);
                  onClose();
                } catch (e) {
                  setError(e.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              为此项目新建对话
            </button>
          </div>
          <p className="field-note">
            原项目未写回。后续任务沿用内核实际授予的正式版本，不会静默改换已有对话的目录。
          </p>
        </div>
      )}
    </Modal>
  );
}
