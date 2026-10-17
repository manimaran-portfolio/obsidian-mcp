import fs from "node:fs";
import path from "node:path";

const PROTECTED = new Set([".obsidian", ".git", ".trash"]);

const inside = (root, abs) => {
  const r = path.relative(root, abs);
  return r === "" || (!r.startsWith("..") && !path.isAbsolute(r));
};

export class Paths {
  constructor(rootAbs, { writeRoot } = {}) {
    this.root = fs.realpathSync(rootAbs);
    this.writeRoot = writeRoot ?? null;
    this.writeRootAbs = writeRoot ? path.resolve(this.root, writeRoot) : null;
  }

  /** True when a write to `rel` would be allowed. */
  async canWrite(rel) {
    try {
      await this.resolve(rel, { write: true });
      return true;
    } catch {
      return false;
    }
  }

  /** Absolute path for a vault-relative `rel`, guaranteed inside the real vault root. */
  async resolve(rel, { write = false } = {}) {
    const abs = path.resolve(this.root, rel || ".");
    if (!inside(this.root, abs)) throw new Error(`Path escapes vault: ${rel}`);
    const first = path.relative(this.root, abs).split(path.sep)[0];
    if (write && PROTECTED.has(first)) throw new Error(`Path is protected: ${rel}`);
    const real = await this.#realOrParent(abs);
    if (real === null || !inside(this.root, real)) throw new Error(`Path escapes vault: ${rel}`);
    if (write && this.writeRootAbs) {
      const rootReal = await this.#realOrParent(this.writeRootAbs);
      // rootReal must equal the plain path: a symlink in the root's own chain would move the scope.
      if (!inside(this.writeRootAbs, abs) || rootReal !== this.writeRootAbs || !inside(rootReal, real)) {
        throw new Error(`Writes are limited to ${this.writeRoot}/: ${rel}`);
      }
    }
    return abs;
  }

  rel(abs) {
    return path.relative(this.root, abs).split(path.sep).join("/");
  }

  /** realpath of `abs`, or of its nearest existing ancestor plus the missing tail; null if a dangling symlink is hit. */
  async #realOrParent(abs) {
    try {
      return await fs.promises.realpath(abs);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    // Missing target. A dangling symlink must not be followed on write.
    const st = await fs.promises.lstat(abs).catch(() => null);
    if (st?.isSymbolicLink()) return null;
    const parent = path.dirname(abs);
    if (parent === abs) return abs;
    const real = await this.#realOrParent(parent);
    return real === null ? null : path.join(real, path.basename(abs));
  }
}
