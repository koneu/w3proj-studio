// The modules of a Rust source file that are only compiled for tests, found well enough to put a file's tests on
// another version of its code (fails-without.mjs --keep-rust-tests): `#[cfg(test)] mod tests { … }`,
// `#[cfg(all(test, unix))] mod fs_tests { … }`, any name, at any place in the file, also nested. Braces and
// attributes inside comments, strings, raw strings and character literals aren't code.

/** Where a comment, string or character literal starting at `i` ends (`i` itself when none starts there). */
function skipLiteral(s, i) {
  const c = s[i], n = s[i + 1];
  if (c === "/" && n === "/") { const e = s.indexOf("\n", i); return e < 0 ? s.length : e; }
  if (c === "/" && n === "*") {
    let depth = 1, j = i + 2;
    while (j < s.length && depth) {
      if (s.startsWith("/*", j)) { depth++; j += 2; } else if (s.startsWith("*/", j)) { depth--; j += 2; } else j++;
    }
    return j;
  }
  const afterIdent = i > 0 && /[A-Za-z0-9_]/.test(s[i - 1]);
  // Raw strings: r"…", r#"…"#, br#"…"#.
  if ((c === "r" || (c === "b" && n === "r")) && !afterIdent) {
    let j = i + (c === "b" ? 2 : 1), hashes = 0;
    while (s[j] === "#") { hashes++; j++; }
    if (s[j] === '"') { const end = s.indexOf(`"${"#".repeat(hashes)}`, j + 1); return end < 0 ? s.length : end + 1 + hashes; }
  }
  if (c === '"') {
    let j = i + 1;
    while (j < s.length && s[j] !== '"') j += s[j] === "\\" ? 2 : 1;
    return Math.min(j + 1, s.length);
  }
  if (c === "'") {
    if (n === "\\") { const end = s.indexOf("'", i + 3); return end < 0 ? s.length : end + 1; }
    const cp = s.codePointAt(i + 1);
    const w = cp !== undefined && cp > 0xffff ? 2 : 1;
    if (cp !== undefined && s[i + 1 + w] === "'") return i + 2 + w;
    return i + 1; // a lifetime
  }
  return i;
}

/** Where the bracket pair opening at `i` (`{` or `[`) closes, after it. */
function skipPair(s, i) {
  const open = s[i], close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let j = i; j < s.length;) {
    const k = skipLiteral(s, j);
    if (k !== j) { j = k; continue; }
    if (s[j] === open) depth++;
    else if (s[j] === close && --depth === 0) return j + 1;
    j++;
  }
  return s.length;
}

/** Whether a `cfg(…)` attribute's predicate is false whenever the code isn't built for tests: `cfg(test)`,
 *  `cfg(all(test, unix))`, but not `cfg(not(test))`, `cfg(any(test, feature = "x"))` or `cfg(unix)`. */
export function cfgOnlyInTests(attr) {
  const tokens = attr.match(/[A-Za-z_][A-Za-z0-9_]*|"(?:[^"\\]|\\.)*"|[(),=]/g) ?? [];
  let k = 0;
  // false / true when known with `test` off, null when it depends on something else.
  const pred = () => {
    const name = tokens[k++];
    if (!name || !/^[A-Za-z_]/.test(name)) throw new Error("not a cfg predicate");
    if (tokens[k] === "=") { k += 2; return null; }
    if (tokens[k] !== "(") return name === "test" ? false : null;
    k++;
    const args = [];
    while (tokens[k] !== ")") {
      if (k >= tokens.length) throw new Error("unclosed cfg predicate");
      args.push(pred());
      if (tokens[k] === ",") k++;
    }
    k++;
    if (name === "all") return args.includes(false) ? false : args.every((a) => a === true) ? true : null;
    if (name === "any") return args.includes(true) ? true : args.every((a) => a === false) ? false : null;
    if (name === "not" && args.length === 1) return args[0] === null ? null : !args[0];
    return null;
  };
  try {
    if (tokens[0] !== "cfg" || tokens[1] !== "(") return false;
    k = 2;
    const v = pred();
    return v === false && tokens[k] === ")";
  } catch {
    return false;
  }
}

/** The test-only modules of a Rust source (`#[cfg(…test…)] mod <name> { … }` or `…;`), as ranges from the start of
 *  the attribute's line to after the module's line end, with the module's name. */
export function rustTestModules(s) {
  const found = [];
  /** The module item whose attributes start at `i`, if one of them makes it test-only. */
  const moduleAt = (i) => {
    let j = i, testOnly = false;
    for (;;) {
      while (j < s.length) {
        if (/\s/.test(s[j])) { j++; continue; }
        const k = skipLiteral(s, j);
        if (k !== j && s[j] === "/") { j = k; continue; }
        break;
      }
      if (s[j] !== "#" || s[j + 1] !== "[") break;
      const end = skipPair(s, j + 1);
      if (cfgOnlyInTests(s.slice(j + 2, end - 1).trim())) testOnly = true;
      j = end;
    }
    if (!testOnly) return null;
    const head = /(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*/y;
    head.lastIndex = j;
    const m = head.exec(s);
    if (!m) return null;
    j = head.lastIndex;
    if (s[j] === "{") j = skipPair(s, j);
    else if (s[j] === ";") j++;
    else return null;
    const lineStart = s.lastIndexOf("\n", i - 1) + 1;
    const start = /^[ \t]*$/.test(s.slice(lineStart, i)) ? lineStart : i;
    if (s.startsWith("\r\n", j)) j += 2;
    else if (s[j] === "\n") j++;
    return { name: m[1], start, end: j };
  };
  for (let i = 0; i < s.length;) {
    const k = skipLiteral(s, i);
    if (k !== i) { i = k; continue; }
    if (s[i] === "#" && s[i + 1] === "[") {
      const m = moduleAt(i);
      if (m) { found.push(m); i = m.end; continue; }
    }
    i++;
  }
  return found;
}

/** The code of `old` with the test modules of `cur` (null when `cur` has none): `old`'s own test modules go, `cur`'s
 *  take the place of the first of them (or follow the code). */
export function baseWithTests(old, cur) {
  const now = rustTestModules(cur);
  if (!now.length) return null;
  let tests = now.map((m) => cur.slice(m.start, m.end)).join("");
  if (!tests.endsWith("\n")) tests += "\n";
  const before = rustTestModules(old);
  if (!before.length) return `${old}${old.endsWith("\n") ? "\n" : "\n\n"}${tests}`;
  let out = "", at = 0;
  before.forEach((m, n) => { out += old.slice(at, m.start) + (n === 0 ? tests : ""); at = m.end; });
  return out + old.slice(at);
}
