// Export Minimap: the map's own minimap picture (war3mapMap.blp) as a PNG file anywhere on disk.

import type { W3Api } from "../../extensions/api";
import { decodeImage } from "../../lib/image/index";
import { encodePng } from "../../lib/image/png";

/** A BLP minimap as PNG bytes. */
export async function minimapPng(blp: Uint8Array): Promise<{ png: Uint8Array; width: number; height: number }> {
  const mip = decodeImage(blp, "war3mapMap.blp").mip(0);
  return { png: await encodePng(mip.width, mip.height, mip.rgba), width: mip.width, height: mip.height };
}

/** Asks for a file and writes the minimap there; returns the path, null when cancelled. */
export async function exportMinimap(w3: W3Api): Promise<string | null> {
  const project = w3.workspace.project();
  if (!project) throw new Error("Open or import a project first.");
  const blp = await w3.workspace.readBytes("map/war3mapMap.blp").catch(() => null);
  if (!blp) throw new Error("This map has no minimap (war3mapMap.blp) yet. Saving the terrain editor makes it.");
  const { png, width, height } = await minimapPng(blp);
  const target = await w3.window.pickSaveFile({ title: "Export Minimap", defaultPath: `${project.name} minimap.png`, filters: [{ name: "PNG image", extensions: ["png"] }] });
  if (!target) return null;
  const path = /\.png$/i.test(target) ? target : `${target}.png`;
  await w3.backend.writeBytes(path, png);
  void w3.window.showInfo(`Minimap (${width}×${height}) exported to ${path}`);
  return path;
}
