import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { Window } from "happy-dom";
import { Composer } from "../gui/src/Composer.js";
import { build } from "vite";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const bundleDirectory = resolve("work/gui/component-build");
const previousNodeEnv = process.env.NODE_ENV;
await build({
  configFile: false,
  logLevel: "silent",
  build: {
    lib: {
      entry: resolve("test/helpers/gui-components.jsx"),
      formats: ["es"],
      fileName: "components",
    },
    outDir: bundleDirectory,
    emptyOutDir: true,
    minify: false,
    rolldownOptions: { external: ["react", "react/jsx-runtime"] },
  },
});
if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
else process.env.NODE_ENV = previousNodeEnv;
const componentUrl = pathToFileURL(
  resolve(bundleDirectory, "components.js"),
).href;

async function modalEnvironment(run) {
  const win = new Window({ url: "http://localhost/" }),
    prior = {};
  Object.defineProperty(win.document, "compatMode", { value: "CSS1Compat" });
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Event",
    "KeyboardEvent",
    "DOMParser",
  ]) {
    prior[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: win[key],
    });
  }
  // happy-dom has no layout: model only the browser's rendered-box boundary.
  // Disabled fieldset semantics, focus, events and our trap remain actual DOM behavior.
  win.HTMLElement.prototype.getClientRects = function () {
    if (this.closest("[hidden]")) return [];
    for (let node = this; node; node = node.parentElement) {
      if (win.getComputedStyle(node).display === "none") return [];
      if (
        node.tagName === "DETAILS" &&
        !node.open &&
        !node.querySelector("summary")?.contains(this)
      )
        return [];
    }
    return [{ width: 20, height: 20 }];
  };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const components = await import(componentUrl),
    { createRoot } = await import("react-dom/client");
  const container = win.document.createElement("div");
  win.document.body.append(container);
  const root = createRoot(container);
  try {
    await run({ win, container, root, ...components });
  } finally {
    await act(() => root.unmount());
    win.happyDOM.abort();
    for (const [key, descriptor] of Object.entries(prior)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
}

test("Settings contains Tab focus while work fields are disabled by an active task or a pending save", async () => {
  await modalEnvironment(async ({ win, container, root, Settings }) => {
    const base = {
      configured: true,
      teams: [],
      models: [],
      providers: [],
      work: { checks: [] },
      releaseNotes: { full: "local" },
      version: "fixture",
    };
    let finishSave;
    for (const state of ["active", "busy"]) {
      const props = {
        boot: {
          ...base,
          active: state === "active" ? { taskId: "running" } : null,
        },
        session: null,
        api: {
          action: () =>
            new Promise((resolve) => {
              finishSave = resolve;
            }),
        },
        onRefresh: async () => {},
        onTeamSaved: async () => {},
        onClose: () => {},
      };
      await act(() =>
        root.render(React.createElement(Settings, { ...props, key: state })),
      );
      await act(() =>
        [...container.querySelectorAll(".settings-nav button")]
          .find((n) => n.textContent === "项目执行")
          .click(),
      );
      if (state === "busy")
        await act(() =>
          container
            .querySelector("form")
            .dispatchEvent(
              new win.Event("submit", { bubbles: true, cancelable: true }),
            ),
        );
      const save = [...container.querySelectorAll("button")].find(
        (n) => n.textContent === "保存工作设置",
      );
      assert.equal(save.disabled, false, "the control itself is not disabled");
      assert.equal(
        save.closest("fieldset").disabled,
        true,
        "the ancestor fieldset disables this control",
      );
      const close = container.querySelector('[aria-label="关闭设置"]'),
        lastEnabled = [
          ...container.querySelectorAll(".settings-nav button"),
        ].at(-1);
      lastEnabled.focus();
      const forward = new win.KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      });
      await act(() => lastEnabled.dispatchEvent(forward));
      assert.equal(
        forward.defaultPrevented,
        true,
        `${state}: forward Tab must wrap before disabled descendants`,
      );
      assert.equal(win.document.activeElement, close);
      const reverse = new win.KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      await act(() => close.dispatchEvent(reverse));
      assert.equal(
        reverse.defaultPrevented,
        true,
        `${state}: reverse Tab must wrap`,
      );
      assert.equal(win.document.activeElement, lastEnabled);
      if (state === "busy")
        await act(async () => {
          finishSave({});
        });
    }
  });
});

