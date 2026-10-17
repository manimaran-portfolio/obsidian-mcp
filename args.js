import { parseArgs as nodeParseArgs } from "node:util";

const AGENT = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** `argv` is process.argv.slice(2). The --agent flag wins over OBSIDIAN_AGENT; no agent means unrestricted. */
export function parseArgs(argv, env = {}) {
  let parsed;
  try {
    parsed = nodeParseArgs({ args: argv, options: { agent: { type: "string" } }, allowPositionals: true });
  } catch (e) {
    throw new Error(`Invalid agent name: ${String(e.message).split("\n")[0]}`);
  }
  const agent = parsed.values.agent ?? (env.OBSIDIAN_AGENT || null);
  if (agent !== null && !AGENT.test(agent)) throw new Error(`Invalid agent name: ${JSON.stringify(agent)} (use ${AGENT})`);
  return { vault: parsed.positionals[0], agent };
}
