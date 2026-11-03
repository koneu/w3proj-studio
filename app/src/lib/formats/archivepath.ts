// Archive names (war3mapImported\x.mdx) ↔ project paths (war3mapImported/x.mdx),
// as the unpacker maps them (crates/w3proj/src/paths.rs): `\` separates
// folders; characters Windows rejects, `%`, `/`, trailing dots/spaces and
// device names are escaped as %XX per component.

const RESERVED = new Set(["CON", "PRN", "AUX", "NUL", ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)]);

const mustEscape = (c: string) => /[<>:"|?*%/\\]/.test(c) || c.charCodeAt(0) < 0x20;
const escaped = (c: string) => [...new TextEncoder().encode(c)].map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join("");

function escapeComponent(comp: string): string {
  const reserved = RESERVED.has((comp.split(".")[0] ?? "").toUpperCase());
  const chars = [...comp];
  return chars.map((c, i) => (mustEscape(c) || (i + 1 === chars.length && (c === "." || c === " ")) || (reserved && i === 0) ? escaped(c) : c)).join("");
}

/** Archive name → project path below the map folder ("/"-separated). */
export function toProjectPath(archiveName: string): string {
  const chars = [...archiveName];
  const comps: string[] = [""];
  chars.forEach((c, i) => {
    // Separators that would give empty components stay part of the name (escaped).
    const emptySide = i === 0 || i + 1 === chars.length || chars[i - 1] === "\\";
    if (c === "\\" && !emptySide) comps.push("");
    else comps[comps.length - 1] += c;
  });
  return comps.map(escapeComponent).join("/");
}

/** Project path below the map folder → archive name. */
export function toArchiveName(projectPath: string): string {
  return projectPath.split("/").map((part) => {
    const bytes: number[] = [];
    for (let i = 0; i < part.length;) {
      const hex = part[i] === "%" ? part.slice(i + 1, i + 3) : "";
      if (/^[0-9a-fA-F]{2}$/.test(hex)) { bytes.push(parseInt(hex, 16)); i += 3; continue; }
      bytes.push(...new TextEncoder().encode(part[i]));
      i++;
    }
    return new TextDecoder().decode(new Uint8Array(bytes));
  }).join("\\");
}
