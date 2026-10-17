import test from "node:test";
import assert from "node:assert/strict";
import { extractLinks, rewriteLinks } from "../links.js";

test("extracts wiki, alias, anchor, embed and md links", () => {
  const links = extractLinks("[[a]] [[b|x]] [[c#h]] ![[d]] [t](e.md)");
  assert.deepEqual(
    links.map((l) => [l.kind, l.embed, l.target, l.anchor, l.alias]),
    [
      ["wiki", false, "a", "", ""],
      ["wiki", false, "b", "", "x"],
      ["wiki", false, "c", "h", ""],
      ["wiki", true, "d", "", ""],
      ["md", false, "e", "", "t"],
    ],
  );
  assert.equal(links[0].raw, "[[a]]");
});

test("ignores fenced code, inline code and frontmatter", () => {
  const text = "---\nrelated: \"[[fm]]\"\n---\nbody [[real]]\n```\n[[fenced]]\n```\nand `[[inline]]`\n~~~\n[[tilde]]\n~~~\n";
  assert.deepEqual(extractLinks(text).map((l) => l.target), ["real"]);
});

test("handles CRLF, no frontmatter and empty text", () => {
  assert.deepEqual(extractLinks("---\r\nk: v\r\n---\r\n[[a]]\r\n").map((l) => l.target), ["a"]);
  assert.deepEqual(extractLinks("[[a]]").map((l) => l.target), ["a"]);
  assert.deepEqual(extractLinks(""), []);
});

test("ignores http and mailto md links", () => {
  assert.deepEqual(extractLinks("[x](https://a.com/b.md) [y](mailto:a@b.md) [z](local.md)").map((l) => l.target), ["local"]);
});

test("decodes %20 in md link targets", () => {
  assert.equal(extractLinks("[t](My%20Note.md)")[0].target, "My Note");
});

test("rewriteLinks preserves anchor, alias and embed", () => {
  const out = rewriteLinks("![[old#h|x]] [[old]] [t](old.md#s)", (l) => (l.target === "old" ? "dir/new" : null));
  assert.equal(out, "![[dir/new#h|x]] [[dir/new]] [t](dir/new.md#s)");
});

test("rewriteLinks leaves unmatched links and code byte-identical", () => {
  const text = "[[keep]]  [[ spaced ]]\n```\n[[old]]\n```\n";
  assert.equal(rewriteLinks(text, (l) => (l.target === "old" ? "new" : null)), text);
});

test("rewriteLinks encodes spaces in md targets", () => {
  assert.equal(rewriteLinks("[t](a.md)", () => "My Note"), "[t](My%20Note.md)");
});

test("I5: unclosed link openers do not cause quadratic runtime", () => {
  for (const text of ["[[".repeat(30000), "[".repeat(20000) + "[[" + "a".repeat(20000), "[a](".repeat(30000), "[".repeat(40000)]) {
    const t0 = Date.now();
    extractLinks(text);
    assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0}ms`);
  }
});
