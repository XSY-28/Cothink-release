import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getKeybindings, Input } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { createProvider } from "@earendil-works/pi-ai";
import { fixture } from "./helpers/pi-fixture.js";
import { createModelRuntime } from "../src/pi-runtime.js";
import * as setup from "../src/setup.js";
import * as selection from "../src/selection.js";

const secret = "inline-fixture-key-do-not-render";
const theme = { fg: (_color, text) => text, bold: text => text };
const bytes = path => existsSync(path) ? readFileSync(path, "utf8") : null;
function ensure(options) {
  assert.equal(typeof setup.ensureProviderAuth, "function", "inline selection needs the shared authentication flow");
  return setup.ensureProviderAuth(options);
}
async function unauthenticatedFixture(t) {
  const f = await fixture(t);
  const path = join(f.home, "pi", "models.json");
  const models = JSON.parse(readFileSync(path, "utf8"));
  delete models.providers.fixture.apiKey;
  writeFileSync(path, JSON.stringify(models));
  return { ...f, runtime: await createModelRuntime(f.home) };
}
function rejectUnexpectedInteraction() {
  assert.fail("existing authentication must not request another key or a login method");
}
function customIo(key, messages = []) {
  const answers = ["inline-custom", "http://127.0.0.1:1/v1", "custom-model"];
  return {
    notify: message => messages.push(message),
    async select(label) { return label.includes("服务商") ? "custom" : "openai-completions"; },
    async prompt(field) { return field.type === "secret" ? key : answers.shift(); },
  };
}

test("model selection identifies the provider whose configured API key will be reused", async t => {
  const f = await fixture(t), runtime = await createModelRuntime(f.home), messages = [];
  const modelsBefore = bytes(join(f.home, "pi", "models.json"));
  const authBefore = bytes(join(f.home, "pi", "auth.json"));
  const ref = await setup.selectModelRef({ runtime, home: f.home, role: "副", io: {
    notify: message => messages.push(message), prompt: rejectUnexpectedInteraction,
    async select(label) { return label.includes("服务商") ? "fixture" : "r1"; },
  } });
  assert.deepEqual(ref, { provider: "fixture", modelId: "r1" });
  assert.match(messages.join("\n"), /fixture/);
  assert.match(messages.join("\n"), /复用/);
  assert.match(messages.join("\n"), /API\s*key/i);
  assert.doesNotMatch(messages.join("\n"), /fixture-secret/);
  assert.equal(bytes(join(f.home, "pi", "models.json")), modelsBefore);
  assert.equal(bytes(join(f.home, "pi", "auth.json")), authBefore);
  assert.equal(f.calls.length, 0);
});

test("an unconfigured provider prompts inline and saves a key through real Pi storage", async t => {
  const f = await unauthenticatedFixture(t), messages = [], fields = [];
  assert.equal(f.runtime.hasConfiguredAuth("fixture"), false);
  await ensure({ runtime: f.runtime, provider: "fixture", io: {
    notify: message => messages.push(message), select: rejectUnexpectedInteraction,
    async prompt(field) { fields.push(field); return secret; },
  } });
  assert.equal(fields.length, 1);
  assert.equal(fields[0].type, "secret");
  assert.deepEqual(JSON.parse(bytes(join(f.home, "pi", "auth.json"))).fixture, { type: "api_key", key: secret });
  assert.equal(f.runtime.hasConfiguredAuth("fixture"), true);
  assert.doesNotMatch(messages.join("\n"), new RegExp(secret));
  const reopened = await createModelRuntime(f.home), before = bytes(join(f.home, "pi", "auth.json"));
  await ensure({ runtime: reopened, provider: "fixture", io: {
    notify: message => messages.push(message), prompt: rejectUnexpectedInteraction, select: rejectUnexpectedInteraction,
  } });
  assert.equal(bytes(join(f.home, "pi", "auth.json")), before);
  assert.match(messages.join("\n"), /复用/);
  assert.equal(f.calls.length, 0);
});

