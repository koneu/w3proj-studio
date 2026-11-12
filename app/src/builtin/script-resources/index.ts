// Script Resources: completion items for strings and rawcodes in JASS (and
// vJASS) code, from the game's data and the map. What a string should hold is
// read from the parameter it is passed to (common.j/Blizzard.j names it:
// modelName, iconPath, soundLabel, order, …); rawcodes are narrowed the same way
// (unitId → units). Without a known parameter, a path-like prefix lists files.

import type { ExtensionContext, W3Api } from "../../extensions/api";
import { CODE_EDITOR_SERVICE, type CodeEditorService, type CompletionItem, type CompletionRequest } from "../../extensions/services";
import { toArchiveName } from "../../lib/formats/archivepath";
import { parseIni } from "../../lib/formats/text";
import { loadKind } from "../../lib/objects/metadata";
import { ABILITY_FUNC_FILES } from "../../lib/script/objects";
import { parseSoundLabels, SOUND_INFO } from "../../lib/script/jass";

/** At most this many items per list. */
const MAX = 150;
const MODELS = ["mdx", "mdl"], TEXTURES = ["blp", "dds", "tga", "png"], SOUNDS = ["wav", "mp3", "flac", "ogg"];
const KIND_LABELS: Record<string, string> = { w3u: "unit", w3a: "ability", w3t: "item", w3h: "buff", w3q: "upgrade", w3b: "destructable", w3d: "doodad" };

/** What a parameter wants, from its name and type. */
type Want = { files: string[] } | { labels: true } | { orders: true } | { kinds: string[] } | null;
function wantOf(req: CompletionRequest): Want {
  const p = req.call?.param, n = (p?.name ?? "").toLowerCase();
  if (req.inRawcode) {
    if (/abil|spell|skill/.test(n)) return { kinds: ["w3a"] };
    if (/buff/.test(n)) return { kinds: ["w3h"] };
    if (/item/.test(n)) return { kinds: ["w3t"] };
    if (/tech|upgrade|research/.test(n)) return { kinds: ["w3q"] };
    if (/destruct/.test(n)) return { kinds: ["w3b"] };
    if (/doodad/.test(n)) return { kinds: ["w3d"] };
    if (/unit|hero|creep|building/.test(n)) return { kinds: ["w3u"] };
    return { kinds: ["w3u", "w3a", "w3t", "w3h", "w3q", "w3b", "w3d"] };
  }
  if (p && p.type !== "string") return null;
  if (/label/.test(n)) return { labels: true };
  if (/order/.test(n)) return { orders: true };
  if (/model|effect|art|missile/.test(n)) return { files: MODELS };
  if (/icon|texture|image|portrait|blp|tex\b/.test(n)) return { files: TEXTURES };
  if (/music|sound|file/.test(n)) return { files: SOUNDS };
  // No known parameter: a path being typed lists any file.
  return /[\\/]/.test(req.prefix) ? { files: [...MODELS, ...TEXTURES, ...SOUNDS] } : null;
}

