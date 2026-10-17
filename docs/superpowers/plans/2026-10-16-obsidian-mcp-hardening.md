# obsidian-mcp Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make obsidian-mcp safe and correct (symlink containment, atomic writes, safe defaults, code-aware links, bounded output) without changing tool names or existing parameters.

**Architecture:** Split `vault.js` into `paths.js` (containment), `links.js` (link parsing/rewriting) and `vault.js` (note operations); `server.js` only registers tools and maps errors. Each task is test-first with `node --test` against a temporary vault.

**Tech Stack:** Node 22 (ESM), `@modelcontextprotocol/sdk` 1.32.1, `zod`, `gray-matter`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-16-obsidian-mcp-hardening-design.md`

## Global Constraints

- The 13 tool names and all existing parameters are unchanged; only optional `max_chars` (read_note) and `folder` (search_notes) are added.
- `write_note` `overwrite` defaults to `false`.
- `read_note` `max_chars` defaults to `50000`; truncated output ends with a marker stating total length.
- `list_directory` capped at 500 entries with a truncation note; `search_notes` `limit` max stays 100.
- Protected dirs for writes: `.obsidian`, `.git`, `.trash`.
- Errors: `isError` with a one-line cause using vault-relative paths only; no stack traces, no absolute host paths.
- Daily notes: read `.obsidian/daily-notes.json`; fallback `Daily/YYYY-MM-DD`; `OBSIDIAN_DAILY_FOLDER` overrides.
- Vault path via argv[2] or `OBSIDIAN_VAULT`. No agent-config edits are allowed.
- Writes are exercised only on a temporary vault; the real vault gets read-only tools only.
- Out of scope: attachments, new tools, heading-aware edits, search indexing, TypeScript, retiring mcpvault.

## Review Focus

1. A dangling symlink inside the vault (target outside, not yet existing) used as a new-note path — must be rejected, not followed on write. (Task 1)
2. Note paths with spaces, unicode and parentheses (e.g. `Projects/Café (2026).md`) — must work for every tool. (Task 1)
3. CRLF-line-ending notes and notes with no frontmatter / empty file — frontmatter tools and link parsing must not corrupt or crash. (Tasks 2, 3)
4. Links inside code fences, inline code and frontmatter — must not be counted as backlinks or rewritten on move. (Task 2)
5. Two notes with the same basename in different folders — move/backlinks must report ambiguity, not silently pick one. (Task 5)

---

## File Structure

| File | Responsibility |
|---|---|
| `paths.js` (create) | Path resolution and realpath containment |
| `links.js` (create) | Code-aware link extraction and rewriting |
| `vault.js` (modify) | Note operations built on the two above |
| `server.js` (modify) | Tool registration, error mapping, new optional params |
| `test/paths.test.js`, `test/links.test.js`, `test/vault.test.js` (create) | Unit tests |
| `server.test.js` → `test/e2e.test.js` (move + modify) | Stdio end-to-end |
| `test/helpers.js` (create) | `tmpVault(files)` returning `{dir, cleanup}` |

`package.json` script `test` becomes `node --test test/`.

### Task 1: Path containment (`paths.js`)

**Files:** Create `paths.js`, `test/helpers.js`, `test/paths.test.js`; modify `package.json` (test script).

**Interfaces:**
- Produces: `class Paths { constructor(rootAbs: string) ; async resolve(rel: string, opts?: {write?: boolean}): Promise<string> ; rel(abs: string): string }`. `resolve` returns an absolute path guaranteed inside the real root; throws `Error("Path escapes vault: <rel>")` or `Error("Path is protected: <rel>")`. Root is `fs.realpathSync`'d in the constructor.
- Produces (`test/helpers.js`): `tmpVault(files: Record<string,string>): {dir: string, cleanup(): void}` — creates a temp dir with `.obsidian/` plus the given files.

- [ ] **Step 1: Write failing tests** in `test/paths.test.js`: `resolves normal and unicode/space paths` (`Projects/Café (2026).md` stays inside); `rejects ../ traversal`; `rejects symlinked dir pointing outside` (symlink `out -> os.tmpdir()`, `resolve("out/x.md")` throws "escapes"); `rejects dangling symlink as new-note path` (symlink `new.md -> /nonexistent-outside/x`, write resolve throws); `rejects write to .obsidian/.git/.trash but allows read of .obsidian`; `error messages contain no absolute path` (`assert.ok(!e.message.includes(dir))`).
- [ ] **Step 2:** Run `node --test test/paths.test.js` — expect FAIL (module missing).
- [ ] **Step 3: Implement `Paths`** in `paths.js`. Approach: `path.resolve` then `fs.promises.realpath` on the path, or on the nearest existing ancestor when it does not exist, and check `path.relative(realRoot, real)` does not start with `..`; additionally `lstat` the final component and reject symlinks whose realpath leaves the root.
- [ ] **Step 4:** Run the test file — expect PASS. Update `package.json` test script to `node --test test/`.
- [ ] **Step 5: Commit** `git add paths.js test package.json && git commit -m "feat: realpath-contained path resolution"` (end message with the Co-Authored-By line from the session attribution).

### Task 2: Code-aware links (`links.js`)

**Files:** Create `links.js`, `test/links.test.js`.

**Interfaces:**
- Produces: `type Link = {kind: "wiki"|"md", embed: boolean, target: string, anchor: string, alias: string, start: number, end: number, raw: string}`; `extractLinks(text: string): Link[]`; `rewriteLinks(text: string, fn: (l: Link) => string | null): string` where `fn` returns a new `target` (anchor/alias/embed preserved) or `null` to leave the link unchanged. For `md` links, `target` is the URL path without `.md`; external (`http:`, `mailto:`) links are never returned.

- [ ] **Step 1: Write failing tests**: `extracts wiki, alias, anchor, embed and md links` (`[[a]]`, `[[a|x]]`, `[[a#h]]`, `![[a]]`, `[t](a.md)` → five links with expected fields); `ignores fenced code, inline code and frontmatter`; `handles CRLF and files with no frontmatter or empty text`; `rewriteLinks preserves anchor, alias and embed` (`![[old#h|x]]` → `![[new#h|x]]`); `leaves unmatched links byte-identical`; `ignores http and mailto md links`.
- [ ] **Step 2:** Run `node --test test/links.test.js` — expect FAIL.
- [ ] **Step 3: Implement `extractLinks` and `rewriteLinks`.** Approach: first compute masked ranges (frontmatter at file start, ``` fences, inline backticks), then scan the rest with one regex per link kind; skip matches starting inside masked ranges.
- [ ] **Step 4:** Run — expect PASS.
- [ ] **Step 5: Commit** `feat: code-aware link parsing`.

### Task 3: Atomic writes, overwrite default, sanitized errors

**Files:** Modify `vault.js`, `server.js`; create `test/vault.test.js`.

**Interfaces:**
- Consumes: `Paths` (Task 1).
- Produces: `Vault` constructor unchanged `new Vault(root: string)`, now holding `this.paths: Paths`. Changed signatures: `write(rel, content, opts?: {overwrite?: boolean}) : Promise<string>` with `overwrite` default `false`, throwing `Error("Note exists: <rel>; pass overwrite=true to replace")`. All fs access goes through `await this.paths.resolve(...)`. Internal `atomicWrite(abs: string, content: string): Promise<void>` (temp file in the same dir + rename; temp removed on failure). `server.js` `tool()` wrapper maps any error to `"<tool> failed: <message>"`, replacing any occurrence of the absolute vault root in the message with `<vault>`.

- [ ] **Step 1: Write failing tests** in `test/vault.test.js`: `write defaults to no-overwrite and errors with hint`; `overwrite=true replaces`; `no temp files remain after write` (readdir has only expected names); `no temp file after forced rename failure` (write into a path whose target is a directory); `append works on empty and no-trailing-newline notes`; `frontmatter update on CRLF note keeps body intact`; `errors never contain absolute vault path` (unreadable/missing note via the e2e layer is covered in Task 7; here assert on `Vault` errors).
- [ ] **Step 2:** Run `node --test test/vault.test.js` — expect FAIL.
- [ ] **Step 3: Refactor `vault.js`** to use `Paths` and `atomicWrite` for `write`, `append`, `patch`, `updateFrontmatter`, `move`; flip the `overwrite` default; flip `server.js` `write_note` schema default to `false`; add the error-sanitizing wrapper.
- [ ] **Step 4:** Run — expect PASS.
- [ ] **Step 5: Commit** `feat: atomic writes, safe overwrite default, sanitized errors`.

### Task 4: Bounded output and ranked search

**Files:** Modify `vault.js`, `server.js`; extend `test/vault.test.js`.

**Interfaces:**
- Produces: `read(rel, opts?: {maxChars?: number}) : Promise<string>` (default 50000; truncated text ends with `\n\n[truncated: showing N of TOTAL chars]`); `list(dir?: string) : Promise<string[]>` returning at most 500 entries, last entry `"… N more entries not shown"` when capped; `search(query, opts?: {limit?: number; context?: number; caseSensitive?: boolean; folder?: string}) : Promise<{path: string; line: number|null; snippet: string|null; score: number}[]>` ordered by filename match first, then match count descending, then path.

- [ ] **Step 1: Write failing tests**: `read truncates with marker stating total`; `read under cap is returned unchanged`; `list caps at 500 with note` (create 510 files); `search ranks filename match before body-only match`; `search ranks more occurrences higher`; `search folder filter excludes other folders`; `search limit respected`.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3: Implement** the signatures above (`score = (nameHit ? 1000 : 0) + occurrences`). In `server.js` add optional `max_chars` (int, 1–500000) to `read_note` and `folder` (string) to `search_notes`.
- [ ] **Step 4:** Run — expect PASS.
- [ ] **Step 5: Commit** `feat: bounded output and ranked search`.

### Task 5: Link-safe move and backlinks

**Files:** Modify `vault.js`, `server.js`; extend `test/vault.test.js`.

**Interfaces:**
- Consumes: `extractLinks`, `rewriteLinks` (Task 2).
- Produces: `move(from, to, updateLinks?: boolean) : Promise<{to: string; linksUpdatedInFiles: number; skippedAmbiguous: string[]}>` — `skippedAmbiguous` lists vault paths that contain basename-keyed links left unchanged because the old basename matched more than one note; path-qualified links are always rewritten. `backlinks(rel) : Promise<{path: string; link: string; ambiguous: boolean}[]>`.

- [ ] **Step 1: Write failing tests**: `move rewrites basename and path links, keeps alias/anchor/embed`; `move does not rewrite links inside code fences or frontmatter`; `move with duplicate basename skips basename links and reports them`; `move rewrites md-style links`; `move refuses existing destination`; `backlinks ignores code-fenced links`; `backlinks flags ambiguous basename`.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3: Reimplement `move` and `backlinks`** with `extractLinks`/`rewriteLinks`. Approach: build a basename→paths index once per call; a link target is ambiguous when its basename (no slash) maps to more than one note.
- [ ] **Step 4:** Run — expect PASS. Update the `move_note` and `get_backlinks` tool output descriptions in `server.js`.
- [ ] **Step 5: Commit** `feat: link-safe move and backlinks`.

### Task 6: Config-driven daily notes

**Files:** Modify `vault.js`, `server.js`; extend `test/vault.test.js`.

**Interfaces:**
- Produces: `dailyPath(date?: Date, opts?: {folderOverride?: string}) : Promise<string>` — reads `<vault>/.obsidian/daily-notes.json` (`folder`, `format` with `YYYY`, `MM`, `DD` tokens only); order of precedence: `folderOverride` (from `OBSIDIAN_DAILY_FOLDER`), config `folder`, `"Daily"`; format falls back to `YYYY-MM-DD`; unsupported format tokens fall back to the default format.

- [ ] **Step 1: Write failing tests**: `uses folder and format from daily-notes.json`; `falls back to Daily/YYYY-MM-DD with no config`; `malformed config falls back without throwing`; `env override wins over config folder`; `unsupported format tokens fall back`.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3: Implement `dailyPath`**; update `daily_note` in `server.js` to `await vault.dailyPath(...)` passing `process.env.OBSIDIAN_DAILY_FOLDER`.
- [ ] **Step 4:** Run — expect PASS.
- [ ] **Step 5: Commit** `feat: daily notes follow obsidian config`.

### Task 7: End-to-end update and live verification

**Files:** Move `server.test.js` to `test/e2e.test.js`; modify it for new defaults.

**Interfaces:** Consumes everything above through the stdio server only.

- [ ] **Step 1: Update e2e tests** (spawn path becomes `../server.js`): tool count still `13`; `write_note` without `overwrite` on an existing note is `isError`; symlink-out path read is `isError` and message lacks the vault root; `read_note` `max_chars` truncates; `search_notes` `folder` works; move with duplicate basename reports `skippedAmbiguous`; traversal and protected-dir cases retained.
- [ ] **Step 2:** Run `npm test` — expect all unit and e2e tests PASS; record the totals.
- [ ] **Step 3: Live checks (read-only on the real vault):** `initialize` handshake via `printf ... | node server.js "$HOME/Documents/Obsidian Vault"` returns `serverInfo.name == "obsidian-mcp"`; run `list_directory` and `search_notes` once through a stdio client against the real vault and confirm results; confirm `list_tags` runs. Do not call any write tool.
- [ ] **Step 4: Agent configs unchanged:** `claude mcp get obsidian-local` shows Connected; `codex mcp get obsidian-local` shows enabled; `hermes mcp test obsidian-local` lists 13 tools. Do not run any `mcp add` or `mcp remove` command; the configs must not change.
- [ ] **Step 5: Commit** `test: e2e for hardened behavior`, then report the spec's four verification points with evidence and any unverified items (live Codex/Hermes tool calls remain unverified unless run in-session).
