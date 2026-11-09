// A campaign's chapter maps use the campaign's custom objects (war3campaign.w3u, .w3t, … in the campaign
// project's map/ folder, two folders above the chapter's project: <campaign>/maps/<chapter>). The game and
// the World Editor put the campaign's object data under the map's own: the map's wins where both have an
// object or a field.

import type { W3Api } from "../../extensions/api";
import { isNotFoundError } from "../oserror";
import { joinPath } from "../paths";

/** Where a campaign project would be, going by the folder layout (<campaign>/maps/<chapter>), else
 *  undefined. Forward slashes, which Windows takes too. `findCampaign` also checks that there is one. */
export function campaignOf(root: string | undefined): string | undefined {
  const m = root ? /^(.*)[\\/]maps[\\/][^\\/]+[\\/]?$/i.exec(root)?.[1] : undefined;
  return m?.replace(/\\/g, "/");
}

/** The campaign project a chapter map's project sits in: the folder two up, if it holds war3campaign.w3f
 *  (in its project or raw form), as the Campaign Editor decides. Else undefined. Throws, saying why,
 *  when that can't be found out: an unknown answer must not count as "no campaign", or the
 *  campaign's objects and files would all look missing. `root`: that project's (the open one's by default). */
export async function findCampaign(w3: W3Api, root = w3.workspace.project()?.root): Promise<string | undefined> {
  const campaign = campaignOf(root);
  if (!campaign) return undefined;
  for (const name of ["war3campaign.w3f.json", "war3campaign.w3f"]) {
    const path = `${campaign}/map/${name}`;
    let there: boolean;
    try { there = await w3.backend.invoke<boolean>("fs_exists", { path }); } catch (e) {
      throw new Error(`Whether ${campaign} is this chapter map's campaign couldn't be checked: ${path} (${e instanceof Error ? e.message : String(e)}).`);
    }
    if (there) return campaign;
  }
  return undefined;
}

/** The object data kinds a campaign has (war3campaign.<kind>). */
export const CAMPAIGN_OBJECT_KINDS = ["w3u", "w3t", "w3a", "w3h", "w3b", "w3d", "w3q"] as const;

/** A campaign's object file of `kind` (`skin`: war3campaignSkin.<kind>), as JSON: its project form, else the raw file
 *  through its codec. Null when the campaign has neither; throws, naming it, when it's there but can't be read (an
 *  unreadable file must not pass for one without objects). */
export async function readCampaignObjects<T = unknown>(w3: W3Api, campaign: string, kind: string, skin = false): Promise<T | null> {
  const rel = `map/war3campaign${skin ? "Skin" : ""}.${kind}`;
  const json = joinPath(campaign, `${rel}.json`);
  const unreadable = (path: string, e: unknown) => new Error(`${path} is there but can't be read (${e instanceof Error ? e.message : String(e)}).`);
  let text: string | null = null;
  try { text = await w3.workspace.readText(json); } catch (e) {
    if (!isNotFoundError(e)) throw unreadable(json, e);
  }
  if (text !== null) {
    try { return JSON.parse(text) as T; } catch (e) { throw unreadable(json, e); }
  }
  const raw = joinPath(campaign, rel);
  let there: boolean;
  try { there = await w3.backend.invoke<boolean>("fs_exists", { path: raw }); } catch (e) { throw unreadable(raw, e); }
  if (!there) return null;
  try { return JSON.parse(await w3.backend.invoke<string>("codec_decode", { root: campaign, path: rel })) as T; } catch (e) { throw unreadable(raw, e); }
}

/** Whether `path` (as the workspace reports saves: a project path, or an absolute one) is one of a campaign's object
 *  files: saving one changes what its chapter maps' objects are. */
export function isCampaignObjectFile(path: string, campaign: string | undefined): boolean {
  const p = path.replace(/\\/g, "/");
  const m = /^(.*\/)?map\/war3campaign(?:Skin)?\.(w3[utahbdq])(\.json)?$/i.exec(p);
  if (!m || !campaign) return false;
  const dir = (m[1] ?? "").replace(/\/+$/, "");
  const base = campaign.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:/i.test(base) ? dir.toLowerCase() === base.toLowerCase() : dir === base;
}