test("stored OAuth is reported as OAuth and reused without opening login", async t => {
  const f = await fixture(t), path = join(f.home, "pi", "auth.json"), messages = [];
  writeFileSync(path, JSON.stringify({ anthropic: {
    type: "oauth", access: "fixture-oauth-access", refresh: "fixture-oauth-refresh", expires: Date.now() + 3600000,
  } }));
  const before = bytes(path), runtime = await createModelRuntime(f.home);
  assert.equal(runtime.isUsingOAuth("anthropic"), true);
  await ensure({ runtime, provider: "anthropic", io: {
    notify: message => messages.push(message), prompt: rejectUnexpectedInteraction, select: rejectUnexpectedInteraction,
  } });
  const notice = messages.join("\n");
  assert.match(notice, /anthropic/i);
  assert.match(notice, /OAuth/);
  assert.match(notice, /复用/);
  assert.doesNotMatch(notice, /fixture-oauth-(?:access|refresh)/);
  assert.equal(bytes(path), before);
  assert.equal(f.calls.length, 0);
});

test("environment authentication reports its source without revealing its value or persisting it", async t => {
  const old = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = secret;
  t.after(() => old === undefined ? delete process.env.OPENAI_API_KEY : process.env.OPENAI_API_KEY = old);
  const f = await fixture(t), runtime = await createModelRuntime(f.home), messages = [];
  const path = join(f.home, "pi", "auth.json"), before = bytes(path);
  assert.equal(runtime.getProviderAuthStatus("openai").source, "environment");
  await ensure({ runtime, provider: "openai", io: {
    notify: message => messages.push(message), prompt: rejectUnexpectedInteraction, select: rejectUnexpectedInteraction,
  } });
  const notice = messages.join("\n");
  assert.match(notice, /openai/i);
  assert.match(notice, /环境|environment/i);
  assert.match(notice, /OPENAI_API_KEY/);
  assert.doesNotMatch(notice, new RegExp(secret));
  assert.equal(bytes(path), before);
  assert.equal(f.calls.length, 0);
});

test("providers supporting API key and OAuth go directly to a secret API key prompt", async t => {
  // Anthropic accepts bearer/OAuth tokens and workload identity as well as API keys.
  // Isolate every ambient auth path so this case always exercises new-key entry.
  const ambientNames = [
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN",
    "ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_ORGANIZATION_ID", "ANTHROPIC_IDENTITY_TOKEN_FILE",
    "ANTHROPIC_SERVICE_ACCOUNT_ID", "ANTHROPIC_WORKSPACE_ID",
  ];
  const saved = new Map(ambientNames.map(name => [name, process.env[name]]));
  for (const name of ambientNames) delete process.env[name];
  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const f = await fixture(t), runtime = await createModelRuntime(f.home), fields = [];
  assert.equal(runtime.hasConfiguredAuth("anthropic"), false);
  assert.ok(runtime.getProvider("anthropic").auth.apiKey.login);
  assert.ok(runtime.getProvider("anthropic").auth.oauth.login);
  await ensure({ runtime, provider: "anthropic", io: {
    notify() {}, select: rejectUnexpectedInteraction,
    async prompt(field) { fields.push(field); return secret; },
  } });
  assert.equal(fields.length, 1);
  assert.equal(fields[0].type, "secret");
  assert.deepEqual(JSON.parse(bytes(join(f.home, "pi", "auth.json"))).anthropic, { type: "api_key", key: secret });
  assert.equal(f.calls.length, 0);
});

test("an OAuth-only provider retains its login flow and stores the OAuth credential", async t => {
  const f = await fixture(t), runtime = await createModelRuntime(f.home), messages = [];
  const credential = { type: "oauth", access: "offline-oauth-access", refresh: "offline-oauth-refresh", expires: Date.now() + 3600000 };
  runtime.registerNativeProvider(createProvider({
    id: "oauth-only-fixture", name: "Offline OAuth Fixture", baseUrl: f.endpoint,
    models: [{ ...runtime.getModel("fixture", "r1"), provider: "oauth-only-fixture" }],
    api: runtime.getProvider("fixture"),
    auth: { oauth: {
      name: "Offline OAuth",
      async login(interaction) {
        interaction.signal.throwIfAborted();
        interaction.notify({ type: "info", message: "Offline OAuth verification" });
        const code = await interaction.prompt({ type: "text", message: "Fixture verification code" });
        assert.equal(code, "local-verification-code");
        return credential;
      },
      async refresh(value) { return value; },
      async toAuth(value) { return { apiKey: value.access }; },
    } },
  }));
  await runtime.refresh({ allowNetwork: false });
  await ensure({ runtime, provider: "oauth-only-fixture", io: {
    notify: message => messages.push(message), select: rejectUnexpectedInteraction,
    async prompt(field) { assert.equal(field.type, "text"); return "local-verification-code"; },
  } });
  assert.equal(runtime.isUsingOAuth("oauth-only-fixture"), true);
  assert.deepEqual(JSON.parse(bytes(join(f.home, "pi", "auth.json")))["oauth-only-fixture"], credential);
  assert.match(messages.join("\n"), /OAuth/);
  assert.doesNotMatch(messages.join("\n"), /offline-oauth-(?:access|refresh)/);
  assert.equal(f.calls.length, 0);
});

