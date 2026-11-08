// Which files Gameplay Constants and Game Interface edit: a map's war3mapMisc.txt and war3mapSkin.txt with
// war3map.wts, or a campaign's war3campaignMisc.txt and war3campaignSkin.txt with war3campaign.wts. The
// World Editor's Campaign Editor has both under its Advanced menu; a campaign's values apply to its chapters.

export interface SettingsFiles { misc: string; skin: string; wts: string }

export const MAP_FILES: SettingsFiles = { misc: "map/war3mapMisc.txt", skin: "map/war3mapSkin.txt", wts: "map/war3map.wts" };
export const CAMPAIGN_FILES: SettingsFiles = { misc: "map/war3campaignMisc.txt", skin: "map/war3campaignSkin.txt", wts: "map/war3campaign.wts" };
/** The file that makes a project a campaign. */
export const CAMPAIGN_INFO = "map/war3campaign.w3f.json";

/** The files of a project with these files (project paths, any case). */
export function settingsFiles(paths: readonly string[]): SettingsFiles {
  const info = CAMPAIGN_INFO.toLowerCase();
  return paths.some((p) => p.replace(/\\/g, "/").toLowerCase() === info) ? CAMPAIGN_FILES : MAP_FILES;
}

/** What an editor of `path` edits: Gameplay Constants or Game Interface, and the string table its TRIGSTR
 *  references point into (the one next to it: a campaign file's are the campaign's). */
export function settingsOf(path: string): { mode: "misc" | "skin"; wts: string; campaign: boolean } {
  const slash = path.replace(/\\/g, "/");
  const name = slash.slice(slash.lastIndexOf("/") + 1);
  const dir = slash.slice(0, slash.length - name.length);
  const campaign = /^war3campaign/i.test(name);
  return { mode: /misc\.txt$/i.test(name) ? "misc" : "skin", wts: `${dir}${campaign ? "war3campaign.wts" : "war3map.wts"}`, campaign };
}
