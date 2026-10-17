import test from "node:test";
import assert from "node:assert/strict";
import { stampProvenance } from "../frontmatter.js";

const NOW = new Date("2026-10-17T12:00:00.000Z");

test("adds agent and updated to a note without frontmatter", () => {
  assert.equal(stampProvenance("body\n", "codex", NOW), "---\nagent: codex\nupdated: 2026-10-17T12:00:00.000Z\n---\nbody\n");
});

test("overwrites existing agent and updated and keeps other keys", () => {
  assert.equal(
    stampProvenance("---\nagent: old\nupdated: x\ntags: [a]\n---\nbody\n", "codex", NOW),
    "---\nagent: codex\nupdated: 2026-10-17T12:00:00.000Z\ntags: [ a ]\n---\nbody\n",
  );
});

test("preserves CRLF line endings and a BOM", () => {
  const out = stampProvenance("﻿---\r\ntags: [a]\r\n---\r\nbody\r\n", "codex", NOW);
  assert.ok(out.startsWith("﻿---\r\n"));
  assert.ok(!/[^\r]\n/.test(out), "every newline stays CRLF");
  assert.match(out, /agent: codex/);
});

test("returns invalid-YAML frontmatter unchanged", () => {
  const raw = "---\na: [\n---\nbody";
  assert.equal(stampProvenance(raw, "codex", NOW), raw);
});
