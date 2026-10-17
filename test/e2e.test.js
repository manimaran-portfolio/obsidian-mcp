import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tmpVault } from "./helpers.js";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server.js");
const v = tmpVault({
  "A.md": "---\ntags: [x]\n---\nhello #inline [[B]]\n",
  "B.md": "world\n",
  "in/n.md": "needle\n",
  "out/n.md": "needle\n",
  "big.md": "q".repeat(300),
});
const outside = fs.mkdtempSync(path.join(path.dirname(v.dir), "obs-e2e-out-"));
fs.writeFileSync(path.join(outside, "secret.md"), "secret");
fs.symlinkSync(outside, path.join(v.dir, "escape"));
fs.writeFileSync(path.join(v.dir, ".obsidian/daily-notes.json"), JSON.stringify({ folder: "Journal", format: "YYYY.MM.DD" }));

const client = new Client({ name: "t", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: [SERVER, v.dir] }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { err: !!r.isError, text: r.content[0].text };
};
const json = async (name, args) => JSON.parse((await call(name, args)).text);
const onDisk = (rel) => fs.readFileSync(path.join(v.dir, rel), "utf8");

test.after(async () => {
  await client.close();
  v.cleanup();
  fs.rmSync(outside, { recursive: true, force: true });
});

test("lists 13 tools", async () => {
  assert.equal((await client.listTools()).tools.length, 13);
});

test("read, search, tags, backlinks", async () => {
  assert.match((await call("read_note", { path: "A" })).text, /hello/);
  assert.equal((await json("search_notes", { query: "WORLD" }))[0].path, "B.md");
  assert.deepEqual(await json("list_tags"), { x: 1, inline: 1 });
  assert.deepEqual(await json("get_backlinks", { path: "B" }), [{ path: "A.md", link: "[[B]]", ambiguous: false }]);
});

test("read_note max_chars truncates with a marker", async () => {
  const r = await call("read_note", { path: "big", max_chars: 20 });
  assert.equal(r.text, "q".repeat(20) + "\n\n[truncated: showing 20 of 300 chars]");
});

test("search_notes folder filter", async () => {
  assert.deepEqual((await json("search_notes", { query: "needle", folder: "in" })).map((r) => r.path), ["in/n.md"]);
});

test("write_note refuses to overwrite unless asked", async () => {
  assert.equal((await call("write_note", { path: "w", content: "one" })).err, false);
  const second = await call("write_note", { path: "w", content: "two" });
  assert.ok(second.err);
  assert.match(second.text, /Note exists: w\.md; pass overwrite=true/);
  assert.equal(onDisk("w.md"), "one");
  await call("write_note", { path: "w", content: "two", overwrite: true });
  assert.equal(onDisk("w.md"), "two");
});

test("patch/append/frontmatter", async () => {
  await call("write_note", { path: "sub/N", content: "one two two\n" });
  assert.ok((await call("patch_note", { path: "sub/N", old_text: "two", new_text: "2" })).err, "ambiguous patch rejected");
  await call("patch_note", { path: "sub/N", old_text: "two", new_text: "2", replace_all: true });
  await call("append_note", { path: "sub/N", content: "tail" });
  assert.equal(onDisk("sub/N.md"), "one 2 2\ntail");
  await call("update_frontmatter", { path: "sub/N", set: { status: "done" } });
  assert.equal((await json("get_frontmatter", { path: "sub/N" })).status, "done");
});

test("move with a duplicate basename reports skippedAmbiguous", async () => {
  await call("write_note", { path: "a/Dup", content: "" });
  await call("write_note", { path: "b/Dup", content: "" });
  await call("write_note", { path: "ref", content: "[[Dup]] [[a/Dup]]" });
  const r = await json("move_note", { from: "a/Dup", to: "a/Renamed" });
  assert.deepEqual(r.skippedAmbiguous, ["ref.md"]);
  assert.equal(onDisk("ref.md"), "[[Dup]] [[a/Renamed]]");
});

test("move rewrites links; delete goes to .trash", async () => {
  await call("move_note", { from: "B", to: "folder/C" });
  assert.match(onDisk("A.md"), /\[\[C\]\]/);
  await call("delete_note", { path: "folder/C" });
  assert.ok(!fs.existsSync(path.join(v.dir, "folder/C.md")));
  assert.equal(fs.readdirSync(path.join(v.dir, ".trash")).length, 1);
});

test("traversal, protected dirs and symlink escape are rejected without leaking the vault path", async () => {
  for (const [name, args] of [
    ["read_note", { path: "../../etc/passwd" }],
    ["write_note", { path: ".obsidian/x", content: "x" }],
    ["read_note", { path: "escape/secret" }],
    ["write_note", { path: "escape/new", content: "x" }],
    ["read_note", { path: "missing" }],
  ]) {
    const r = await call(name, args);
    assert.ok(r.err, `${name} ${JSON.stringify(args)}`);
    assert.ok(!r.text.includes(v.dir), r.text);
  }
  assert.ok(!fs.existsSync(path.join(outside, "new.md")));
});

test("daily note uses obsidian config, creates and appends", async () => {
  const r = await json("daily_note", { date: "2026-01-02", append: "- task" });
  assert.equal(r.path, "Journal/2026.01.02.md");
  assert.match(r.content, /- task/);
});
