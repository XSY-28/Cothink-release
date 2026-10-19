import test from "node:test";
import assert from "node:assert/strict";
const setup = await import("../src/setup.js").catch(() => ({}));
test("/one applies only to one independent input; pasted command text stays material", () => {
  assert.equal(typeof setup.parseTurnInput, "function");
  assert.deepEqual(setup.parseTurnInput("/one hello"), { input: "hello", singleModel: true });
  assert.equal(setup.parseTurnInput("next").singleModel, false);
  assert.equal(setup.parseTurnInput("/one").local, true);
  assert.equal(setup.parseTurnInput("material\n/one hello").input, "material\n/one hello");
  assert.equal(setup.parseTurnInput("/one\nmaterial").singleModel, false);
});
