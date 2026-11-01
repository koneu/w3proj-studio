// File type and mod layer filters for the game data browser.

/** File type filters: label → extensions. */
export const CATEGORIES: { id: string; label: string; exts: string[] }[] = [
  { id: "texture", label: "Textures", exts: ["dds", "blp", "tga", "png", "jpg", "jpeg"] },
  { id: "model", label: "Models", exts: ["mdx", "mdl"] },
  { id: "sound", label: "Sounds", exts: ["wav", "mp3", "ogg", "flac"] },
  { id: "data", label: "Data", exts: ["slk", "txt", "ini", "json", "xml", "csv"] },
  { id: "ui", label: "UI", exts: ["fdf", "toc"] },
  { id: "script", label: "Scripts", exts: ["j", "lua", "ai", "pld"] },
  { id: "map", label: "Maps", exts: ["w3x", "w3m", "w3n"] },
  { id: "anim", label: "Animation", exts: ["animset_ingame", "facefx_ingame", "pkb", "bls"] },
  { id: "video", label: "Video", exts: ["webm", "avi", "bik"] },
  { id: "font", label: "Fonts", exts: ["ttf", "otf"] },
];
export const EXT_CATEGORY = new Map(CATEGORIES.flatMap((c) => c.exts.map((e) => [e, c.id] as const)));
export const categoryOf = (path: string) => EXT_CATEGORY.get(path.slice(path.lastIndexOf(".") + 1).toLowerCase()) ?? "other";

/** Layer filters, matched against the full path's mod prefix. */
export const LAYERS: { id: string; label: string; test: (lower: string) => boolean }[] = [
  { id: "all", label: "All layers", test: () => true },
  { id: "sd", label: "Base (SD)", test: (p) => !/:_(hd|de|teen|deprecated|balance|locales|tilesets)[/.]/.test(p) },
  { id: "hd", label: "HD", test: (p) => p.includes(":_hd.w3mod:") },
  { id: "de", label: "DE (3.0)", test: (p) => p.includes(":_de.w3mod:") },
  { id: "locales", label: "Locales", test: (p) => p.includes(":_locales/") },
  { id: "tilesets", label: "Tilesets", test: (p) => p.includes(":_tilesets/") },
  { id: "teen", label: "Teen", test: (p) => p.includes(":_teen.w3mod:") },
  { id: "balance", label: "Balance", test: (p) => p.includes(":_balance/") },
  { id: "deprecated", label: "Deprecated", test: (p) => p.includes(":_deprecated.w3mod:") },
];