for (const [label, key] of [["empty", ""], ["whitespace", " \t\n "], ["undefined cancellation", undefined], ["null cancellation", null]]) {
  test(`${label} does not persist an API key or authenticate the provider`, async t => {
    const f = await unauthenticatedFixture(t), path = join(f.home, "pi", "auth.json");
    const before = bytes(path), messages = [];
    await assert.rejects(async () => ensure({ runtime: f.runtime, provider: "fixture", io: {
      notify: message => messages.push(message), async prompt() { return key; }, select: rejectUnexpectedInteraction,
    } }), error => {
      if (key == null) assert.equal(error.name, "AbortError");
      else assert.match(error.message, /空|empty|blank/i);
      return true;
    });
    assert.equal(bytes(path), before);
    assert.equal(f.runtime.hasConfiguredAuth("fixture"), false);
    assert.equal(f.calls.length, 0);
  });
}

test("aborting while entering a key cannot authenticate the provider", async t => {
  const f = await unauthenticatedFixture(t), controller = new AbortController();
  const before = bytes(join(f.home, "pi", "auth.json"));
  await assert.rejects(async () => ensure({ runtime: f.runtime, provider: "fixture", signal: controller.signal, io: {
    notify() {}, async prompt() { controller.abort(); return secret; }, select: rejectUnexpectedInteraction,
  } }), { name: "AbortError" });
  assert.equal(bytes(join(f.home, "pi", "auth.json")), before);
  assert.equal(f.runtime.hasConfiguredAuth("fixture"), false);
  assert.equal(f.calls.length, 0);
});

for (const [label, key] of [["cancel", undefined], ["blank", "  "]]) {
  test(`custom provider ${label} leaves catalog and credentials unchanged`, async t => {
    const f = await fixture(t), runtime = await createModelRuntime(f.home);
    const modelsPath = join(f.home, "pi", "models.json"), authPath = join(f.home, "pi", "auth.json");
    const catalog = bytes(modelsPath), credentials = bytes(authPath);
    await assert.rejects(setup.selectModelRef({ runtime, home: f.home, role: "副", io: customIo(key) }));
    assert.equal(bytes(modelsPath), catalog, "cancelled custom credentials must not register a provider");
    assert.equal(bytes(authPath), credentials);
    assert.equal(runtime.getProvider("inline-custom"), undefined);
    assert.equal(f.calls.length, 0);
  });
}

test("a custom provider stores its key only in auth.json and is immediately reusable", async t => {
  const f = await fixture(t), runtime = await createModelRuntime(f.home), messages = [];
  const ref = await setup.selectModelRef({ runtime, home: f.home, role: "副", io: customIo(secret, messages) });
  assert.deepEqual(ref, { provider: "inline-custom", modelId: "custom-model" });
  assert.equal(runtime.hasConfiguredAuth("inline-custom"), true);
  assert.deepEqual(JSON.parse(bytes(join(f.home, "pi", "auth.json")))["inline-custom"], { type: "api_key", key: secret });
  assert.doesNotMatch(bytes(join(f.home, "pi", "models.json")), new RegExp(secret));
  assert.doesNotMatch(messages.join("\n"), new RegExp(secret));
  assert.equal(f.calls.length, 0);
});

