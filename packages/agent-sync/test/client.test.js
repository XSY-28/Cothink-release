import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { backend, begin, replace, accept } from "./helpers/repository.js";
const execution = JSON.parse(
  readFileSync(
    new URL(
      "../execution-manifest.json",
      import.meta.url,
    ),
  ),
).execution;
test("C01/C11/C12 no-model Markdown/JSON/binary client accepts twice and restores only selected old content", async (t) => {
  const checks = [
    {
      command: "node",
      args: [
        "-e",
        "const f=require('fs');JSON.parse(f.readFileSync('settings.json'));if(f.readFileSync('asset.bin').length!==3)process.exit(1);if(!f.readFileSync('guide.md','utf8').startsWith('# '))process.exit(2)",
      ],
    },
  ];
  const { v } = await backend(t, { execution, checks }),
    c = await begin(v, "docs", ["guide.md", "settings.json", "asset.bin"]);
  await replace(v, c, "guide.md", "# Guide\n", "guide");
  await replace(v, c, "settings.json", '{"enabled":true}\n', "json");
  await replace(v, c, "asset.bin", Buffer.from([0, 255, 1]), "binary");
  const first = await accept(v, c, "first");
  assert.equal(first.verification, "passed");
  const next = await begin(v, "second", ["guide.md", "asset.bin"]);
  await replace(v, next, "guide.md", "# Updated\n", "update-guide");
  await replace(v, next, "asset.bin", Buffer.from([1, 2, 3]), "update-binary");
  const second = await accept(v, next, "second-accept");
  assert.equal(second.status, "accepted");
  const restore = await begin(v, "restore-binary", ["asset.bin"], {
    restoreFrom: first.acceptedVersion,
  });
  const restored = await accept(v, restore, "restore-accept");
  assert.equal(restored.verification, "passed");
  assert.deepEqual(
    Buffer.from(
      (await v.read({ version: restored.acceptedVersion, path: "asset.bin" }))
        .contentBase64,
      "base64",
    ),
    Buffer.from([0, 255, 1]),
  );
  assert.equal(
    Buffer.from(
      (await v.read({ version: restored.acceptedVersion, path: "guide.md" }))
        .contentBase64,
      "base64",
    ).toString(),
    "# Updated\n",
  );
  assert.deepEqual(
    (
      await v.inspect({
        fromVersion: first.acceptedVersion,
        toVersion: second.acceptedVersion,
      })
    ).binaryFiles,
    ["asset.bin"],
  );
  assert.equal(
    (await v.inspect({ history: { limit: 100 } })).versions.length,
    4,
  );
  assert.equal((await v.checkCurrent()).verification, "passed");
});