test("Modal skips invisible ancestor controls and uses a collapsed summary as a real focus stop", async () => {
  await modalEnvironment(async ({ win, container, root, Modal }) => {
    await act(() =>
      root.render(
        React.createElement(
          Modal,
          { title: "Focus", onClose: () => {} },
          React.createElement(
            "details",
            null,
            React.createElement("summary", null, "More"),
            React.createElement("button", null, "Closed content"),
          ),
          React.createElement(
            "div",
            { hidden: true },
            React.createElement("button", null, "Hidden ancestor"),
          ),
          React.createElement(
            "div",
            { style: { display: "none" } },
            React.createElement("button", null, "No display"),
          ),
          React.createElement(
            "div",
            { style: { visibility: "hidden" } },
            React.createElement("button", null, "No visibility"),
          ),
        ),
      ),
    );
    const summary = container.querySelector("summary"),
      close = container.querySelector('[aria-label="关闭Focus"]');
    summary.focus();
    const forward = new win.KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    await act(() => summary.dispatchEvent(forward));
    assert.equal(forward.defaultPrevented, true);
    assert.equal(win.document.activeElement, close);
    const reverse = new win.KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(() => close.dispatchEvent(reverse));
    assert.equal(reverse.defaultPrevented, true);
    assert.equal(win.document.activeElement, summary);
  });
});