for (const configured of [true, false]) {
  test(`custom IDs cannot replace a ${configured ? "configured" : "unconfigured"} built-in provider`, async t => {
    const oldEnvironmentKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    t.after(() => {
      if (oldEnvironmentKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = oldEnvironmentKey;
    });
    const f = await fixture(t), authPath = join(f.home, "pi", "auth.json"), modelsPath = join(f.home, "pi", "models.json");
    writeFileSync(authPath, JSON.stringify(configured ? { openai: { type: "api_key", key: "prior-openai-fixture-key" } } : {}));
    const runtime = await createModelRuntime(f.home), catalog = bytes(modelsPath), auth = bytes(authPath);
    assert.ok(runtime.getProvider("openai"));
    assert.equal(runtime.hasConfiguredAuth("openai"), configured);
    assert.equal(JSON.parse(catalog).providers.openai, undefined);
    const answers = ["openai", f.endpoint, "custom-model"];
    let keyPrompts = 0;
    await assert.rejects(setup.selectModelRef({ runtime, home: f.home, role: "副", io: {
      notify() {},
      async select(label) { return label.includes("服务商") ? "custom" : "openai-completions"; },
      async prompt(field) {
        if (field.type === "secret") { keyPrompts++; return secret; }
        return answers.shift();
      },
    } }), /存在|占用|existing|registered/i);
    assert.equal(keyPrompts, 0, "an existing provider must be rejected before asking for its replacement key");
    assert.equal(bytes(modelsPath), catalog);
    assert.equal(bytes(authPath), auth);
    assert.equal(f.calls.length, 0);
  });
}

test("custom IDs cannot attach an orphaned saved credential to a new endpoint", async t => {
  const f = await fixture(t), authPath = join(f.home, "pi", "auth.json"), modelsPath = join(f.home, "pi", "models.json");
  writeFileSync(authPath, JSON.stringify({ "inline-custom": { type: "api_key", key: "orphaned-fixture-key" } }));
  const runtime = await createModelRuntime(f.home), catalog = bytes(modelsPath), auth = bytes(authPath);
  assert.equal(runtime.getProvider("inline-custom"), undefined);
  assert.ok((await runtime.listCredentials()).some(entry => entry.providerId === "inline-custom"));
  const io = customIo(secret), prompt = io.prompt;
  let keyPrompts = 0;
  io.prompt = async field => {
    if (field.type === "secret") keyPrompts++;
    return prompt(field);
  };
  await assert.rejects(setup.selectModelRef({ runtime, home: f.home, role: "副", io }), /存在|占用|existing|registered/i);
  assert.equal(keyPrompts, 0, "saved credentials must not be repurposed for a new endpoint");
  assert.equal(bytes(modelsPath), catalog);
  assert.equal(bytes(authPath), auth);
  assert.equal(runtime.getProvider("inline-custom"), undefined);
  assert.equal(f.calls.length, 0);
});

test("saving a custom provider preserves a different provider added while its key prompt is open", async t => {
  const f = await fixture(t), runtime = await createModelRuntime(f.home), modelsPath = join(f.home, "pi", "models.json");
  const originalFixture = JSON.parse(bytes(modelsPath)).providers.fixture;
  const concurrentProvider = {
    ...structuredClone(originalFixture),
    models: [{ ...structuredClone(originalFixture.models[0]), id: "other-window-model", name: "Other Window Model" }],
  };
  const io = customIo(secret), prompt = io.prompt;
  io.prompt = async field => {
    if (field.type === "secret") {
      // Another window edits the catalog while the user is still entering this key.
      const latest = JSON.parse(bytes(modelsPath));
      latest.providers["other-window"] = concurrentProvider;
      writeFileSync(modelsPath, JSON.stringify(latest));
    }
    return prompt(field);
  };
  const ref = await setup.selectModelRef({ runtime, home: f.home, role: "副", io });
  assert.deepEqual(ref, { provider: "inline-custom", modelId: "custom-model" });
  const stored = JSON.parse(bytes(modelsPath));
  assert.deepEqual(stored.providers["other-window"], concurrentProvider);
  assert.deepEqual(stored.providers.fixture, originalFixture);
  assert.equal(stored.providers["inline-custom"].models[0].id, "custom-model");
  assert.equal(runtime.hasConfiguredAuth("inline-custom"), true);
  assert.equal(f.calls.length, 0);
});

test("a failed post-save refresh reports committed credentials without leaking their value", async t => {
  const f = await unauthenticatedFixture(t), messages = [];
  // Fault only the refresh after the real SDK login has saved the actual credentials.
  f.runtime.models.refresh = async () => { throw Error(`fixture refresh failed: ${secret}`); };
  await assert.rejects(async () => ensure({ runtime: f.runtime, provider: "fixture", io: {
    notify: message => messages.push(message), async prompt() { return secret; }, select: rejectUnexpectedInteraction,
  } }), error => {
    assert.match(error.message, /已保存|committed|saved/i);
    assert.match(error.message, /同步|synchroniz/i);
    assert.doesNotMatch(String(error), new RegExp(secret));
    return true;
  });
  assert.deepEqual(JSON.parse(bytes(join(f.home, "pi", "auth.json"))).fixture, { type: "api_key", key: secret });
  assert.doesNotMatch(messages.join("\n"), new RegExp(secret));
  assert.equal(f.calls.length, 0);
});

test("a credential storage failure does not claim success or expose the attempted key", async t => {
  assert.equal(typeof setup.ensureProviderAuth, "function");
  const f = await unauthenticatedFixture(t), messages = [];
  const before = bytes(join(f.home, "pi", "auth.json"));
  // The real SDK still selects and runs the provider login; only its disk commit fails.
  f.runtime.credentials.store.modify = async () => { throw Error(`fixture disk failure: ${secret}`); };
  await assert.rejects(async () => ensure({ runtime: f.runtime, provider: "fixture", io: {
    notify: message => messages.push(message), async prompt() { return secret; }, select: rejectUnexpectedInteraction,
  } }), error => {
    assert.doesNotMatch(String(error), new RegExp(secret));
    assert.doesNotMatch(error.message, /已保存|committed|saved/i);
    return true;
  });
  assert.equal(bytes(join(f.home, "pi", "auth.json")), before);
  assert.equal(f.runtime.hasConfiguredAuth("fixture"), false);
  assert.doesNotMatch(messages.join("\n"), new RegExp(secret));
  assert.equal(f.calls.length, 0);
});

function secretDialog(field = {}) {
  assert.equal(typeof selection.promptSecret, "function", "secret fields need native masked input");
  initTheme();
  let component;
  const frames = [];
  const tui = { terminal: { rows: 24, columns: 80 }, requestRender() {
    if (component) frames.push(component.render(80).join("\n"));
  } };
  const promise = selection.promptSecret({ custom(factory) {
    return new Promise(resolve => {
      component = factory(tui, theme, getKeybindings(), resolve);
    });
  } }, { type: "secret", message: "fixture API key", ...field });
  return { get component() { return component; }, promise, frames };
}
function inputIn(component) {
  if (component instanceof Input) return component;
  if (component.input instanceof Input) return component.input;
  for (const child of component.children ?? []) {
    const input = inputIn(child);
    if (input) return input;
  }
}

test("secret input is masked while typing and after submission, then clears its retained input", async () => {
  const f = secretDialog();
  await Promise.resolve();
  const input = inputIn(f.component);
  assert.ok(input, "the prompt must use the Pi input component");
  for (const character of secret) {
    f.component.handleInput(character);
    f.frames.push(f.component.render(80).join("\n"));
  }
  assert.equal(input.getValue(), secret);
  assert.match(f.frames.at(-1), /[•*]/);
  f.component.handleInput("\r");
  f.frames.push(f.component.render(80).join("\n"));
  assert.equal(await f.promise, secret);
  assert.ok(f.frames.every(frame => !frame.includes(secret)));
  assert.equal(input.getValue(), "", "completed prompts must clear the held input buffer");
});

for (const action of ["escape", "abort", "dispose"]) {
  test(`secret ${action} cancels and clears its input without exposing the key`, async () => {
    const controller = new AbortController(), f = secretDialog({ signal: controller.signal });
    await Promise.resolve();
    const input = inputIn(f.component);
    assert.ok(input);
    f.component.handleInput(secret);
    f.frames.push(f.component.render(80).join("\n"));
    if (action === "escape") f.component.handleInput("\x1b");
    else if (action === "abort") controller.abort();
    else {
      assert.equal(typeof f.component.dispose, "function");
      f.component.dispose();
    }
    assert.equal(await f.promise, undefined);
    assert.equal(input.getValue(), "");
    f.frames.push(f.component.render(80).join("\n"));
    assert.ok(f.frames.every(frame => !frame.includes(secret)));
  });
}

test("a pre-aborted secret prompt returns cancellation without opening an editor", async () => {
  assert.equal(typeof selection.promptSecret, "function");
  const controller = new AbortController(); controller.abort();
  const result = await selection.promptSecret({ custom: rejectUnexpectedInteraction }, {
    type: "secret", message: "fixture API key", signal: controller.signal,
  });
  assert.equal(result, undefined);
});
