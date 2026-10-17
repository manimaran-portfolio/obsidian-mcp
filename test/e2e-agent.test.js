import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tmpVault } from "./helpers.js";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server.js");
const v = tmpVault({
  "Notes/a.md": "---\nk: 1\n---\nalpha [[own]]\n",
  "Notes/ref.md": "[[own]]\n",
  "Agents/codex/own.md": "own\n",
  "Agents/codex/inner.md": "[[own]]\n",
});
fs.symlinkSync(path.join(v.dir, "Notes"), path.join(v.dir, "Agents/codex/lnk"));
fs.writeFileSync(path.join(v.dir, ".obsidian/daily-notes.json"), JSON.stringify({ folder: "Journal", format: "YYYY.MM.DD" }));

const client = new Client({ name: "t", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: [SERVER, v.dir, "--agent", "codex"] }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { err: !!r.isError, text: r.content[0].text };
};
const onDisk = (rel) => fs.readFileSync(path.join(v.dir, rel), "utf8");
const LIMIT = /Writes are limited to Agents\/codex\//;

test.after(async () => {
  await client.close();
  v.cleanup();
});

test("lists 13 tools", async () => {
  assert.equal((await client.listTools()).tools.length, 13);
});

test("write_note outside Agents/codex is an error naming the scope, and nothing is written", async () => {
  const r = await call("write_note", { path: "Notes/x", content: "x" });
  assert.ok(r.err);
  assert.match(r.text, LIMIT);
  assert.ok(!fs.existsSync(path.join(v.dir, "Notes/x.md")));
});

test("write_note inside Agents/codex succeeds and stamps agent and updated", async () => {
  assert.ok(!(await call("write_note", { path: "Agents/codex/new", content: "hello\n" })).err);
  assert.match(onDisk("Agents/codex/new.md"), /^---\nagent: codex\nupdated: \d{4}-\d{2}-\d{2}T[\d:.]+Z\n---\nhello\n$/);
});

test("append, patch, update_frontmatter and delete_note outside the root are errors", async () => {
  for (const [name, args] of [
    ["append_note", { path: "Notes/a", content: "x" }],
    ["patch_note", { path: "Notes/a", old_text: "alpha", new_text: "beta" }],
    ["update_frontmatter", { path: "Notes/a", set: { k: 2 } }],
    ["delete_note", { path: "Notes/a" }],
  ]) {
    const r = await call(name, args);
    assert.ok(r.err, name);
    assert.match(r.text, LIMIT, name);
  }
  assert.equal(onDisk("Notes/a.md"), "---\nk: 1\n---\nalpha [[own]]\n");
});

test("a symlink in Agents/codex pointing at Notes rejects a write through it", async () => {
  const r = await call("write_note", { path: "Agents/codex/lnk/x", content: "x" });
  assert.ok(r.err);
  assert.ok(!fs.existsSync(path.join(v.dir, "Notes/x.md")));
});

test("move_note out of the root is an error; inside it leaves outside notes untouched", async () => {
  assert.ok((await call("move_note", { from: "Agents/codex/own", to: "Notes/own" })).err);
  const r = await call("move_note", { from: "Agents/codex/own", to: "Agents/codex/moved" });
  assert.ok(!r.err);
  assert.equal(JSON.parse(r.text).skippedOutOfScope, 2);
  assert.equal(onDisk("Notes/ref.md"), "[[own]]\n");
  assert.equal(onDisk("Agents/codex/inner.md"), "[[moved]]\n");
});

test("daily_note writes under Agents/codex/Daily with the configured date format", async () => {
  const r = await call("daily_note", {});
  assert.ok(!r.err);
  assert.match(JSON.parse(r.text).path, /^Agents\/codex\/Daily\/\d{4}\.\d{2}\.\d{2}\.md$/);
  assert.ok(!fs.existsSync(path.join(v.dir, "Journal")));
});

test("read_note, search_notes and get_backlinks work on notes outside the root", async () => {
  assert.match((await call("read_note", { path: "Notes/a" })).text, /alpha/);
  assert.equal(JSON.parse((await call("search_notes", { query: "alpha" })).text)[0].path, "Notes/a.md");
  assert.ok(JSON.parse((await call("get_backlinks", { path: "Agents/codex/moved" })).text).length >= 0);
});

test("server exits non-zero for an invalid agent name", () => {
  const r = spawnSync("node", [SERVER, v.dir, "--agent", "../x"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Invalid agent name/);
});
