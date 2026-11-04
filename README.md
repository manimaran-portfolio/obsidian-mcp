# obsidian-mcp

A small [MCP](https://modelcontextprotocol.io) server that gives AI agents access to an Obsidian vault, with **per-agent write scoping**. Several agents can share one vault as a second brain, and none of them can overwrite your notes or each other's by mistake.

It works on the vault's markdown files directly. Obsidian doesn't need to be running.

## Why another Obsidian MCP server?

Most servers let an agent read and write anywhere in the vault. That's fine for a demo, but not for notes you rely on. This one treats the server as a trust boundary:

- **Scoped writes.** With `--agent <name>`, writes are limited to `Agents/<name>/`. Reads and search still cover the whole vault. `..`, absolute paths and symlinks that leave the folder are rejected, and so is a symlinked write root.
- **Provenance.** In scoped mode, `write_note` stamps `agent` and `updated` into the note's frontmatter, so you can tell what an agent wrote.
- **Confined link rewriting.** `move_note` updates links, but only inside the agent's write root. Links in notes outside it are left alone and reported as `skippedOutOfScope`.
- **Recoverable deletes.** `delete_note` moves notes to the vault's `.trash/` folder.
- **Safe writes.** Writes are atomic (temp file and rename), and `.obsidian`, `.git` and `.trash` are protected.

> **Not a sandbox.** Scope is enforced by this server only. An agent that also has shell access can still edit the files directly. The scope protects against mistakes made through the MCP tools, not against a determined agent. Leaving out `--agent` means unrestricted access, so set it in every agent's config.

## Install

Requires Node.js 18.3+ (running tests with `npm test` needs Node 21+). Developed on Node 22.

```bash
git clone https://github.com/manimaran-portfolio/obsidian-mcp.git
cd obsidian-mcp
npm install
```

## Usage

```bash
node server.js <vault-path> [--agent <name>] [--write-also <folder>]...
```

| Option | Env var | Meaning |
|---|---|---|
| `<vault-path>` | `OBSIDIAN_VAULT` | Path to the vault. |
| `--agent <name>` | `OBSIDIAN_AGENT` | Scope writes to `Agents/<name>/`. Name must match `^[a-z0-9][a-z0-9_-]{0,31}$`. The flag wins over the env var. |
| `--write-also <folder>` (repeatable) | `OBSIDIAN_WRITE_ALSO` (comma-separated) | Extra vault-relative folders the agent may write to. Hidden folders, `..` and `Agents` are rejected. |
| | `OBSIDIAN_DAILY_FOLDER` | Daily note folder override (unscoped mode only). |

### Register with Claude Code

```bash
claude mcp add obsidian-local -- node /path/to/obsidian-mcp/server.js "/path/to/Vault" --agent claude
```

Other MCP clients can launch the same command over stdio, each with its own `--agent` name.

### HTTP mode

Set `OBSIDIAN_HTTP_PORT` to serve Streamable HTTP instead of stdio:

```bash
OBSIDIAN_HTTP_PORT=8765 OBSIDIAN_MCP_TOKEN=<24+ char secret> node server.js "/path/to/Vault" --agent claude
```

- Endpoint: `POST /mcp`, with an `Authorization: Bearer <token>` header (compared in constant time).
- `OBSIDIAN_MCP_TOKEN` is required and must be at least 24 characters.
- Binds to `127.0.0.1` by default. Change it with `OBSIDIAN_HTTP_HOST`. The server doesn't do TLS, so put a TLS-terminating proxy in front of it before exposing it beyond localhost.

## Tools

| Tool | Description |
|---|---|
| `list_directory` | List files and folders. |
| `read_note` | Read a note, truncated at `max_chars`. |
| `write_note` | Create a note (`overwrite` to replace). |
| `append_note` | Append to a note, creating it if missing. |
| `patch_note` | Replace text. Fails if the text is missing or ambiguous. |
| `delete_note` | Move a note to `.trash/`. |
| `move_note` | Move or rename, rewriting links by default. |
| `search_notes` | Substring search over paths and contents, ranked. |
| `get_frontmatter` / `update_frontmatter` | Read, merge and remove YAML frontmatter keys. |
| `list_tags` | Frontmatter and inline tags with counts. |
| `get_backlinks` | Notes that link to a note. |
| `daily_note` | Get or create a daily note, optionally appending text. |

In scoped mode, every tool that changes a note is rejected outside the write root. The read tools are unchanged.

## Development

```bash
npm test
```

Tests use Node's built-in runner and cover path confinement, link rewriting and an end-to-end run of the real server with `--agent`.
