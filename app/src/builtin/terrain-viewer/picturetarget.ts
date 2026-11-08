// Which terrain editor terrain_screenshot takes its picture of. A project can hold two terrain files
// (war3map.w3e and war3map.w3e.txt), each with its own editor tab: the picture is never of a tab the
// user doesn't see when one they see would do.

/**
 * The terrain file to take the picture of: the one asked for; else the one in front, when it is one
 * of the project's terrain files; else one whose editor is open; else null (the project's own,
 * opened if need be). `terrains` are the project's terrain files. Paths compare without case.
 */
export function pictureTarget(asked: unknown, active: string | null, terrains: readonly string[], isOpen: (path: string) => boolean): string | null {
  const known = (p: string) => terrains.find((t) => t.toLowerCase() === p.toLowerCase());
  if (asked !== undefined && asked !== null && asked !== "") {
    const found = typeof asked === "string" ? known(asked.replace(/\\/g, "/")) : undefined;
    if (!found) throw new Error(`file must be one of the project's terrain files: ${terrains.join(", ") || "it has none"}.`);
    return found;
  }
  if (active && known(active)) return active;
  return terrains.find(isOpen) ?? null;
}
