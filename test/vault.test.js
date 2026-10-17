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

// ---- Task 5: link-safe move and backlinks ----

test("move rewrites basename and path links, keeping alias/anchor/embed", async () => {
  const { v, vault, read } = setup({
    "src/Old.md": "x",
    "ref.md": "[[Old]] [[src/Old#h|al]] ![[Old]] [t](src/Old.md)",
  });
  const r = await vault.move("src/Old", "dst/New");
  assert.deepEqual(r, { to: "dst/New.md", linksUpdatedInFiles: 1, skippedAmbiguous: [] });
  assert.equal(read("ref.md"), "[[New]] [[dst/New#h|al]] ![[New]] [t](dst/New.md)");
  v.cleanup();
});

test("move does not rewrite links inside code fences or frontmatter", async () => {
  const text = "---\nl: \"[[Old]]\"\n---\n```\n[[Old]]\n```\n`[[Old]]` [[Old]]\n";
  const { v, vault, read } = setup({ "Old.md": "x", "ref.md": text });
  await vault.move("Old", "New");
  assert.equal(read("ref.md"), text.replace("` [[Old]]\n", "` [[New]]\n"));
  v.cleanup();
});

test("move with a duplicate basename skips basename links and reports them", async () => {
  const { v, vault, read } = setup({
    "a/Dup.md": "x",
    "b/Dup.md": "y",
    "ref.md": "[[Dup]] [[a/Dup]]",
  });
  const r = await vault.move("a/Dup", "a/Renamed");
  assert.deepEqual(r.skippedAmbiguous, ["ref.md"]);
  assert.equal(read("ref.md"), "[[Dup]] [[a/Renamed]]");
  v.cleanup();
});

test("move refuses an existing destination", async () => {
  const { v, vault } = setup({ "A.md": "a", "B.md": "b" });
  await assert.rejects(vault.move("A", "B"), /Destination exists: B\.md/);
  v.cleanup();
});

test("backlinks ignores code-fenced links and the note itself", async () => {
  const { v, vault } = setup({
    "T.md": "self [[T]]",
    "real.md": "see [[T]]",
    "code.md": "```\n[[T]]\n```\n",
  });
  assert.deepEqual(await vault.backlinks("T"), [{ path: "real.md", link: "[[T]]", ambiguous: false }]);
  v.cleanup();
});

test("backlinks flags an ambiguous basename", async () => {
  const { v, vault } = setup({ "a/T.md": "", "b/T.md": "", "r.md": "[[T]] [[a/T]]" });
  assert.deepEqual(await vault.backlinks("a/T"), [
    { path: "r.md", link: "[[T]]", ambiguous: true },
    { path: "r.md", link: "[[a/T]]", ambiguous: false },
  ]);
  v.cleanup();
});

test("backlinks flags ambiguity for a root-level note sharing a basename", async () => {
  const { v, vault } = setup({ "T.md": "", "b/T.md": "", "r.md": "[[T]]" });
  assert.deepEqual(await vault.backlinks("T"), [{ path: "r.md", link: "[[T]]", ambiguous: true }]);
  v.cleanup();
});

// ---- Task 6: config-driven daily notes ----

const d = new Date(2026, 0, 2, 12); // 2026-01-02 local
const cfg = (o) => ({ ".obsidian/daily-notes.json": typeof o === "string" ? o : JSON.stringify(o) });

test("daily path uses folder and format from daily-notes.json", async () => {
  const { v, vault } = setup(cfg({ folder: "Journal/Days", format: "YYYY.MM.DD" }));
  assert.equal(await vault.dailyPath(d), "Journal/Days/2026.01.02.md");
  v.cleanup();
});

test("daily path falls back to Daily/YYYY-MM-DD with no config", async () => {
  const { v, vault } = setup({});
  assert.equal(await vault.dailyPath(d), "Daily/2026-01-02.md");
  v.cleanup();
});

test("malformed daily-notes.json falls back without throwing", async () => {
  const { v, vault } = setup(cfg("{not json"));
  assert.equal(await vault.dailyPath(d), "Daily/2026-01-02.md");
  v.cleanup();
});

test("env folder override wins over the config folder", async () => {
  const { v, vault } = setup(cfg({ folder: "Journal", format: "YYYY-MM-DD" }));
  assert.equal(await vault.dailyPath(d, { folderOverride: "Over" }), "Over/2026-01-02.md");
  v.cleanup();
});

test("unsupported format tokens fall back to the default format", async () => {
  const { v, vault } = setup(cfg({ folder: "J", format: "dddd, MMMM Do" }));
  assert.equal(await vault.dailyPath(d), "J/2026-01-02.md");
  v.cleanup();
});

test("empty folder in config means the vault root", async () => {
  const { v, vault } = setup(cfg({ folder: "", format: "YYYY-MM-DD" }));
  assert.equal(await vault.dailyPath(d), "2026-01-02.md");
  v.cleanup();
});

test("tags skips frontmatter it cannot parse instead of failing the whole call", async () => {
  const { v, vault } = setup({
    "bad.md": "---\ntitle: a: b: c\n  - broken\nkey\n---\nbody #survives\n",
    "good.md": "---\ntags: [ok]\n---\n#inline\n",
  });
  assert.deepEqual(await vault.tags(), { ok: 1, inline: 1, survives: 1 });
  v.cleanup();
});
