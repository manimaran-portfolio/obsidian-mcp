#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Vault } from "./vault.js";
import { parseArgs } from "./args.js";
import { stampProvenance } from "./frontmatter.js";

let args;
try {
  args = parseArgs(process.argv.slice(2), process.env);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
const root = args.vault || process.env.OBSIDIAN_VAULT;
if (!root || !fs.existsSync(root)) {
  console.error("Usage: obsidian-mcp <vault-path> [--agent <name>]  (or set OBSIDIAN_VAULT, OBSIDIAN_AGENT)");
  process.exit(1);
}
const vault = new Vault(root, { agent: args.agent });

const server = new McpServer({ name: "obsidian-mcp", version: "0.1.0" });

const ok = (v) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
const tool = (name, description, shape, fn, annotations = {}) =>
  server.registerTool(name, { description, inputSchema: shape, annotations }, async (args) => {
    try {
      return ok(await fn(args));
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `${name} failed: ${String(e.message).split(vault.root).join("<vault>")}` }] };
    }
  });

const notePath = z.string().describe("Vault-relative note path; .md optional, e.g. 'Projects/Plan'");
const RO = { readOnlyHint: true };

tool("list_directory", "List files and folders in a vault directory (default: root).",
  { path: z.string().optional().describe("Vault-relative directory") },
  ({ path: p }) => vault.list(p || ""), RO);

tool("read_note", "Read a note's content, including frontmatter. Long notes are truncated with a marker stating the total length.",
  { path: notePath, max_chars: z.number().int().min(1).max(500000).default(50000) },
  ({ path: p, max_chars }) => vault.read(p, { maxChars: max_chars }), RO);

tool("write_note", "Create a note. Fails if it exists unless overwrite=true.",
  { path: notePath, content: z.string(), overwrite: z.boolean().default(false).describe("Replace an existing note (default: error if it exists)") },
  async ({ path: p, content, overwrite }) =>
    `Wrote ${await vault.write(p, vault.agent ? stampProvenance(content, vault.agent) : content, { overwrite })}`);

tool("append_note", "Append text to a note, creating it if missing.",
  { path: notePath, content: z.string() },
  async ({ path: p, content }) => `Appended to ${await vault.append(p, content)}`);

tool("patch_note", "Replace text in a note. Fails if old_text is missing or ambiguous (unless replace_all).",
  { path: notePath, old_text: z.string().min(1), new_text: z.string(), replace_all: z.boolean().default(false) },
  async ({ path: p, old_text, new_text, replace_all }) =>
    `Replaced ${await vault.patch(p, old_text, new_text, replace_all)} occurrence(s) in ${p}`);

tool("delete_note", "Move a note to the vault's .trash folder (recoverable).", { path: notePath },
  async ({ path: p }) => `Trashed to ${await vault.trash(p)}`, { destructiveHint: true });

tool("move_note", "Move or rename a note; rewrites links across the vault by default. Basename links are skipped and reported in skippedAmbiguous when another note shares the old basename.",
  { from: notePath, to: notePath, update_links: z.boolean().default(true) },
  ({ from, to, update_links }) => vault.move(from, to, update_links));

tool("search_notes", "Case-insensitive substring search over note paths and contents, ranked (filename matches first, then match count).",
  { query: z.string().min(1), limit: z.number().int().min(1).max(100).default(20), case_sensitive: z.boolean().default(false), folder: z.string().optional().describe("Only search under this vault-relative folder") },
  ({ query, limit, case_sensitive, folder }) => vault.search(query, { limit, caseSensitive: case_sensitive, folder }), RO);

tool("get_frontmatter", "Return a note's YAML frontmatter as JSON.", { path: notePath },
  ({ path: p }) => vault.frontmatter(p), RO);

tool("update_frontmatter", "Merge keys into a note's frontmatter and/or remove keys.",
  { path: notePath, set: z.record(z.any()).default({}), remove: z.array(z.string()).default([]) },
  ({ path: p, set, remove }) => vault.updateFrontmatter(p, set, remove));

tool("list_tags", "List all tags (frontmatter and inline) with usage counts.", {}, () => vault.tags(), RO);

tool("get_backlinks", "List links to the given note as {path, link, ambiguous}; ambiguous=true when the link's basename matches several notes.", { path: notePath },
  ({ path: p }) => vault.backlinks(p), RO);

tool("daily_note", "Get today's daily note path/content, creating it if missing; optionally append text.",
  { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD, default today"), append: z.string().optional() },
  async ({ date, append }) => {
    const rel = await vault.dailyPath(date ? new Date(`${date}T12:00:00`) : new Date(), { folderOverride: vault.agent ? `${vault.writeRoot}/Daily` : process.env.OBSIDIAN_DAILY_FOLDER });
    let created = false;
    try {
      await vault.read(rel);
    } catch {
      await vault.write(rel, `# ${path.basename(rel, ".md")}\n`, { overwrite: false });
      created = true;
    }
    if (append) await vault.append(rel, append.endsWith("\n") ? append : append + "\n");
    return { path: rel, created, content: await vault.read(rel) };
  });

await server.connect(new StdioServerTransport());
console.error(`obsidian-mcp ready: ${vault.root}${vault.agent ? ` (agent: ${vault.agent})` : ""}`);