test("composer blocks IME confirmation, keeps drafts editable during a run and only offers actual thinking levels", async () => {
  const win = new Window({ url: "http://localhost/" }),
    prior = {};
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Event",
    "KeyboardEvent",
    "CompositionEvent",
  ]) {
    prior[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: win[key],
    });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import("react-dom/client");
  const container = win.document.createElement("div");
  win.document.body.append(container);
  const root = createRoot(container),
    sent = [];
  const team = {
    id: "t",
    name: "Fixture",
    main: { provider: "p", modelId: "main" },
    secondary: [],
  };
  const base = {
    session: { id: "s", mode: "cothink", team },
    boot: {
      teams: [team],
      models: [
        { provider: "p", modelId: "main", thinkingLevels: ["low", "high"] },
      ],
    },
    draft: "中文草稿",
    onDraft: () => {},
    onSubmit: () => sent.push("sent"),
    onChange: () => {},
    onSettings: () => {},
  };
  try {
    await act(() => root.render(React.createElement(Composer, base)));
    const textarea = container.querySelector("textarea");
    await act(() =>
      textarea.dispatchEvent(
        new win.CompositionEvent("compositionstart", { bubbles: true }),
      ),
    );
    await act(() =>
      textarea.dispatchEvent(
        new win.KeyboardEvent("keydown", {
          key: "Enter",
          keyCode: 229,
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await act(() =>
      textarea.dispatchEvent(
        new win.CompositionEvent("compositionend", { bubbles: true }),
      ),
    );
    await act(() =>
      textarea.dispatchEvent(
        new win.KeyboardEvent("keydown", {
          key: "Enter",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.equal(sent.length, 0);
    await act(() =>
      textarea.dispatchEvent(
        new win.KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.equal(sent.length, 1);
    assert.deepEqual(
      [...container.querySelector('[aria-label="思考档位"]').options].map(
        (o) => o.value,
      ),
      ["", "low", "high"],
    );
    await act(() =>
      root.render(React.createElement(Composer, { ...base, busy: true })),
    );
    assert.equal(container.querySelector("textarea").disabled, false);
    assert.equal(container.querySelector('[type="submit"]').disabled, true);
    assert.match(container.textContent, /下一条模式/);
    assert.equal(
      container.querySelector('[aria-label="下一条 Team"]').disabled,
      true,
    );
    await act(() =>
      container.querySelector("textarea").dispatchEvent(
        new win.KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.equal(sent.length, 1);
  } finally {
    await act(() => root.unmount());
    win.happyDOM.abort();
    for (const [key, descriptor] of Object.entries(prior)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});

test("invalid work-check arguments show a form error and do not send a settings action", async () => {
  const win = new Window({ url: "http://localhost/" }),
    prior = {};
  win.document.write("<!doctype html><html><body></body></html>");
  // happy-dom lacks compatMode; the shipped index has a standards-mode doctype.
  Object.defineProperty(win.document, "compatMode", { value: "CSS1Compat" });
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Event",
    "KeyboardEvent",
    "CompositionEvent",
    "DOMParser",
  ]) {
    prior[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: win[key],
    });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { Settings } = await import(componentUrl);
  const { createRoot } = await import("react-dom/client");
  const container = win.document.createElement("div");
  win.document.body.append(container);
  const root = createRoot(container),
    actions = [];
  const boot = {
    configured: true,
    teams: [],
    models: [],
    providers: [],
    work: { checks: [{ command: "npm", args: ["test"] }] },
    releaseNotes: { full: "local" },
    version: "fixture",
  };
  try {
    await act(() =>
      root.render(
        React.createElement(Settings, {
          boot,
          session: null,
          api: {
            action: async (...args) => {
              actions.push(args);
              return {};
            },
          },
          onRefresh: async () => {},
          onTeamSaved: async () => {},
          onClose: () => {},
        }),
      ),
    );
    const workButton = [...container.querySelectorAll("button")].find(
      (n) => n.textContent === "项目执行",
    );
    await act(() => workButton.click());
    const args = [...container.querySelectorAll("label")]
      .find((n) => n.textContent.includes("参数（JSON 数组）"))
      .querySelector("input");
    await act(() => {
      Object.getOwnPropertyDescriptor(
        win.HTMLInputElement.prototype,
        "value",
      ).set.call(args, "{ malformed");
      args.dispatchEvent(new win.Event("input", { bubbles: true }));
      args.dispatchEvent(new win.Event("change", { bubbles: true }));
    });
    await act(() =>
      container
        .querySelector("form")
        .dispatchEvent(
          new win.Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    assert.match(
      container.querySelector('[role="alert"]')?.textContent || "",
      /参数.*JSON/,
    );
    assert.equal(actions.length, 0);
  } finally {
    await act(() => root.unmount());
    win.happyDOM.abort();
    for (const [key, descriptor] of Object.entries(prior)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});

test("application refreshes preserve typed drafts across sessions and cancel the actual active task from history", async () => {
  const win = new Window({ url: "http://127.0.0.1:9999/#token=fixture" }),
    prior = {};
  Object.defineProperty(win.document, "compatMode", { value: "CSS1Compat" });
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Event",
    "KeyboardEvent",
    "CompositionEvent",
    "DOMParser",
    "sessionStorage",
    "localStorage",
  ]) {
    prior[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: win[key],
    });
  }
  for (const key of ["matchMedia", "requestAnimationFrame"]) {
    prior[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: win[key].bind(win),
    });
  }
  prior.fetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { App } = await import(componentUrl),
    { createRoot } = await import("react-dom/client");
  const container = win.document.createElement("div");
  win.document.body.append(container);
  const root = createRoot(container);
  const team = {
    id: "t",
    name: "Fixture",
    main: { provider: "p", modelId: "main" },
    secondary: [{ provider: "p", modelId: "review" }],
  };
  const sessions = {
    a: {
      id: "a",
      title: "Active chat",
      project: null,
      mode: "cothink",
      team,
      draft: "saved a",
      turns: [
        {
          taskId: "task-a",
          input: "running task",
          status: "running",
          mode: "cothink",
          finalText: "",
        },
      ],
      readOnly: false,
    },
    b: {
      id: "b",
      title: "History chat",
      project: null,
      mode: "one",
      team,
      draft: "saved b",
      turns: [],
      readOnly: false,
    },
  };
  const task = {
    id: "task-a",
    sessionId: "a",
    status: "running",
    phase: "draft",
    mode: "cothink",
    team,
    participants: [],
    messages: [],
    usage: { calls: 0 },
    work: null,
  };
  let active = { taskId: "task-a", sessionId: "a", status: "running" },
    stream;
  const actions = [];
  globalThis.fetch = async (path, options) => {
    const url = new URL(path, "http://fixture");
    if (url.pathname === "/api/events")
      return new Response(
        new ReadableStream({
          start(controller) {
            stream = controller;
            options.signal.addEventListener("abort", () => controller.close(), {
              once: true,
            });
          },
        }),
      );
    let result;
    if (url.pathname === "/api/bootstrap")
      result = {
        configured: true,
        version: "fixture",
        teams: [team],
        models: [{ provider: "p", modelId: "main", thinkingLevels: [] }],
        providers: [],
        sessions: Object.values(sessions).map(({ id, title, project }) => ({
          id,
          title,
          project,
        })),
        active,
        work: {},
        releaseNotes: { unread: false, full: "local" },
      };
    else if (url.pathname === "/api/session")
      result = sessions[url.searchParams.get("id")];
    else if (url.pathname === "/api/task") result = task;
    else if (url.pathname === "/api/action") {
      const body = JSON.parse(options.body);
      actions.push(body);
      if (body.action === "session.draft")
        sessions[body.args.sessionId].draft = body.args.text;
      if (body.action === "task.cancel") {
        assert.equal(body.args.taskId, "task-a");
        active = null;
        task.status = "cancelled";
      }
      result = {};
    }
    return new Response(JSON.stringify(result));
  };
  const settle = () =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
  try {
    await act(async () => {
      root.render(React.createElement(App));
    });
    await settle();
    assert.equal(container.querySelector("textarea").value, "saved a");
    await act(() => {
      const input = container.querySelector("textarea");
      Object.getOwnPropertyDescriptor(
        win.HTMLTextAreaElement.prototype,
        "value",
      ).set.call(input, "new unsent a");
      input.dispatchEvent(new win.Event("input", { bubbles: true }));
    });
    await act(() => {
      stream.enqueue(
        new TextEncoder().encode("event: invalidate\ndata: {}\n\n"),
      );
    });
    await settle();
    assert.equal(container.querySelector("textarea").value, "new unsent a");
    await act(() => container.querySelector('[title="History chat"]').click());
    await settle();
    assert.equal(container.querySelector("textarea").value, "saved b");
    await act(() => container.querySelector('[title="Active chat"]').click());
    await settle();
    assert.equal(container.querySelector("textarea").value, "new unsent a");
    await act(() => container.querySelector('[title="History chat"]').click());
    await settle();
    await act(() =>
      [...container.querySelectorAll("button")]
        .find((n) => n.textContent === "停止")
        .click(),
    );
    await settle();
    assert.equal(actions.filter((a) => a.action === "task.cancel").length, 1);
    assert.equal(
      actions.some((a) => a.action === "task.submit"),
      false,
    );
  } finally {
    await act(() => root.unmount());
    win.happyDOM.abort();
    for (const [key, descriptor] of Object.entries(prior)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});

test('a model used as a work member is not also labeled unused because its reviewer role was idle',async()=>{
 await modalEnvironment(async({root,container,Collaboration})=>{
  const model=id=>({provider:'fixture',modelId:id});
  const task={id:'work',status:'completed',phase:'work',participants:[
   {id:'main',role:'main',model:model('main'),participated:true,status:'completed'},
   ...['r1','r2','r3'].map((id,i)=>({id:'reviewer-'+(i+1),role:'reviewer-'+(i+1),model:model(id),participated:false,status:'not_called'})),
   {id:'actual-member',role:'member',model:model('r1'),participated:true,status:'completed'}],
   messages:[{id:'member-call',role:'member:actual-member',model:model('r1'),text:'actual member',phase:'worker',status:'completed'}],work:{members:[{id:'actual-member',model:model('r1'),status:'completed'}],activities:[]},usage:{calls:9}};
  await act(()=>root.render(React.createElement(Collaboration,{task,expanded:false,tab:'collaboration',setTab(){},onExpand(){},onClose(){},api:{}})));
  assert.match(container.textContent,/完整阵容 · 2 位本轮未参与/);
  const unused=[...container.querySelectorAll('.inactive-member')].map(x=>x.textContent);
  assert.ok(unused.every(x=>!x.includes('r1')));assert.equal(container.querySelectorAll('.participant').length,2);
 });
});

test('update settings keep controls disabled during a check and show a save failure without claiming success', async () => {
  await modalEnvironment(async ({container,root,Settings})=>{
    const {createUpdateService,formatUpdateStatus,updateInstructions}=await import('../src/updates.js');
    const {mkdtempSync,rmSync}=await import('node:fs');const {join}=await import('node:path');const {tmpdir}=await import('node:os');
    const home=mkdtempSync(join(tmpdir(),'gui-update-settings-'));
    const service=createUpdateService({home,currentVersion:'1.0.0',env:{},fetchImpl:async()=>new Response(JSON.stringify({name:'cothink-v2',version:'2.0.0'}))});
    await service.check({manual:true});const s=service.snapshot();
    const boot={configured:true,teams:[],models:[],providers:[],work:{},version:'1.0.0',releaseNotes:{full:'local'},updates:{...s,message:formatUpdateStatus(s),instructions:updateInstructions(s)}};
    let calls=0,fail;
    const api={action:async()=>{calls++;await new Promise((_,reject)=>fail=reject);}};
    try {
      await act(()=>root.render(React.createElement(Settings,{boot,session:null,api,onRefresh:async()=>{},onClose:()=>{},initialTab:'updates'})));
      const check=[...container.querySelectorAll('button')].find(b=>b.textContent==='检查更新');
      const toggle=container.querySelector('.update-settings input[type="checkbox"]');
      await act(()=>toggle.click());
      assert.equal(calls,1);assert.equal(toggle.disabled,true);assert.equal(check.disabled,true);
      await act(()=>fail(Error('无法保存更新偏好，原文件保留。')));
      assert.equal(toggle.checked,true);assert.match(container.textContent,/无法保存更新偏好/);
      assert.doesNotMatch(container.textContent,/设置已保存/);assert.equal(check.disabled,false);
    } finally {service.close();rmSync(home,{recursive:true,force:true});}
  });
});

test('collaboration shows unresolved conflict and separates a completed mismatch review from semantic success', async()=>{
  await modalEnvironment(async({root,container,Collaboration})=>{
    const task={id:'fidelity-ui',status:'partial',phase:'visual-review',participants:[],messages:[],usage:{calls:8},work:{
      activities:[],acceptance:[{status:'accepted'}],members:[{id:'m',model:{provider:'fixture',modelId:'r1'},taskConflict:{message:'原题自行车骑鹈鹕，委派颠倒。',unresolved:true},feedback:['撤回颠倒建议']}],
      visualEvidence:[{toolCallId:'image',entry:'index.html',actor:'main',checked:true,semanticMatch:false,result:'captured',imageRequestId:'review',imageRequestCompleted:true,viewport:{width:375,height:667},images:[],review:{verdict:'mismatch',status:'completed',observation:'看到鹈鹕骑自行车',reasons:'主体关系与原题相反'}}],
    }};
    const props={task,expanded:true,setTab(){},onExpand(){},onClose(){},api:{}};
    await act(()=>root.render(React.createElement(Collaboration,{...props,tab:'collaboration'})));
    assert.match(container.textContent,/成员题意冲突 · 尚未解决/);
    assert.match(container.textContent,/撤回颠倒建议/);
    await act(()=>root.render(React.createElement(Collaboration,{...props,tab:'checks'})));
    assert.match(container.textContent,/最终版本审查完成/);
    assert.match(container.textContent,/模型判断不符合/);
    assert.match(container.textContent,/主体关系与原题相反/);
    assert.doesNotMatch(container.textContent,/模型判断符合/);
  });
});


test("Option+M toggles composer mode without typing or sending, including during work", async () => {
  await modalEnvironment(async ({win, container, root}) => {
    const changes = [], drafts = [], submissions = [];
    const base = {
      session: {id: "s", mode: "cothink"}, boot: {models: [], teams: []},
      draft: "keep this draft", onDraft: value => drafts.push(value),
      onSubmit: () => submissions.push(true), onChange: (...args) => changes.push(args),
      onSettings: () => {},
    };
    const render = props => act(() => root.render(React.createElement(Composer, {...base, ...props})));
    const press = async (overrides = {}) => {
      const event = new win.KeyboardEvent("keydown", {key: "µ", code: "KeyM", altKey: true,
        bubbles: true, cancelable: true, ...overrides});
      await act(() => container.querySelector("textarea").dispatchEvent(event));
      return event;
    };
    await render({});
    assert.equal((await press()).defaultPrevented, true);
    assert.deepEqual(changes, [["session.mode", {mode: "one"}]]);
    await render({busy: true, session: {...base.session, mode: "one"}});
    await press();
    assert.deepEqual(changes.at(-1), ["session.mode", {mode: "cothink"}]);
    for (const event of [{repeat: true}, {isComposing: true}, {keyCode: 229},
      {ctrlKey: true}, {metaKey: true}, {shiftKey: true}, {altKey: false}]) await press(event);
    assert.equal(changes.length, 2);
    for (const props of [{session: {...base.session, readOnly: true}},
      {session: {...base.session, selectionError: "write failed"}}, {submitting: true}, {pending: true}]) {
      await render(props); await press();
    }
    assert.equal(changes.length, 2);
    assert.equal(container.querySelector("textarea").value, "keep this draft");
    assert.deepEqual(drafts, []);
    assert.deepEqual(submissions, []);
  });
});
