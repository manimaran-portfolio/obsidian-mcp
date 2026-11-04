import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../args.js";

test("reads the vault positional and --agent", () => {
  assert.deepEqual(parseArgs(["/v", "--agent", "codex"], {}), { vault: "/v", agent: "codex", writeAlso: [] });
  assert.deepEqual(parseArgs(["--agent", "codex", "/v"], {}), { vault: "/v", agent: "codex", writeAlso: [] });
});

test("falls back to OBSIDIAN_AGENT, and the flag wins over it", () => {
  assert.equal(parseArgs(["/v"], { OBSIDIAN_AGENT: "hermes" }).agent, "hermes");
  assert.equal(parseArgs(["/v", "--agent", "codex"], { OBSIDIAN_AGENT: "hermes" }).agent, "codex");
});

test("no agent gives agent null", () => {
  assert.deepEqual(parseArgs(["/v"], {}), { vault: "/v", agent: null, writeAlso: [] });
  assert.equal(parseArgs(["/v"], { OBSIDIAN_AGENT: "" }).agent, null);
});

test("rejects bad agent names", () => {
  for (const bad of ["../x", "Codex", "", "-x", "a b", "a".repeat(33)]) {
    assert.throws(() => parseArgs(["/v", "--agent", bad], {}), /Invalid agent name/, JSON.stringify(bad));
  }
  assert.throws(() => parseArgs(["/v", "--agent"], {}), /Invalid agent name/);
});

test("accepts a 32-character name", () => {
  assert.equal(parseArgs(["/v", "--agent", "a".repeat(32)], {}).agent, "a".repeat(32));
});

test("--write-also is repeatable, normalised, and rejects unsafe folders", () => {
  const r = parseArgs(["/v", "--agent", "hermes", "--write-also", "Learning/", "--write-also", "Certifications"]);
  assert.deepEqual(r.writeAlso, ["Learning", "Certifications"]);
  assert.deepEqual(parseArgs(["/v"], { OBSIDIAN_WRITE_ALSO: "A, B" }).writeAlso, ["A", "B"]);
  for (const bad of ["../x", ".obsidian", "Agents"]) assert.throws(() => parseArgs(["/v", "--write-also", bad]), /Invalid --write-also/);
});
