import YAML from "yaml";

// Frontmatter is parsed here (YAML only) rather than with gray-matter, whose default
// engines evaluate ---js blocks, and whose rewrite drops comments and re-types dates.
const FM = /^(﻿?)---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

export function splitNote(raw) {
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const m = FM.exec(raw);
  if (!m) return { bom: "", yaml: null, body: raw, eol };
  return { bom: m[1], yaml: m[2] ?? "", body: raw.slice(m[0].length), eol };
}

function parseDoc(yamlText) {
  const doc = YAML.parseDocument(yamlText);
  if (doc.errors.length) throw new Error(`Invalid frontmatter: ${doc.errors[0].message.split("\n")[0]}`);
  return doc;
}

/** {data, body}; data is {} when there is no frontmatter or it is not a mapping. Throws on invalid YAML. */
export function parseFrontmatter(raw) {
  const s = splitNote(raw);
  if (s.yaml === null) return { data: {}, body: raw };
  const js = parseDoc(s.yaml).toJS();
  return { data: js && typeof js === "object" && !Array.isArray(js) ? js : {}, body: s.body };
}

/** New note text with keys set/removed; comments, key order, date strings and line endings preserved. */
export function updateFrontmatterText(raw, set = {}, remove = []) {
  const s = splitNote(raw);
  let doc = s.yaml === null ? new YAML.Document({}) : parseDoc(s.yaml);
  if (!YAML.isMap(doc.contents)) {
    if (doc.contents !== null && doc.toJS() !== null && doc.toJS() !== "") throw new Error("Invalid frontmatter: not a key/value mapping");
    doc = new YAML.Document({});
  }
  for (const [k, v] of Object.entries(set)) doc.set(k, v);
  for (const k of remove) doc.delete(k);
  const data = doc.toJS() ?? {};
  const text = Object.keys(data).length ? String(doc).trimEnd().replace(/\n/g, s.eol) + s.eol : "";
  return { text: `${s.bom}---${s.eol}${text}---${s.eol}${s.body}`, data };
}

/** Note text with `agent` and `updated` set; unchanged if the frontmatter can't be parsed. */
export function stampProvenance(raw, agent, now = new Date()) {
  try {
    return updateFrontmatterText(raw, { agent, updated: now.toISOString() }).text;
  } catch {
    return raw;
  }
}