/** Ranks matches: starting with the prefix first, then containing it (a file's name counts too). */
function ranked<T>(list: T[], prefix: string, keys: (x: T) => string[]): T[] {
  const q = prefix.toLowerCase().replace(/\//g, "\\");
  if (!q) return list.slice(0, MAX);
  const starts: T[] = [], contains: T[] = [];
  for (const x of list) {
    const ks = keys(x).map((k) => k.toLowerCase());
    if (ks.some((k) => k.startsWith(q))) starts.push(x);
    else if (ks.some((k) => k.includes(q))) contains.push(x);
    if (starts.length >= MAX) break;
  }
  return [...starts, ...contains].slice(0, MAX);
}

export function activate(w3: W3Api, ctx: ExtensionContext) {
  const once = <T>(load: () => Promise<T>) => { let p: Promise<T> | null = null; return () => (p ??= load().catch((e) => { p = null; throw e; })); };
  /** The game's file paths as scripts write them ("Abilities\Spells\…"), without art set/language folders. */
  const gameFiles = once(async () => {
    const seen = new Map<string, string>();
    for (const full of await w3.game.list()) {
      const plain = full.slice(full.lastIndexOf(":") + 1).replace(/\//g, "\\");
      if (!seen.has(plain.toLowerCase())) seen.set(plain.toLowerCase(), plain);
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  });
  const soundLabels = once(async () => [...parseSoundLabels(await Promise.all(SOUND_INFO.map((n) => w3.game.readText(`UI\\SoundInfo\\${n}.slk`).catch(() => "")))).keys()].sort());
  const orders = once(async () => {
    // Basic commands aren't abilities; the rest comes from the abilities' order entries.
    const out = new Set<string>(["attack", "attackground", "attackonce", "move", "patrol", "holdposition", "stop", "smart", "harvest",
      "returnresources", "repair", "build", "cancel", "rally", "setrally", "dropitem", "getitem"]);
    for (const f of ABILITY_FUNC_FILES) {
      for (const sec of parseIni(await w3.game.readText(f).catch(() => "")).values()) {
        for (const k of ["order", "orderon", "orderoff", "unorder"]) { const v = [...sec].find(([x]) => x.toLowerCase() === k)?.[1]; if (v) out.add(v); }
      }
    }
    return [...out].sort();
  });
  const objects = new Map<string, Promise<{ id: string; name: string }[]>>();
  const objectsOf = (kind: string) => {
    let p = objects.get(kind);
    if (!p) {
      p = loadKind(w3, kind).then((k) => k.baseIds.map((id) => ({ id, name: k.names.get(id) ?? id })), () => []);
      objects.set(kind, p);
    }
    return p;
  };
  /** The map's custom objects of a kind (named after their base until the editor's names are read). */
  const customOf = async (kind: string) => {
    const text = await w3.workspace.readText(`map/war3map.${kind}.json`).catch(() => null);
    if (!text) return [];
    const base = new Map((await objectsOf(kind)).map((o) => [o.id, o.name]));
    try {
      return ((JSON.parse(text) as { custom?: { id: string; base: string }[] }).custom ?? []).map((o) => ({ id: o.id, name: `${base.get(o.base) ?? o.base} (custom)` }));
    } catch { return []; }
  };
  const mapFiles = () => (w3.workspace.project() ? w3.workspace.files() : [])
    .map((f) => f.path.replace(/\\/g, "/")).filter((p) => p.toLowerCase().startsWith("map/")).map((p) => toArchiveName(p.slice(4)));

  const provide = async (req: CompletionRequest): Promise<CompletionItem[]> => {
    if (!req.inString && !req.inRawcode) return [];
    const want = wantOf(req);
    if (!want) return [];
    if ("files" in want) {
      const ext = new RegExp(`\\.(${want.files.join("|")})$`, "i");
      const imports = mapFiles().filter((p) => ext.test(p));
      const game = (await gameFiles()).filter((p) => ext.test(p));
      const name = (p: string) => [p, p.slice(p.lastIndexOf("\\") + 1)];
      return [
        ...ranked(imports, req.prefix, name).map((p): CompletionItem => ({ label: p, detail: "map import", kind: "file", boost: 1 })),
        ...ranked(game, req.prefix, name).map((p): CompletionItem => ({ label: p, detail: "game", kind: "file" })),
      ].slice(0, MAX);
    }
    if ("labels" in want) return ranked(await soundLabels(), req.prefix, (l) => [l]).map((l) => ({ label: l, detail: "sound label", kind: "constant" }));
    if ("orders" in want) return ranked(await orders(), req.prefix, (o) => [o]).map((o) => ({ label: o, detail: "order", kind: "constant" }));
    const items: CompletionItem[] = [];
    for (const kind of want.kinds) {
      const list = [...(await customOf(kind)), ...(await objectsOf(kind))];
      items.push(...ranked(list, req.prefix, (o) => [o.id, o.name]).map((o): CompletionItem => ({
        label: o.id, detail: o.name, info: `${KIND_LABELS[kind]} ${o.id}: ${o.name}`, kind: "constant", boost: o.name.endsWith("(custom)") ? 1 : 0,
      })));
    }
    return items.slice(0, MAX);
  };

  void w3.services.get<CodeEditorService>(CODE_EDITOR_SERVICE).then((editors) => {
    ctx.subscriptions.push(editors.registerCompletion({ languages: ["jass", "lua"], provide }));
  });
}
