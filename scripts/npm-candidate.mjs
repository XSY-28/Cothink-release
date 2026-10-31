/** Select one pack:npm result for both CI platforms and local candidate checks. */
import assert from "node:assert/strict";
import { readFileSync, appendFileSync, statSync } from "node:fs";
import { resolve, basename } from "node:path";

const [metadata = "pack-result.json", outputDirectory = "dist"] = process.argv.slice(2);
assert.ok(process.env.COTHINK_EXPECT_VERSION, "COTHINK_EXPECT_VERSION is required from the source or caller");
assert.ok(process.env.GITHUB_ENV, "GITHUB_ENV must explicitly name the environment output file");
const results = JSON.parse(readFileSync(metadata));
assert.equal(results.length, 1);
const [packed] = results;
assert.equal(packed.version, process.env.COTHINK_EXPECT_VERSION);
assert.equal(packed.filename, basename(packed.filename));
const tarball = resolve(outputDirectory, packed.filename);
assert.ok(statSync(tarball).isFile());
appendFileSync(process.env.GITHUB_ENV, `COTHINK_TARBALL=${tarball}\n`);
