// The World Editor's Export Current Values: the light as it is now, saved to a file outside the map.

import type { W3Api } from "../../extensions/api";
import { writeLightMdl, writeLightMdx, type LightModel } from "../../lib/model/dnclight";

/** The bytes of `model` for a file named `path`: .mdx or .mdl by its ending; throws for any other. */
export function exportBytes(model: LightModel, path: string): Uint8Array {
  if (/\.mdx$/i.test(path)) return writeLightMdx(model);
  if (/\.mdl$/i.test(path)) return new TextEncoder().encode(writeLightMdl(model));
  throw new Error("A light model is exported as .mdx or .mdl: give the file one of these endings.");
}

export async function exportLight(w3: W3Api, model: LightModel): Promise<void> {
  const path = await w3.window.pickSaveFile({
    title: "Export Current Values", defaultPath: `${model.name || "Light"}.mdx`,
    filters: [{ name: "Warcraft 3 Binary Model (.mdx)", extensions: ["mdx"] }, { name: "Warcraft 3 Model (.mdl)", extensions: ["mdl"] }],
  });
  if (!path) return;
  await w3.backend.writeBytes(path, exportBytes(model, path));
  void w3.window.showInfo(`Exported ${model.name || "the light"} to ${path}`);
}
