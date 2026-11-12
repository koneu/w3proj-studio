// Which texture a model's replaceable id shows for an object type: shared by the terrain view and the Object Editor's
// model preview, so both pick the same file.

/** The type's replaceable texture (a destructable's btxi / btxf). Destructable skins give the extension
 *  (ReplaceableTextures\Cliff\Cliff1.blp), doodad skins don't. */
export function skinTextures(skin: { texId: number; texFile: string }): Record<number, string> {
  if (!(skin.texId > 0 && skin.texFile)) return {};
  return { [skin.texId]: /\.\w{3}$/.test(skin.texFile) ? skin.texFile : `${skin.texFile}.blp` };
}
