import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cases = [
  ["reuse", "adding an authenticated deputy explains provider key reuse without rewriting credentials"],
  ["custom-save", "a new custom deputy accepts a masked key inline and saves only into a new Team"],
  ["custom-escape", "Escape during inline key entry leaves Team, credentials, and catalog unchanged"],
  ["custom-blank", "a blank inline key leaves Team, credentials, and catalog unchanged"],
  ["existing-save", "an existing unauthenticated custom provider can save its key inside deputy selection"],
];

for (const [name, title] of cases) {
  test(title, { skip: process.platform === "win32" }, () => {
    const output = execFileSync("python3", [fileURLToPath(new URL("./helpers/pi_inline_auth_checks.py", import.meta.url)), name], {
      env: process.env, encoding: "utf8", timeout: 45000,
    });
    const [result] = JSON.parse(output);
    assert.equal(result.case, name);
    assert.ok(result.checks.includes("management created zero tasks or requests"));
    assert.ok(Object.keys(result.screens).length > 0);
  });
}
