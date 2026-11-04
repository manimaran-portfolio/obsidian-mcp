import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Paths } from "../paths.js";
import { tmpVault } from "./helpers.js";

test("resolves normal and unicode/space paths inside the vault", async () => {
  const v = tmpVault({ "Projects/Café (2026).md": "x" });
  const p = new Paths(v.dir);
  assert.equal(await p.resolve("Projects/Café (2026).md"), path.join(v.dir, "Projects/Café (2026).md"));
  assert.equal(await p.resolve("New Folder/new note.md", { write: true }), path.join(v.dir, "New Folder/new note.md"));
  v.cleanup();
});

test("rejects ../ traversal", async () => {
  const v = tmpVault();
  await assert.rejects(new Paths(v.dir).resolve("../../etc/passwd"), /escapes vault/);
  v.cleanup();
});

test("rejects a symlinked directory pointing outside", async () => {
  const v = tmpVault();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "obs-out-"));
  fs.writeFileSync(path.join(outside, "x.md"), "secret");
  fs.symlinkSync(outside, path.join(v.dir, "out"));
  const p = new Paths(v.dir);
  await assert.rejects(p.resolve("out/x.md"), /escapes vault/);
  await assert.rejects(p.resolve("out/new.md", { write: true }), /escapes vault/);
  fs.rmSync(outside, { recursive: true, force: true });
  v.cleanup();
});

test("rejects a dangling symlink used as a new-note path", async () => {
  const v = tmpVault();
  fs.symlinkSync("/nonexistent-outside/x.md", path.join(v.dir, "new.md"));
  await assert.rejects(new Paths(v.dir).resolve("new.md", { write: true }), /escapes vault/);
  v.cleanup();
});

test("allows a symlink that stays inside the vault", async () => {
  const v = tmpVault({ "real.md": "x" });
  fs.symlinkSync(path.join(v.dir, "real.md"), path.join(v.dir, "alias.md"));
  assert.ok(await new Paths(v.dir).resolve("alias.md"));
  v.cleanup();
});

test("blocks writes to protected dirs but allows reading .obsidian", async () => {
  const v = tmpVault();
  const p = new Paths(v.dir);
  for (const d of [".obsidian", ".git", ".trash"]) await assert.rejects(p.resolve(`${d}/x`, { write: true }), /protected/);
  assert.ok(await p.resolve(".obsidian/app.json"));
  v.cleanup();
});

test("error messages contain no absolute path", async () => {
  const v = tmpVault();
  const p = new Paths(v.dir);
  for (const rel of ["../x", ".obsidian/x"]) {
    await p.resolve(rel, { write: true }).catch((e) => assert.ok(!e.message.includes(v.dir)));
  }
  v.cleanup();
});

test("scoped write resolves inside the write root, even when the root does not exist yet", async () => {
  const v = tmpVault();
  const p = new Paths(v.dir, { writeRoot: "Agents/codex" });
  assert.equal(await p.resolve("Agents/codex/a/b.md", { write: true }), path.join(v.dir, "Agents/codex/a/b.md"));
  v.cleanup();
});

test("scoped write outside the root is rejected, including a sibling prefix and ../ back-outs", async () => {
  const v = tmpVault();
  const p = new Paths(v.dir, { writeRoot: "Agents/codex" });
  for (const rel of ["Notes/x.md", "Agents/codex2/x.md", "Agents/codex/../other/x.md"]) {
    await assert.rejects(p.resolve(rel, { write: true }), /Writes are limited to Agents\/codex\//, rel);
  }
  v.cleanup();
});

test("scoped mode does not restrict reads", async () => {
  const v = tmpVault({ "Notes/x.md": "x" });
  const p = new Paths(v.dir, { writeRoot: "Agents/codex" });
  assert.equal(await p.resolve("Notes/x.md"), path.join(v.dir, "Notes/x.md"));
  v.cleanup();
});

test("a symlink inside the root pointing at another vault folder is rejected for writes", async () => {
  const v = tmpVault({ "Notes/keep.md": "k", "Agents/codex/.keep": "" });
  fs.symlinkSync(path.join(v.dir, "Notes"), path.join(v.dir, "Agents/codex/lnk"));
  const p = new Paths(v.dir, { writeRoot: "Agents/codex" });
  await assert.rejects(p.resolve("Agents/codex/lnk/x.md", { write: true }), /Writes are limited to Agents\/codex\//);
  v.cleanup();
});

test("canWrite reports scope", async () => {
  const v = tmpVault();
  const p = new Paths(v.dir, { writeRoot: "Agents/codex" });
  assert.equal(await p.canWrite("Agents/codex/x.md"), true);
  assert.equal(await p.canWrite("Notes/x.md"), false);
  v.cleanup();
});

test("unscoped Paths is unchanged", async () => {
  const v = tmpVault();
  const p = new Paths(v.dir);
  assert.equal(await p.resolve("Notes/x.md", { write: true }), path.join(v.dir, "Notes/x.md"));
  assert.equal(await p.canWrite("Notes/x.md"), true);
  v.cleanup();
});

test("a symlinked write root cannot redirect the scope onto other vault folders", async () => {
  for (const [link, target, files] of [
    ["Agents", "Notes", { "Notes/a.md": "a" }],
    ["Agents/codex", "Notes", { "Notes/a.md": "a", "Agents/.keep": "" }],
    ["Agents/codex", "Agents/other", { "Agents/other/o.md": "o" }],
  ]) {
    const v = tmpVault(files);
    fs.symlinkSync(path.join(v.dir, target), path.join(v.dir, link));
    const p = new Paths(v.dir, { writeRoot: "Agents/codex" });
    await assert.rejects(p.resolve("Agents/codex/a.md", { write: true }), /Writes are limited to Agents\/codex\//, `${link} -> ${target}`);
    v.cleanup();
  }
});

test("extra write roots allow those folders only, still rejecting symlink escapes", async () => {
  const v = tmpVault({ "Notes/keep.md": "k", "Learning/a.md": "a" });
  fs.symlinkSync(path.join(v.dir, "Notes"), path.join(v.dir, "Learning/lnk"));
  const p = new Paths(v.dir, { writeRoot: "Agents/codex", extraWriteRoots: ["Learning"] });
  assert.equal(await p.resolve("Learning/new.md", { write: true }), path.join(v.dir, "Learning/new.md"));
  assert.equal(await p.resolve("Agents/codex/x.md", { write: true }), path.join(v.dir, "Agents/codex/x.md"));
  await assert.rejects(p.resolve("Notes/x.md", { write: true }), /Writes are limited/);
  await assert.rejects(p.resolve("Learning2/x.md", { write: true }), /Writes are limited/);
  await assert.rejects(p.resolve("Learning/lnk/x.md", { write: true }), /Writes are limited/);
  v.cleanup();
});
