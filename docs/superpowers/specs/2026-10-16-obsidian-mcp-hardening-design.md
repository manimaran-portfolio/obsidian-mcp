# obsidian-mcp hardening — design

Date: 2026-10-16 · Status: awaiting user review · Baseline: v0.1 (first git commit)

## Intent

One stdio MCP server that behaves identically in Claude Code, Codex and Hermes, is safe to leave running against the real vault (`~/Documents/Obsidian Vault`), and can replace the `obsidian` (mcpvault) server over time.

**Goal of this pass: safety and correctness.** The 13 tool names and existing parameters stay stable so the three agent configs (`obsidian-local`) need no edits. New features, attachments and new tools are out of scope.

## Problems in v0.1 (what this fixes)

1. `resolve()` checks the path string only; a symlink inside the vault can point outside it.
2. `write_note` overwrites by default, and writes are non-atomic (risky while Obsidian has the file open).
3. `read_note`, `list_directory` and `search_notes` output is unbounded.
4. Link rewriting and backlinks use one regex that ignores code blocks, frontmatter and markdown links, and does not handle ambiguous basenames.
5. `search_notes` is an unranked first-N scan.
6. `daily_note` hardcodes the `Daily` folder instead of reading Obsidian's config.
7. Errors may expose absolute host paths.
8. Tests are end-to-end only; vault logic has no unit coverage.

## Architecture

| File | Responsibility | Depends on |
|---|---|---|
| `paths.js` | Resolve vault-relative paths; `realpath` containment (existing files, and the nearest existing parent for new files); reject symlinks leaving the vault; protected dirs (`.obsidian`, `.git`, `.trash`) blocked for writes | node fs/path |
| `links.js` | Parse links outside fenced code, inline code and frontmatter: `[[x]]`, `[[x|alias]]`, `[[x#h]]`, `![[x]]`, `[t](x.md)`; rewrite targets preserving anchor/alias | none |
| `vault.js` | Note operations (list, read, write, append, patch, trash, move, search, frontmatter, tags, backlinks, daily) built on `paths` and `links` | `paths`, `links`, gray-matter |
| `server.js` | Tool registration, argument schemas, error mapping. No filesystem logic | `vault`, MCP SDK, zod |

## Behavior changes

| Area | Change |
|---|---|
| `write_note` | `overwrite` defaults to **false**. Existing note → error saying to pass `overwrite=true`. **Breaking** for callers that relied on replace-by-default. |
| Write mechanics | All writes go to a temp file in the same directory, then rename. No temp files left behind on success or failure. |
| `read_note` | New optional `max_chars` (default 50,000). When truncated, output ends with a marker stating total length. |
| `move_note` | If the old basename matches more than one note, basename-keyed links are not rewritten and are listed as skipped in the result. Path-qualified links are always rewritten. Destination must not exist. |
| `get_backlinks` | Returns linking notes with the link text; ambiguous basename matches flagged. |
| `search_notes` | Ranked: filename match first, then match count. Optional `folder` filter. Existing `limit` retained (max 100). |
| `list_directory` | Output capped at 500 entries with a truncation note. |
| `daily_note` | Folder and date format read from `.obsidian/daily-notes.json` when present; fallback `Daily/YYYY-MM-DD`. `OBSIDIAN_DAILY_FOLDER` still overrides. |
| Errors | Every tool returns `isError` with a one-line cause using vault-relative paths only. No stack traces, no absolute host paths. |

Unchanged: tool names, existing parameters, `delete_note` soft-delete to `.trash`, `move_note` link rewriting default, vault path via argv or `OBSIDIAN_VAULT`.

## Out of scope

Attachments/non-markdown files, new tools, heading-aware edits, search indexing, retiring mcpvault, TypeScript migration.

## Testing

- **Unit tests** (`node --test`, temporary vault) covering: symlink escape for existing and new files; `..` traversal; protected dirs; atomic write leaves no temp files (including on rename failure); overwrite default; code-block/frontmatter-aware link parsing for each link form; ambiguous basename on move and backlinks; truncation markers; search ranking and folder filter; daily-note config parsing and fallback; error messages contain no absolute paths.
- **End-to-end tests:** existing stdio suite updated for the new defaults.
- **Test-first:** each behavior gets a failing test before its implementation.

## Verification before completion

1. All unit and e2e tests pass (output shown).
2. Live `initialize` handshake against the real vault.
3. `claude mcp get obsidian-local`, `codex mcp get obsidian-local`, `hermes mcp test obsidian-local` still succeed with **no config edits**.
4. Only read-only tools are exercised against the real vault; all write paths are tested on a temporary vault only.

## Rollout and risk

- Edit in place in `~/projects/obsidian-mcp`; v0.1 is the first commit, so `git revert`/`git checkout` is the rollback.
- Main risk: the `overwrite` default flip. Mitigated by a clear error message; agents retry with `overwrite=true`.
- Residual risk: `realpath` checks have an unavoidable check-then-use window; acceptable for a single-user local vault, noted as a known limit.
