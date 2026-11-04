import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { parseFrontmatter, splitNote, updateFrontmatterText } from "./frontmatter.js";
import { Paths } from "./paths.js";
import { extractLinks, rewriteLinks } from "./links.js";

const SKIP_DIRS = new Set([".obsidian", ".git", ".trash"]);
// fs.link unsupported here (exFAT/FAT, some FUSE and network mounts)
const NO_LINK = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EMLINK"]);
const lc = (s) => s.toLowerCase();

export class Vault {
  constructor(root, { agent, writeAlso = [] } = {}) {
    this.agent = agent ?? null;
    this.writeRoot = agent ? `Agents/${agent}` : null;
    this.paths = new Paths(root, { writeRoot: this.writeRoot, extraWriteRoots: writeAlso });
    this.root = this.paths.root;
  }

  notePath(rel) {
    return /\.md$/i.test(rel) ? rel : `${rel}.md`;
  }

  rel(abs) {
    return this.paths.rel(abs);
  }

  /** Run `fn`; rethrow fs errors as one-line, vault-relative messages (never absolute paths). */
  async #guard(rel, fn) {
    try {
      return await fn();
    } catch (e) {
      if (e.code === "ENOENT") throw new Error(`Note not found: ${rel}`);
      if (e.code === "EISDIR" || e.code === "ENOTDIR") throw new Error(`Not a note: ${rel}`);
      if (e.code === "ENOTEMPTY") throw new Error(`Not a note: ${rel}`);
      throw new Error(String(e.message).split(this.root).join("<vault>"));
    }
  }

  /** Write via temp file in the same dir, then rename (or link, when refusing to overwrite). */
  async #atomicWrite(abs, content, overwrite) {
    const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${crypto.randomBytes(4).toString("hex")}.tmp`);
    try {
      await fs.writeFile(tmp, content, { encoding: "utf8", flag: "wx" });
      if (overwrite) await fs.rename(tmp, abs);
      else {
        try {
          await fs.link(tmp, abs);
        } catch (e) {
          if (!NO_LINK.has(e.code)) throw e;
          await fs.writeFile(abs, content, { encoding: "utf8", flag: "wx" }); // exclusive, not atomic
        }
      }
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }

  async walk(dir = this.root, out = []) {
    for (const e of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await this.walk(p, out);
      else if (e.isFile() && /\.md$/i.test(e.name)) out.push(this.rel(p));
    }
    return out;
  }

  async list(dir = "") {
    const MAX = 500;
    return this.#guard(dir, async () => {
      const entries = await fs.readdir(await this.paths.resolve(dir), { withFileTypes: true });
      return entries
        .filter((e) => !SKIP_DIRS.has(e.name))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort();
    }).then((all) => (all.length > MAX ? [...all.slice(0, MAX), `… ${all.length - MAX} more entries not shown`] : all));
  }

  /** Full, untruncated content. Internal callers that write back must use this. */
  async readFull(rel) {
    const r = this.notePath(rel);
    return this.#guard(r, async () => fs.readFile(await this.paths.resolve(r), "utf8"));
  }

  /** Content capped at `maxChars` (default 50000), with a marker stating the total when cut. */
  async read(rel, { maxChars = 50000 } = {}) {
    const text = await this.readFull(rel);
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n\n[truncated: showing ${maxChars} of ${text.length} chars]` : text;
  }

  async write(rel, content, { overwrite = false } = {}) {
    const r = this.notePath(rel);
    const abs = await this.paths.resolve(r, { write: true });
    return this.#guard(r, async () => {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      try {
        await this.#atomicWrite(abs, content, overwrite);
      } catch (e) {
        if (e.code === "EEXIST") throw new Error(`Note exists: ${r}; pass overwrite=true to replace`);
        throw e;
      }
      return this.rel(abs);
    });
  }

  async append(rel, content) {
    const r = this.notePath(rel);
    const abs = await this.paths.resolve(r, { write: true });
    return this.#guard(r, async () => {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      let cur = "";
      try {
        cur = await fs.readFile(abs, "utf8");
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      const eol = cur.includes("\r\n") ? "\r\n" : "\n";
      const add = eol === "\r\n" ? content.replace(/\r?\n/g, eol) : content;
      await this.#atomicWrite(abs, cur + (cur && !cur.endsWith("\n") ? eol : "") + add, true);
      return this.rel(abs);
    });
  }

  /** Replace exactly one occurrence (or all, if replaceAll). */
  async patch(rel, oldStr, newStr, replaceAll = false) {
    const r = this.notePath(rel);
    const abs = await this.paths.resolve(r, { write: true });
    return this.#guard(r, async () => {
      const cur = await fs.readFile(abs, "utf8");
      if (cur.includes("\r\n")) {
        oldStr = oldStr.replace(/\r?\n/g, "\r\n");
        newStr = newStr.replace(/\r?\n/g, "\r\n");
      }
      const count = cur.split(oldStr).length - 1;
      if (count === 0) throw new Error("old_text not found");
      if (count > 1 && !replaceAll) throw new Error(`old_text matches ${count} times; add context or set replace_all`);
      await this.#atomicWrite(abs, cur.split(oldStr).join(newStr), true);
      return count;
    });
  }

  /** Soft delete: move into .trash so it's recoverable. */
  async trash(rel) {
    const r = this.notePath(rel);
    const src = await this.paths.resolve(r, { write: true });
    const dest = await this.paths.resolve(path.join(".trash", `${Date.now()}-${crypto.randomBytes(3).toString("hex")}-${path.basename(src)}`));
    return this.#guard(r, async () => {
      await fs.stat(src);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.rename(src, dest);
      return this.rel(dest);
    });
  }

  /** lowercased basename (no .md) -> vault paths (no .md) of all notes sharing it (Obsidian matches case-insensitively). */
  async #basenameIndex() {
    const idx = new Map();
    for (const f of await this.walk()) {
      const rel = f.replace(/\.md$/i, "");
      const base = lc(path.basename(rel));
      idx.set(base, [...(idx.get(base) ?? []), rel]);
    }
    return idx;
  }

  /**
   * Move/rename; optionally rewrite links vault-wide. Basename-keyed links are left alone
   * (and reported in skippedAmbiguous) when the old basename also names another note.
   */
  async move(from, to, updateLinks = true) {
    const fr = this.notePath(from);
    const tr = this.notePath(to);
    const src = await this.paths.resolve(fr, { write: true });
    const dest = await this.paths.resolve(tr, { write: true });
    return this.#guard(fr, async () => {
      await fs.stat(src);
      const oldRel = this.rel(src).replace(/\.md$/i, "");
      const newRel = this.rel(dest).replace(/\.md$/i, "");
      const oldBase = path.basename(oldRel);
      const newBase = path.basename(newRel);
      const before = await this.#basenameIndex();
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await this.#moveExclusive(src, dest, tr);
      const rewritten = [];
      const skipped = new Set();
      let outOfScope = 0;
      try {
        if (updateLinks && oldRel !== newRel) {
          const oldAmbiguous = (before.get(lc(oldBase)) ?? []).length > 1;
          const newBaseTaken = (before.get(lc(newBase)) ?? []).some((r) => r !== oldRel);
          for (const f of await this.walk()) {
            const inScope = await this.paths.canWrite(f);
            const abs = await this.paths.resolve(f, { write: inScope });
            const text = await fs.readFile(abs, "utf8");
            const next = rewriteLinks(text, (l) => {
              if (l.target.includes("/")) return lc(l.target) === lc(oldRel) ? newRel : null;
              if (lc(l.target) !== lc(oldBase)) return null;
              if (oldAmbiguous) {
                skipped.add(f);
                return null;
              }
              return newBaseTaken ? newRel : newBase;
            });
            if (next === text) continue;
            if (!inScope) {
              outOfScope++;
              continue;
            }
            if ((await fs.readFile(abs, "utf8")) !== text) throw new Error(`${f} changed during the move`);
            await this.#atomicWrite(abs, next, true);
            rewritten.push({ abs, text });
          }
        }
      } catch (e) {
        for (const r of rewritten.reverse()) await this.#atomicWrite(r.abs, r.text, true).catch(() => {});
        await fs.rename(dest, src).catch(() => {});
        throw new Error(`Move aborted and rolled back: ${String(e.message).split(this.root).join("<vault>")}`);
      }
      return {
        to: this.rel(dest),
        linksUpdatedInFiles: rewritten.length,
        skippedAmbiguous: [...skipped].sort(),
        ...(this.writeRoot ? { skippedOutOfScope: outOfScope } : {}),
      };
    });
  }

  /** Rename without ever replacing an existing destination. */
  async #moveExclusive(src, dest, destRel) {
    try {
      await fs.link(src, dest);
      await fs.unlink(src);
    } catch (e) {
      if (e.code === "EEXIST") throw new Error(`Destination exists: ${destRel}`);
      if (!NO_LINK.has(e.code)) throw e;
      if (await fs.stat(dest).then(() => true, () => false)) throw new Error(`Destination exists: ${destRel}`);
      await fs.rename(src, dest);
    }
  }

  async search(query, { limit = 20, context = 80, caseSensitive = false, folder = "" } = {}) {
    const q = caseSensitive ? query : query.toLowerCase();
    const prefix = folder ? folder.replace(/^\/+|\/+$/g, "") + "/" : "";
    const results = [];
    for (const f of await this.walk()) {
      if (prefix && !f.startsWith(prefix)) continue;
      const nameHit = (caseSensitive ? f : f.toLowerCase()).includes(q);
      const text = await this.readFull(f);
      const hay = caseSensitive ? text : text.toLowerCase();
      const idx = hay.indexOf(q);
      if (!nameHit && idx < 0) continue;
      const occurrences = idx < 0 ? 0 : hay.split(q).length - 1;
      results.push({
        path: f,
        line: idx >= 0 ? text.slice(0, idx).split("\n").length : null,
        snippet: idx >= 0 ? text.slice(Math.max(0, idx - context), idx + q.length + context).replace(/\s+/g, " ") : null,
        score: (nameHit ? 1000 : 0) + occurrences,
      });
    }
    return results.sort((x, y) => y.score - x.score || x.path.localeCompare(y.path)).slice(0, limit);
  }

  async frontmatter(rel) {
    return parseFrontmatter(await this.readFull(rel)).data;
  }

  async updateFrontmatter(rel, updates, remove = []) {
    const { text, data } = updateFrontmatterText(await this.readFull(rel), updates, remove);
    await this.write(rel, text, { overwrite: true });
    return data;
  }

  async tags() {
    const counts = {};
    const add = (t) => (counts[t] = (counts[t] || 0) + 1);
    for (const f of await this.walk()) {
      const raw = await this.readFull(f);
      let data = {};
      let content;
      try {
        ({ data, body: content } = parseFrontmatter(raw));
      } catch {
        content = splitNote(raw).body; // unparseable frontmatter: skip its tags, still count inline ones
      }
      const fm = Array.isArray(data.tags) ? data.tags : typeof data.tags === "string" ? data.tags.split(/[,\s]+/) : [];
      new Set(fm.filter(Boolean).map((t) => String(t).replace(/^#/, ""))).forEach(add);
      const body = content.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
      new Set([...body.matchAll(/(?:^|\s)#([A-Za-z][\w/-]*)/g)].map((m) => m[1])).forEach(add);
    }
    return counts;
  }

  async backlinks(rel) {
    const target = this.notePath(rel).replace(/\.md$/i, "");
    const base = path.basename(target);
    const ambiguous = ((await this.#basenameIndex()).get(lc(base)) ?? []).length > 1;
    const out = [];
    for (const f of await this.walk()) {
      if (lc(f.replace(/\.md$/i, "")) === lc(target)) continue;
      for (const l of extractLinks(await this.readFull(f))) {
        if (l.target.includes("/")) {
          if (lc(l.target) === lc(target)) out.push({ path: f, link: l.raw, ambiguous: false });
        } else if (lc(l.target) === lc(base)) {
          out.push({ path: f, link: l.raw, ambiguous });
        }
      }
    }
    return out;
  }

  /** Daily note path: env override > .obsidian/daily-notes.json > "Daily"; format supports YYYY, MM, DD only. */
  async dailyPath(date = new Date(), { folderOverride } = {}) {
    let cfg = {};
    try {
      cfg = JSON.parse(await fs.readFile(await this.paths.resolve(".obsidian/daily-notes.json"), "utf8")) ?? {};
    } catch {}
    const supported = (f) => typeof f === "string" && f !== "" && !/[A-Za-z]/.test(f.replace(/YYYY|MM|DD/g, ""));
    const format = supported(cfg.format) ? cfg.format : "YYYY-MM-DD";
    const name = format
      .replace("YYYY", String(date.getFullYear()))
      .replace("MM", String(date.getMonth() + 1).padStart(2, "0"))
      .replace("DD", String(date.getDate()).padStart(2, "0"));
    const raw = folderOverride !== undefined ? folderOverride : typeof cfg.folder === "string" ? cfg.folder : "Daily";
    const folder = raw.replace(/^\/+|\/+$/g, "");
    return `${folder ? folder + "/" : ""}${name}.md`;
  }
}
