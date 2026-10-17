import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import matter from "gray-matter";
import { Paths } from "./paths.js";

const SKIP_DIRS = new Set([".obsidian", ".git", ".trash"]);

export class Vault {
  constructor(root) {
    this.paths = new Paths(root);
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
      else await fs.link(tmp, abs);
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }

  async walk(dir = this.root, out = []) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await this.walk(p, out);
      else if (e.isFile() && /\.md$/i.test(e.name)) out.push(this.rel(p));
    }
    return out;
  }

  async list(dir = "") {
    return this.#guard(dir, async () => {
      const entries = await fs.readdir(await this.paths.resolve(dir), { withFileTypes: true });
      return entries
        .filter((e) => !SKIP_DIRS.has(e.name))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort();
    });
  }

  async read(rel) {
    const r = this.notePath(rel);
    return this.#guard(r, async () => fs.readFile(await this.paths.resolve(r), "utf8"));
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
      await this.#atomicWrite(abs, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + content, true);
      return this.rel(abs);
    });
  }

  /** Replace exactly one occurrence (or all, if replaceAll). */
  async patch(rel, oldStr, newStr, replaceAll = false) {
    const r = this.notePath(rel);
    const abs = await this.paths.resolve(r, { write: true });
    return this.#guard(r, async () => {
      const cur = await fs.readFile(abs, "utf8");
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
    const dest = await this.paths.resolve(path.join(".trash", `${Date.now()}-${path.basename(src)}`));
    return this.#guard(r, async () => {
      await fs.stat(src);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.rename(src, dest);
      return this.rel(dest);
    });
  }

  /** Move/rename; optionally rewrite [[wikilinks]] across the vault. */
  async move(from, to, updateLinks = true) {
    const fr = this.notePath(from);
    const tr = this.notePath(to);
    const src = await this.paths.resolve(fr, { write: true });
    const dest = await this.paths.resolve(tr, { write: true });
    return this.#guard(fr, async () => {
      await fs.stat(src);
      const exists = await fs.stat(dest).then(() => true, () => false);
      if (exists) throw new Error(`Destination exists: ${tr}`);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.rename(src, dest);
      let updated = 0;
      const oldBase = path.basename(src, ".md");
      const newBase = path.basename(dest, ".md");
      const oldRel = this.rel(src).replace(/\.md$/i, "");
      const newRel = this.rel(dest).replace(/\.md$/i, "");
      if (updateLinks && (oldBase !== newBase || oldRel !== newRel)) {
        const re = /\[\[([^\]|#]+)((?:#[^\]|]*)?)((?:\|[^\]]*)?)\]\]/g;
        for (const f of await this.walk()) {
          const abs = await this.paths.resolve(f, { write: true });
          const text = await fs.readFile(abs, "utf8");
          const next = text.replace(re, (m, target, anchor, alias) => {
            const t = target.trim();
            if (t === oldBase) return `[[${newBase}${anchor}${alias}]]`;
            if (t === oldRel) return `[[${newRel}${anchor}${alias}]]`;
            return m;
          });
          if (next !== text) {
            await this.#atomicWrite(abs, next, true);
            updated++;
          }
        }
      }
      return { to: this.rel(dest), linksUpdatedInFiles: updated };
    });
  }

  async search(query, { limit = 20, context = 80, caseSensitive = false } = {}) {
    const q = caseSensitive ? query : query.toLowerCase();
    const results = [];
    for (const f of await this.walk()) {
      if (results.length >= limit) break;
      const nameHit = (caseSensitive ? f : f.toLowerCase()).includes(q);
      const text = await this.read(f);
      const hay = caseSensitive ? text : text.toLowerCase();
      const idx = hay.indexOf(q);
      if (nameHit || idx >= 0) {
        const line = idx >= 0 ? text.slice(0, idx).split("\n").length : null;
        const snippet = idx >= 0 ? text.slice(Math.max(0, idx - context), idx + q.length + context).replace(/\s+/g, " ") : null;
        results.push({ path: f, line, snippet });
      }
    }
    return results;
  }

  async frontmatter(rel) {
    return matter(await this.read(rel)).data;
  }

  async updateFrontmatter(rel, updates, remove = []) {
    const parsed = matter(await this.read(rel));
    const data = { ...parsed.data, ...updates };
    for (const k of remove) delete data[k];
    await this.write(rel, matter.stringify(parsed.content, data), { overwrite: true });
    return data;
  }

  async tags() {
    const counts = {};
    const add = (t) => (counts[t] = (counts[t] || 0) + 1);
    for (const f of await this.walk()) {
      const { data, content } = matter(await this.read(f));
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
    const re = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
    const out = [];
    for (const f of await this.walk()) {
      if (f.replace(/\.md$/i, "") === target) continue;
      const text = await this.read(f);
      if ([...text.matchAll(re)].some((m) => [target, base].includes(m[1].trim()))) out.push(f);
    }
    return out;
  }

  dailyPath(date = new Date(), folder = "Daily") {
    const d = date.toLocaleDateString("en-CA"); // YYYY-MM-DD, local tz
    return `${folder}/${d}.md`;
  }
}
