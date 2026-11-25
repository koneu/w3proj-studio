// The verdict of scripts/wts-corpus.mjs, apart from the game's files so that a unit test can run it
// (wts-verdict.test.mjs): how one string's text read by the frozen reference compares with what wts.ts reads.

/** The text the current rule keeps of a reference text `v`: it ends at its first `}` without a `\` right before it,
 *  and a line end before that `}` is not part of it (wts.ts WtsReader.findClose). `v` itself when it has none. */
export function cutAtBrace(v) {
  let i = v.indexOf("}");
  while (i > 0 && v.charCodeAt(i - 1) === 0x5c) i = v.indexOf("}", i + 1);
  if (i < 0) return v;
  if (i > 0 && v.charCodeAt(i - 1) === 0x0a) {
    i--;
    if (i > 0 && v.charCodeAt(i - 1) === 0x0d) i--;
  }
  return v.slice(0, i);
}

/**
 * How a string's text compares: `same`; `inline` (the reference text holds a `}` the current rule ends at, and no
 * block header after it: exactly the cut rule, nothing else moved); `cut` (the reference swallowed the next block
 * into this text, the new one is only its start); `CHANGED` (anything else).
 */
export function classifyText(reference, current) {
  if (reference === current) return "same";
  const rest = reference.slice(current.length);
  if (current === cutAtBrace(reference) && !/(^|\n)STRING\s+\d+\s/.test(rest)) return "inline";
  return reference.startsWith(current) && rest.startsWith("}") ? "cut" : "CHANGED";
}

/**
 * The verdict for a file from its difference list (`cut N`, `new N`, `inline N`, anything in capitals is a failure):
 * fine when every entry is a cut, an inline cut or a recovered block, there is at least one cut or inline cut, and
 * every swallowing cut has its recovered block.
 */
export function fileFine(diff) {
  const count = (w) => diff.filter((d) => d.startsWith(w + " ")).length;
  const cuts = count("cut"), news = count("new"), inline = count("inline");
  const known = diff.every((d) => /^(cut|new|inline) /.test(d));
  return known && cuts + inline > 0 && news >= cuts && (news === 0 || cuts > 0);
}
