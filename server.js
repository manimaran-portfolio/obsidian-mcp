#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Vault } from "./vault.js";

const root = process.argv[2] || process.env.OBSIDIAN_VAULT;
if (!root || !fs.existsSync(root)) {
  console.error("Usage: obsidian-mcp <vault-path>  (or set OBSIDIAN_VAULT)");
  process.exit(1);
}
const vault = new Vault(root);
const dailyFolder = process.env.OBSIDIAN_DAILY_FOLDER || "Daily";

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

tool("read_note", "Read a note's full content, including frontmatter.", { path: notePath },
  ({ path: p }) => vault.read(p), RO);

tool("write_note", "Create a note. Fails if it exists unless overwrite=true.",
  { path: notePath, content: z.string(), overwrite: z.boolean().default(false).describe("Replace an existing note (default: error if it exists)") },
  async ({ path: p, content, overwrite }) => `Wrote ${await vault.write(p, content, { overwrite })}`);

tool("append_note", "Append text to a note, creating it if missing.",
  { path: notePath, content: z.string() },
  async ({ path: p, content }) => `Appended to ${await vault.append(p, content)}`);

tool("patch_note", "Replace text in a note. Fails if old_text is missing or ambiguous (unless replace_all).",
  { path: notePath, old_text: z.string().min(1), new_text: z.string(), replace_all: z.boolean().default(false) },
  async ({ path: p, old_text, new_text, replace_all }) =>
    `Replaced ${await vault.patch(p, old_text, new_text, replace_all)} occurrence(s) in ${p}`);

tool("delete_note", "Move a note to the vault's .trash folder (recoverable).", { path: notePath },
  async ({ path: p }) => `Trashed to ${await vault.trash(p)}`, { destructiveHint: true });

tool("move_note", "Move or rename a note; rewrites [[wikilinks]] across the vault by default.",
  { from: notePath, to: notePath, update_links: z.boolean().default(true) },
  ({ from, to, update_links }) => vault.move(from, to, update_links));

tool("search_notes", "Case-insensitive substring search over note paths and contents.",
  { query: z.string().min(1), limit: z.number().int().min(1).max(100).default(20), case_sensitive: z.boolean().default(false) },
  ({ query, limit, case_sensitive }) => vault.search(query, { limit, caseSensitive: case_sensitive }), RO);

tool("get_frontmatter", "Return a note's YAML frontmatter as JSON.", { path: notePath },
  ({ path: p }) => vault.frontmatter(p), RO);

tool("update_frontmatter", "Merge keys into a note's frontmatter and/or remove keys.",
  { path: notePath, set: z.record(z.any()).default({}), remove: z.array(z.string()).default([]) },
  ({ path: p, set, remove }) => vault.updateFrontmatter(p, set, remove));

tool("list_tags", "List all tags (frontmatter and inline) with usage counts.", {}, () => vault.tags(), RO);

tool("get_backlinks", "List notes that [[link]] to the given note.", { path: notePath },
  ({ path: p }) => vault.backlinks(p), RO);

tool("daily_note", "Get today's daily note path/content, creating it if missing; optionally append text.",
  { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD, default today"), append: z.string().optional() },
  async ({ date, append }) => {
    const rel = vault.dailyPath(date ? new Date(`${date}T12:00:00`) : new Date(), dailyFolder);
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
console.error(`obsidian-mcp ready: ${vault.root}`);
