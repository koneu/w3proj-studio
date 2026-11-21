// New, resized, renamed and joined subterrains (the Subterrains commands): the new set of rectangles the backend's
// terrain_relayout cuts the map into (crates/w3proj terrain_layout.rs relayout, `w3proj terrain relayout`). Rectangles
// are in corners, so they lie on tile boundaries by construction. Strict corner ownership: no two overlap. A rectangle
// placed over others takes what it covers from them: a subterrain it covers whole is taken in (its id ranges go with
// it), one it takes a whole side off is cut down to the rest; one it would leave in two pieces, or not a rectangle, is
// refused. What the backend refuses on top (a corner left out that isn't the default corner, past the canvas) it says.

/** A subterrain's rectangle in corners ((0, 0) the south-west corner). */
export interface SubRect { name: string; x: number; y: number; w: number; h: number }

/** One subterrain of the new set: `from` the old ones it continues (their id ranges, and the folder while the name
 *  stays); absent: the one of the same name, if there is one. */
export interface PlannedSubterrain extends SubRect { from?: string[] }

/** The backend's form: `NAME[=OLD+OLD]:x,y,w,h`. */
export const planText = (p: PlannedSubterrain): string => `${p.name}${p.from ? `=${p.from.join("+")}` : ""}:${p.x},${p.y},${p.w},${p.h}`;

/** What is left of `s` once `r` is taken out: `s` itself when they don't overlap, "empty" when `r` covers it, null
 *  when the rest isn't one rectangle. */
export function minus(s: SubRect, r: Omit<SubRect, "name">): SubRect | "empty" | null {
  const x0 = Math.max(s.x, r.x), x1 = Math.min(s.x + s.w, r.x + r.w), y0 = Math.max(s.y, r.y), y1 = Math.min(s.y + s.h, r.y + r.h);
  if (x0 >= x1 || y0 >= y1) return s;
  const allX = x0 === s.x && x1 === s.x + s.w, allY = y0 === s.y && y1 === s.y + s.h;
  if (allX && allY) return "empty";
  if (allY) {
    if (x0 === s.x) return { ...s, x: x1, w: s.x + s.w - x1 };
    if (x1 === s.x + s.w) return { ...s, w: x0 - s.x };
  } else if (allX) {
    if (y0 === s.y) return { ...s, y: y1, h: s.y + s.h - y1 };
    if (y1 === s.y + s.h) return { ...s, h: y0 - s.y };
  }
  return null;
}

/** Why `name` can't name a subterrain of `subs` (besides `except`, the one being renamed), or null. The backend checks
 *  it as a folder name too; `=`, `+`, `:`, `;` and `,` are the plan's own characters. */
export function nameProblem(name: string, subs: readonly SubRect[], except?: string): string | null {
  if (!name.trim()) return "A subterrain needs a name.";
  if (name !== name.trim()) return "A subterrain's name can't start or end with a space.";
  if (/[=+:;,/\\]/.test(name)) return `"${name}": a subterrain's name can't hold = + : ; , / or \\.`;
  const clash = subs.find((s) => s.name !== except && (s.name === name || s.name.toLowerCase() === name.toLowerCase()));
  if (clash) return `There is a subterrain "${clash.name}" already (names are folders, compared ignoring case).`;
  return null;
}

/** The new set with `placed` put over `subs`: `replacing` is the subterrain it stands for (resized: its own name;
 *  absent for a new one or a join, whose `from` names what it continues). The others keep their places in the list and
 *  give up what `placed` covers; a string says why it can't be done. */
export function placePlan(subs: readonly SubRect[], placed: PlannedSubterrain, replacing?: string): PlannedSubterrain[] | string {
  if (![placed.x, placed.y, placed.w, placed.h].every((v) => Number.isInteger(v) && v >= 0) || placed.w < 1 || placed.h < 1) {
    return `${placed.x},${placed.y},${placed.w},${placed.h} isn't a rectangle of corners (whole numbers, at least 1×1).`;
  }
  const from = [...(placed.from ?? [])];
  const out: PlannedSubterrain[] = [];
  let at = -1;
  for (const s of subs) {
    if (s.name === replacing || from.includes(s.name)) {
      if (at < 0) at = out.length;
      continue;
    }
    const rest = minus(s, placed);
    if (rest === null) return `"${placed.name}" would leave ${s.name} in pieces: give it a rectangle that takes a whole side of ${s.name} off, or all of it.`;
    if (rest === "empty") {
      from.push(s.name);
      if (at < 0) at = out.length;
      continue;
    }
    out.push({ ...rest, from: [s.name] });
  }
  const mine: PlannedSubterrain = { ...placed, from };
  out.splice(at < 0 ? out.length : at, 0, mine);
  return out;
}

/** The new set with `name` renamed to `to` (its id ranges stay, its folder is renamed). */
export function renamePlan(subs: readonly SubRect[], name: string, to: string): PlannedSubterrain[] | string {
  if (!subs.some((s) => s.name === name)) return `There is no subterrain "${name}".`;
  const why = nameProblem(to, subs, name);
  if (why) return why;
  return subs.map((s) => ({ name: s.name === name ? to : s.name, x: s.x, y: s.y, w: s.w, h: s.h, from: [s.name] }));
}

/** The new set with `names` joined into one subterrain `to` over their bounding rectangle (it takes from others what
 *  that covers, placePlan); its id ranges are all of theirs. */
export function joinPlan(subs: readonly SubRect[], names: readonly string[], to: string): PlannedSubterrain[] | string {
  const parts = names.map((n) => subs.find((s) => s.name === n));
  if (parts.length < 2 || new Set(names).size !== names.length) return "Pick two subterrains or more to join.";
  const missing = names.find((_, i) => !parts[i]);
  if (missing) return `There is no subterrain "${missing}".`;
  const why = nameProblem(to, subs.filter((s) => !names.includes(s.name)));
  if (why) return why;
  const ps = parts as SubRect[];
  const x = Math.min(...ps.map((s) => s.x)), y = Math.min(...ps.map((s) => s.y));
  const w = Math.max(...ps.map((s) => s.x + s.w)) - x, h = Math.max(...ps.map((s) => s.y + s.h)) - y;
  const inside = subs.filter((s) => !names.includes(s.name) && minus(s, { x, y, w, h }) !== s).map((s) => s.name);
  if (inside.length) return `The rectangle round ${names.join(" and ")} (${x},${y} ${w}×${h}) reaches into ${inside.join(", ")}: join ${inside.length === 1 ? "it" : "them"} too, or pick subterrains side by side.`;
  return placePlan(subs, { name: to, x, y, w, h, from: [...names] });
}

/** `x,y,w,h` as typed (spaces allowed), or null. */
export function parseRect(text: string): { x: number; y: number; w: number; h: number } | null {
  const n = text.split(",").map((v) => v.trim());
  if (n.length !== 4 || !n.every((v) => /^\d+$/.test(v))) return null;
  const [x, y, w, h] = n.map(Number);
  return { x, y, w, h };
}
