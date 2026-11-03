// Edits of INI-style [section] key=value files that keep everything else as it
// is (order, comments, line endings, other sections): war3mapMisc.txt and
// war3mapSkin.txt hold only the values a map changes.

const header = (line: string) => /^\s*\[([^\]]*)\]/.exec(line)?.[1];

/** [section] → key (case-insensitive lookups use lower case) → raw value. */
export function readIni(text: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  let sec: Map<string, string> | undefined;
  for (const line of text.split(/\r?\n/)) {
    const h = header(line);
    if (h !== undefined) {
      const key = h.toLowerCase();
      sec = out.get(key) ?? new Map();
      out.set(key, sec);
      continue;
    }
    if (!sec || /^\s*(\/\/|;)/.test(line)) continue;
    const eq = line.indexOf("=");
    if (eq > 0) sec.set(line.slice(0, eq).trim().toLowerCase(), line.slice(eq + 1));
  }
  return out;
}

/** `text` with `key` in `[section]` set to `value`, or removed (`null`). A missing section is
 *  appended; a section left empty is removed. */
export function setIniValue(text: string, section: string, key: string, value: string | null): string {
  // The file's own line endings; new files get the World Editor's (CRLF).
  const eol = text.includes("\r\n") || !text.includes("\n") ? "\r\n" : "\n";
  const lines = text.length ? text.split(/\r?\n/) : [];
  let start = -1, end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const h = header(lines[i]);
    if (h === undefined) continue;
    if (start >= 0) { end = i; break; }
    if (h.toLowerCase() === section.toLowerCase()) start = i;
  }
  if (start < 0) {
    if (value === null) return text;
    if (!lines.length) return [`[${section}]`, `${key}=${value}`, ""].join(eol);
    // A new section after the others: an empty line before it, the file's own ending after it.
    let at = lines.length;
    while (at > 0 && lines[at - 1] === "") at--;
    const trailing = lines.length - at;
    lines.splice(at, 0, "", `[${section}]`, `${key}=${value}`);
    if (trailing === 0) lines.push("");
    return lines.join(eol);
  }
  const at = lines.findIndex((l, i) => i > start && i < end && !/^\s*(\/\/|;)/.test(l) && l.indexOf("=") > 0
    && l.slice(0, l.indexOf("=")).trim().toLowerCase() === key.toLowerCase());
  if (value === null) {
    if (at < 0) return text;
    lines.splice(at, 1);
    end--;
    // Drop a section that has no entries left (with the empty line after it).
    const rest = lines.slice(start + 1, end);
    if (rest.every((l) => l.trim() === "" || /^\s*(\/\/|;)/.test(l))) {
      // Undoes adding the section: the header (with the empty line before it) and its content up
      // to its trailing empty lines, which stay as the file's ending or separator.
      let last = end;
      while (last > start + 1 && lines[last - 1].trim() === "") last--;
      const from = start > 0 && lines[start - 1].trim() === "" ? start - 1 : start;
      lines.splice(from, last - from);
    }
    return lines.join(eol);
  }
  if (at >= 0) lines[at] = `${lines[at].slice(0, lines[at].indexOf("=")).trimEnd()}=${value}`;
  else {
    // After the section's last entry (before trailing empty lines).
    let ins = end;
    while (ins > start + 1 && lines[ins - 1].trim() === "") ins--;
    lines.splice(ins, 0, `${key}=${value}`);
  }
  return lines.join(eol);
}
