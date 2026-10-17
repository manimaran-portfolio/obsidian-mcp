const FRONTMATTER = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
// Length-capped so an unclosed opener cannot make the scan quadratic on a long line.
const WIKI = /(!?)\[\[([^\]|#\n]{1,512}?)(?:#([^\]|\n]{0,512}))?(?:\|([^\]\n]{0,512}))?\]\]/g;
const MD = /(!?)\[([^\]\n]{0,512})\]\(([^)\s#]{1,1024}?\.md)(?:#([^)\s]{0,512}))?\)/gi;
const EXTERNAL = /^[a-z][a-z0-9+.-]*:/i;

const blank = (s) => s.replace(/[^\r\n]/g, " ");

/** Copy of `text` (same length/offsets) with frontmatter, fenced code and inline code blanked out. */
function mask(text) {
  let out = text;
  const fm = FRONTMATTER.exec(text);
  if (fm) out = blank(fm[0]) + out.slice(fm[0].length);
  let fence = null;
  const parts = [];
  for (const line of out.split(/(?<=\n)/)) {
    const m = FENCE.exec(line);
    if (fence) {
      parts.push(blank(line));
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
    } else if (m) {
      fence = m[1];
      parts.push(blank(line));
    } else {
      parts.push(line);
    }
  }
  return parts.join("").replace(/(`+)[^`]*?\1/g, (s) => blank(s));
}

/** Links outside code and frontmatter, in document order. */
export function extractLinks(text) {
  const m = mask(text);
  const links = [];
  for (const mt of m.matchAll(WIKI)) {
    links.push({
      kind: "wiki",
      embed: mt[1] === "!",
      target: mt[2].trim(),
      anchor: mt[3] ?? "",
      alias: mt[4] ?? "",
      start: mt.index,
      end: mt.index + mt[0].length,
      raw: text.slice(mt.index, mt.index + mt[0].length),
    });
  }
  for (const mt of m.matchAll(MD)) {
    if (EXTERNAL.test(mt[3])) continue;
    let target = mt[3].replace(/\.md$/i, "");
    try {
      target = decodeURIComponent(target);
    } catch {}
    links.push({
      kind: "md",
      embed: mt[1] === "!",
      target,
      anchor: mt[4] ?? "",
      alias: mt[2],
      start: mt.index,
      end: mt.index + mt[0].length,
      raw: text.slice(mt.index, mt.index + mt[0].length),
    });
  }
  return links.sort((a, b) => a.start - b.start);
}

function build(l, target) {
  const bang = l.embed ? "!" : "";
  if (l.kind === "wiki") return `${bang}[[${target}${l.anchor ? "#" + l.anchor : ""}${l.alias ? "|" + l.alias : ""}]]`;
  return `${bang}[${l.alias}](${encodeURI(target)}.md${l.anchor ? "#" + l.anchor : ""})`;
}

/** Rewrite link targets; `fn` returns a new target or null to leave the link untouched. */
export function rewriteLinks(text, fn) {
  let out = text;
  for (const l of extractLinks(text).reverse()) {
    const next = fn(l);
    if (next == null || next === l.target) continue;
    out = out.slice(0, l.start) + build(l, next) + out.slice(l.end);
  }
  return out;
}
