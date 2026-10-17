import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Vault } from "../vault.js";
import { tmpVault } from "./helpers.js";

const setup = (files) => {
  const v = tmpVault(files);
  return { v, vault: new Vault(v.dir), read: (rel) => fs.readFileSync(path.join(v.dir, rel), "utf8") };
};

// ---- Task 3: atomic writes, overwrite default, sanitized errors ----

test("write defaults to no-overwrite and errors with a hint", async () => {
  const { v, vault, read } = setup({ "A.md": "old" });
  await assert.rejects(vault.write("A", "new"), /Note exists: A\.md; pass overwrite=true to replace/);
  assert.equal(read("A.md"), "old");
  v.cleanup();
});

test("overwrite=true replaces the note", async () => {
  const { v, vault, read } = setup({ "A.md": "old" });
  await vault.write("A", "new", { overwrite: true });
  assert.equal(read("A.md"), "new");
  v.cleanup();
});

test("no temp files remain after writes", async () => {
  const { v, vault } = setup({});
  await vault.write("n", "1");
  await vault.write("n", "2", { overwrite: true });
  await vault.write("n", "3").catch(() => {});
  assert.deepEqual(fs.readdirSync(v.dir).sort(), [".obsidian", "n.md"]);
  v.cleanup();
});

test("no temp file remains after a failed rename", async () => {
  const { v, vault } = setup({ "x.md/inner.md": "dir in the way" });
  await assert.rejects(vault.write("x", "data", { overwrite: true }));
  assert.deepEqual(fs.readdirSync(v.dir).sort(), [".obsidian", "x.md"]);
  v.cleanup();
});

test("append works on empty and no-trailing-newline notes", async () => {
  const { v, vault, read } = setup({ "e.md": "", "t.md": "no newline" });
  await vault.append("e", "a");
  await vault.append("t", "b");
  assert.equal(read("e.md"), "a");
  assert.equal(read("t.md"), "no newline\nb");
  v.cleanup();
});

test("frontmatter update on a CRLF note keeps the body", async () => {
  const { v, vault, read } = setup({ "c.md": "---\r\na: 1\r\n---\r\nbody line\r\n" });
  await vault.updateFrontmatter("c", { b: 2 });
  assert.match(read("c.md"), /body line/);
  assert.deepEqual(await vault.frontmatter("c"), { a: 1, b: 2 });
  v.cleanup();
});

test("frontmatter on a note with none or empty", async () => {
  const { v, vault } = setup({ "n.md": "just text", "z.md": "" });
  assert.deepEqual(await vault.frontmatter("n"), {});
  assert.deepEqual(await vault.frontmatter("z"), {});
  v.cleanup();
});

test("errors never contain the absolute vault path", async () => {
  const { v, vault } = setup({ "d.md/i.md": "x" });
  const ops = [
    () => vault.read("missing"),
    () => vault.patch("missing", "a", "b"),
    () => vault.trash("missing"),
    () => vault.move("missing", "other"),
    () => vault.append("d", "x"),
    () => vault.read("../../etc/passwd"),
    () => vault.write(".obsidian/x", "x"),
  ];
  for (const op of ops) {
    await op().then(
      () => assert.fail("expected rejection"),
      (e) => assert.ok(!e.message.includes(v.dir), e.message),
    );
  }
  v.cleanup();
});

test("missing note error is a one-line vault-relative message", async () => {
  const { v, vault } = setup({});
  await assert.rejects(vault.read("nope"), /^Error: Note not found: nope\.md$/);
  v.cleanup();
});

test("symlinked file pointing outside the vault cannot be read or written", async () => {
  const { v, vault } = setup({});
  fs.symlinkSync("/etc/hostname", path.join(v.dir, "link.md"));
  await assert.rejects(vault.read("link"), /escapes vault/);
  await assert.rejects(vault.write("link", "x", { overwrite: true }), /escapes vault/);
  v.cleanup();
});

// ---- Task 4: bounded output and ranked search ----

test("read truncates with a marker stating the total", async () => {
  const { v, vault } = setup({ "big.md": "x".repeat(100) });
  const out = await vault.read("big", { maxChars: 10 });
  assert.equal(out, "x".repeat(10) + "\n\n[truncated: showing 10 of 100 chars]");
  v.cleanup();
});

test("read under the cap is returned unchanged", async () => {
  const { v, vault } = setup({ "s.md": "small" });
  assert.equal(await vault.read("s", { maxChars: 10 }), "small");
  assert.equal(await vault.read("s"), "small");
  v.cleanup();
});

test("default read cap is 50000 chars", async () => {
  const { v, vault } = setup({ "h.md": "y".repeat(50001) });
  assert.match(await vault.read("h"), /\[truncated: showing 50000 of 50001 chars\]$/);
  v.cleanup();
});

test("list caps at 500 entries with a note", async () => {
  const files = Object.fromEntries(Array.from({ length: 510 }, (_, i) => [`d/f${String(i).padStart(3, "0")}.md`, ""]));
  const { v, vault } = setup(files);
  const out = await vault.list("d");
  assert.equal(out.length, 501);
  assert.equal(out[500], "… 10 more entries not shown");
  v.cleanup();
});

test("search ranks a filename match before a body-only match", async () => {
  const { v, vault } = setup({ "a-body.md": "foo foo foo", "foo.md": "nothing" });
  assert.deepEqual((await vault.search("foo")).map((r) => r.path), ["foo.md", "a-body.md"]);
  v.cleanup();
});

test("search ranks more occurrences higher", async () => {
  const { v, vault } = setup({ "one.md": "foo", "three.md": "foo foo foo", "two.md": "foo foo" });
  assert.deepEqual((await vault.search("foo")).map((r) => r.path), ["three.md", "two.md", "one.md"]);
  v.cleanup();
});

test("search folder filter excludes other folders", async () => {
  const { v, vault } = setup({ "in/a.md": "foo", "out/b.md": "foo", "inside.md": "foo" });
  assert.deepEqual((await vault.search("foo", { folder: "in" })).map((r) => r.path), ["in/a.md"]);
  v.cleanup();
});

test("search limit is applied after ranking", async () => {
  const { v, vault } = setup({ "a.md": "foo", "b.md": "foo foo", "c.md": "foo foo foo" });
  assert.deepEqual((await vault.search("foo", { limit: 2 })).map((r) => r.path), ["c.md", "b.md"]);
  v.cleanup();
});

test("frontmatter update on a note over the read cap does not truncate it", async () => {
  const body = "z".repeat(60000);
  const { v, vault, read } = setup({ "long.md": `---\na: 1\n---\n${body}\n` });
  await vault.updateFrontmatter("long", { b: 2 });
  assert.ok(read("long.md").includes(body));
  v.cleanup();
});
