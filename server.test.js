import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-mcp-"));
fs.mkdirSync(path.join(dir, ".obsidian"));
fs.writeFileSync(path.join(dir, "A.md"), "---\ntags: [x]\n---\nhello #inline [[B]]\n");
fs.writeFileSync(path.join(dir, "B.md"), "world\n");

const client = new Client({ name: "t", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["server.js", dir] }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { err: !!r.isError, text: r.content[0].text };
};

test.after(async () => {
  await client.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("lists 13 tools", async () => {
  assert.equal((await client.listTools()).tools.length, 13);
});

test("read, search, tags, backlinks", async () => {
  assert.match((await call("read_note", { path: "A" })).text, /hello/);
  assert.equal(JSON.parse((await call("search_notes", { query: "WORLD" })).text)[0].path, "B.md");
  assert.deepEqual(JSON.parse((await call("list_tags")).text), { x: 1, inline: 1 });
  assert.deepEqual(JSON.parse((await call("get_backlinks", { path: "B" })).text), ["A.md"]);
});

test("write/patch/append/frontmatter", async () => {
  await call("write_note", { path: "sub/N", content: "one two two\n" });
  assert.ok((await call("patch_note", { path: "sub/N", old_text: "two", new_text: "2" })).err, "ambiguous patch rejected");
  await call("patch_note", { path: "sub/N", old_text: "two", new_text: "2", replace_all: true });
  await call("append_note", { path: "sub/N", content: "tail" });
  assert.equal(fs.readFileSync(path.join(dir, "sub/N.md"), "utf8"), "one 2 2\ntail");
  await call("update_frontmatter", { path: "sub/N", set: { status: "done" } });
  assert.equal(JSON.parse((await call("get_frontmatter", { path: "sub/N" })).text).status, "done");
  assert.ok((await call("write_note", { path: "A", content: "x", overwrite: false })).err);
});

test("move rewrites wikilinks; delete goes to .trash", async () => {
  await call("move_note", { from: "B", to: "folder/C" });
  assert.match(fs.readFileSync(path.join(dir, "A.md"), "utf8"), /\[\[C\]\]/);
  await call("delete_note", { path: "folder/C" });
  assert.ok(!fs.existsSync(path.join(dir, "folder/C.md")));
  assert.equal(fs.readdirSync(path.join(dir, ".trash")).length, 1);
});

test("path traversal and protected dirs are rejected", async () => {
  assert.ok((await call("read_note", { path: "../../etc/passwd" })).err);
  assert.ok((await call("write_note", { path: ".obsidian/x", content: "x" })).err);
});

test("daily note created and appended", async () => {
  const r = JSON.parse((await call("daily_note", { date: "2026-01-02", append: "- task" })).text);
  assert.equal(r.path, "Daily/2026-01-02.md");
  assert.match(r.content, /- task/);
});
