// Which saved files change what the terrain editor has loaded.

/** The minimap and preview are generated from the map, by the editor's own save. They're images
 *  under map/, but no model uses them: taking them for imports reloaded every model on each save. */
const GENERATED_ART = /^map\/war3map(map|preview)\.(blp|tga|dds)$/;

/** An imported model or texture, or the import list: loaded art may be out of date. */
export function changesImports(path: string): boolean {
  const l = path.replace(/\\/g, "/").toLowerCase();
  if (GENERATED_ART.test(l)) return false;
  return /^map\/war3map\.imp(\.json)?$/.test(l) || (l.startsWith("map/") && /\.(mdx|mdl|blp|dds|tga)$/.test(l));
}
