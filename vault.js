import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";

const PROTECTED = new Set([".obsidian", ".git", ".trash"]);

export class Vault {
  constructor(root) {
    this.root = path.resolve(root);
  }

  /** Resolve a vault-relative path; reject escapes. `write` also blocks protected dirs. */
  resolve(rel, { write = false } = {}) {
    const abs = path.resolve(this.root, rel || ".");
    const r = path.relative(this.root, abs);
    if (r.startsWith("..") || path.isAbsolute(r)) throw new Error(`Path escapes vault: ${rel}`);
    if (write && PROTECTED.has(r.split(path.sep)[0])) throw new Error(`Path is protected: ${rel}`);
    return abs;
  }

  rel(abs) {
    return path.relative(this.root, abs).split(path.sep).join("/");
  }

  notePath(rel) {
    return /\.md$/i.test(rel) ? rel : `${rel}.md`;
  }

  async walk(dir = this.root, out = []) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") && PROTECTED.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await this.walk(p, out);
      else if (e.isFile() && /\.md$/i.test(e.name)) out.push(this.rel(p));
    }
    return out;
  }

  async list(dir = "") {
    const abs = this.resolve(dir);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    return entries
      .filter((e) => !PROTECTED.has(e.name))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
  }

  async read(rel) {
    return fs.readFile(this.resolve(this.notePath(rel)), "utf8");
  }

  async write(rel, content, { overwrite = true } = {}) {
    const abs = this.resolve(this.notePath(rel), { write: true });
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, { encoding: "utf8", flag: overwrite ? "w" : "wx" });
    return this.rel(abs);
  }

  async append(rel, content) {
    const abs = this.resolve(this.notePath(rel), { write: true });
    await fs.mkdir(path.dirname(abs), { recursive: true });
    let prefix = "";
    try {
      const cur = await fs.readFile(abs, "utf8");
      if (cur && !cur.endsWith("\n")) prefix = "\n";
    } catch {}
    await fs.appendFile(abs, prefix + content, "utf8");
    return this.rel(abs);
  }

  /** Replace exactly one occurrence (or all, if replaceAll). */
  async patch(rel, oldStr, newStr, replaceAll = false) {
    const abs = this.resolve(this.notePath(rel), { write: true });
    const cur = await fs.readFile(abs, "utf8");
    const count = cur.split(oldStr).length - 1;
    if (count === 0) throw new Error("old_text not found");
    if (count > 1 && !replaceAll) throw new Error(`old_text matches ${count} times; add context or set replace_all`);
    await fs.writeFile(abs, cur.split(oldStr).join(newStr), "utf8");
    return count;
  }

  /** Soft delete: move into .trash so it's recoverable. */
  async trash(rel) {
    const src = this.resolve(this.notePath(rel), { write: true });
    await fs.stat(src);
    const dest = this.resolve(path.join(".trash", `${Date.now()}-${path.basename(src)}`));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(src, dest);
    return this.rel(dest);
  }

  /** Move/rename; optionally rewrite [[wikilinks]] across the vault. */
  async move(from, to, updateLinks = true) {
    const src = this.resolve(this.notePath(from), { write: true });
    const dest = this.resolve(this.notePath(to), { write: true });
    await fs.stat(src);
    try {
      await fs.stat(dest);
      throw new Error(`Destination exists: ${to}`);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
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
        const abs = this.resolve(f);
        const text = await fs.readFile(abs, "utf8");
        const next = text.replace(re, (m, target, anchor, alias) => {
          const t = target.trim();
          if (t === oldBase) return `[[${newBase}${anchor}${alias}]]`;
          if (t === oldRel) return `[[${newRel}${anchor}${alias}]]`;
          return m;
        });
        if (next !== text) {
          await fs.writeFile(abs, next, "utf8");
          updated++;
        }
      }
    }
    return { to: this.rel(dest), linksUpdatedInFiles: updated };
  }

  async search(query, { limit = 20, context = 80, caseSensitive = false } = {}) {
    const q = caseSensitive ? query : query.toLowerCase();
    const results = [];
    for (const f of await this.walk()) {
      if (results.length >= limit) break;
      const nameHit = (caseSensitive ? f : f.toLowerCase()).includes(q);
      const text = await fs.readFile(this.resolve(f), "utf8");
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
    const abs = this.resolve(this.notePath(rel), { write: true });
    const parsed = matter(await fs.readFile(abs, "utf8"));
    const data = { ...parsed.data, ...updates };
    for (const k of remove) delete data[k];
    await fs.writeFile(abs, matter.stringify(parsed.content, data), "utf8");
    return data;
  }

  async tags() {
    const counts = {};
    const add = (t) => (counts[t] = (counts[t] || 0) + 1);
    for (const f of await this.walk()) {
      const { data, content } = matter(await fs.readFile(this.resolve(f), "utf8"));
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
      const text = await fs.readFile(this.resolve(f), "utf8");
      if ([...text.matchAll(re)].some((m) => [target, base].includes(m[1].trim()))) out.push(f);
    }
    return out;
  }

  dailyPath(date = new Date(), folder = "Daily") {
    const d = date.toLocaleDateString("en-CA"); // YYYY-MM-DD, local tz
    return `${folder}/${d}.md`;
  }
}
