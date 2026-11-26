// Lighting Editor: the map's own day/night lighting, like World Editor 3.0.1's lighting editor.
//
// war3map.w3l (format "lights") names the map's terrain and unit lighting models and says whether
// each is used; the models are "<guid>.mdl" text files in the map (also in war3map.imp), copies of
// the game's DNC models (Environment\DNC\…, one per tileset in WorldEditData's TerrainLights and
// UnitLights). The side bar shows both slots: customize (copy a game model into the map), turn
// on/off, remove, and edit there with the terrain view beside it showing the light (session.ts).
// The editor of a lighting model (any .mdl that is one, in a tab) has the same form (form.ts):
// intensities, the colours over the day and the direction. Both write the text as the World Editor
// does (lib/model/dnclight) and export it (export.ts).

import type { ExtensionContext, W3Api } from "../../extensions/api";
import { LIGHT_PREVIEW_SERVICE, type LightPreviewService } from "../../extensions/services";
import { lightForms, type FormHost } from "./form";
import { exportLight } from "./export";
import { lightSession } from "./session";
import { slotKeys, type LightKind } from "../../lib/terrain/lightslots";
import { parseIni } from "../../lib/formats/text";
import { readLightMdl, readLightMdx, writeLightMdl, type LightModel } from "../../lib/model/dnclight";
import { TILESETS } from "../../lib/terrain/tilesets";
import { bindUndoKeys, History } from "../../lib/undo";
import { h } from "../../workbench/dom";
import { errorText } from "../../lib/oserror";

const VIEW = "w3.lighting.overview";
type Kind = LightKind;
const KINDS: [Kind, string, string][] = [["terrain", "Terrain lighting", "TerrainLights"], ["unit", "Unit lighting", "UnitLights"]];

interface Lights {
  format: string; magic: string; version: number;
  terrainModel: string; unitModel: string; terrainEnabled: number; unitEnabled: number; unknown: number;
}
interface Imports { format: string; version: number; files: { flags: number; path: string }[] }

/** A map file in either project form (JSON, or the raw file through its format definition). */
async function readMapDoc<T>(w3: W3Api, name: string): Promise<{ doc: T; json: boolean } | null> {
  const files = new Set(w3.workspace.files().map((f) => f.path.toLowerCase()));
  const path = `map/${name}`;
  if (files.has(`${path}.json`.toLowerCase())) return { doc: JSON.parse(await w3.workspace.readText(`${path}.json`)) as T, json: true };
  if (files.has(path.toLowerCase())) {
    const text = await w3.backend.invoke<string>("codec_decode", { root: w3.workspace.project()!.root, path });
    return { doc: JSON.parse(text) as T, json: false };
  }
  return null;
}

async function writeMapDoc(w3: W3Api, name: string, doc: unknown, json: boolean) {
  const root = w3.workspace.project()!.root, path = `map/${name}`;
  if (json) await w3.workspace.writeText(`${path}.json`, await w3.backend.invoke<string>("codec_canonicalize", { root, path: `${path}.json`, text: JSON.stringify(doc) }));
  else await w3.backend.invoke("codec_write", { root, path, text: JSON.stringify(doc) });
}

const emptyLights = (): Lights => ({ format: "w3proj.lights/1", magic: "W3L!", version: 3, terrainModel: "", unitModel: "", terrainEnabled: 0, unitEnabled: 0, unknown: 0 });

/** The game's lighting models per tileset letter (WorldEditData.txt), for terrain and units. */
async function gameModels(w3: W3Api): Promise<Record<Kind, Map<string, string>>> {
  const data = parseIni(await w3.game.readText("UI\\WorldEditData.txt"));
  // parseIni lowercases keys; tileset letters are upper case everywhere else.
  const of = (section: string) => new Map([...(data.get(section) ?? new Map())].map(([k, v]) => [k.toUpperCase(), v]));
  return { terrain: of("TerrainLights"), unit: of("UnitLights") };
}

const modelName = (path: string) => path.replace(/^.*[\\/]/, "").replace(/\.\w+$/, "");

export function activate(w3: W3Api, ctx: ExtensionContext) {
  let busy = false;
  const failed = (e: unknown) => w3.window.showError(String((e as Error).message ?? e));

  const session = lightSession(w3, () => w3.views.refresh(VIEW));
  ctx.subscriptions.push(w3.services.provide<LightPreviewService>(LIGHT_PREVIEW_SERVICE, session.preview), session);

  /** Copies the game model at `gamePath` (an .mdl path as WorldEditData names it) into the map. */
  const customize = async (kind: Kind, gamePath: string) => {
    const mdx = `War3.w3mod:${gamePath.replace(/\\/g, "/").replace(/\.mdl$/i, ".mdx")}`;
    const model = readLightMdx(await w3.game.read(mdx));
    const file = `${crypto.randomUUID()}.mdl`;
    await w3.workspace.writeText(`map/${file}`, writeLightMdl(model));
    const lights = (await readMapDoc<Lights>(w3, "war3map.w3l")) ?? { doc: emptyLights(), json: true };
    lights.doc[slotKeys(kind).model] = file;
    lights.doc[slotKeys(kind).enabled] = 1;
    await writeMapDoc(w3, "war3map.w3l", lights.doc, lights.json);
    // Registered as an import, newest first (as the World Editor does).
    const imports = (await readMapDoc<Imports>(w3, "war3map.imp")) ?? { doc: { format: "w3proj.imports/1", version: 1, files: [] }, json: true };
    imports.doc.files.unshift({ flags: 21, path: file });
    await writeMapDoc(w3, "war3map.imp", imports.doc, imports.json);
    await w3.workspace.refresh();
    await session.open(kind, file);
  };

  /** Takes the map's model for `kind` out: the file, its import entry, its name in war3map.w3l. */
  const remove = async (kind: Kind, lights: { doc: Lights; json: boolean }) => {
    const file = lights.doc[slotKeys(kind).model];
    const ok = await w3.window.showWarning(`Remove the map's ${kind} lighting (${file})? The tileset's lighting is used again.`, "Remove", "Cancel");
    if (ok !== "Remove") return;
    await session.close();
    await w3.editors.close(`map/${file}`).catch(() => {});
    await w3.workspace.delete(`map/${file}`).catch(() => {});
    lights.doc[slotKeys(kind).model] = "";
    lights.doc[slotKeys(kind).enabled] = 0;
    await writeMapDoc(w3, "war3map.w3l", lights.doc, lights.json);
    const imports = await readMapDoc<Imports>(w3, "war3map.imp");
    if (imports) {
      imports.doc.files = imports.doc.files.filter((f) => f.path.toLowerCase() !== file.toLowerCase());
      await writeMapDoc(w3, "war3map.imp", imports.doc, imports.json);
    }
    await w3.workspace.refresh();
  };

  const run = (action: () => Promise<void>) => async () => {
    if (busy) return;
    busy = true;
    try { await action(); } catch (e) { failed(e); } finally { busy = false; w3.views.refresh(VIEW); }
  };

  ctx.subscriptions.push(
    w3.commands.register("w3.lighting.show", () => w3.views.show("lighting")),
    w3.workspace.onDidChange(() => w3.views.refresh(VIEW)),
    w3.views.register(VIEW, {
      render(el) {
        if (!w3.workspace.project()) { el.append(h("div.view-empty", {}, "Open or import a project to edit its lighting.")); return; }
        const body = h("div.lighting-view", {}, h("div.view-empty", {}, "Reading…"));
        el.append(body);
        void (async () => {
          const [lights, models, info] = await Promise.all([
            readMapDoc<Lights>(w3, "war3map.w3l"),
            gameModels(w3),
            readMapDoc<{ tileset: string; lightEnvironment?: string }>(w3, "war3map.w3i"),
          ]);
          // The map's light environment (Map Properties › Environment), else its tileset.
          const tileset = (info?.doc.lightEnvironment || info?.doc.tileset || "L").toUpperCase();
          // The model name inside each of the map's own models (the game model it was copied from).
          const ownNames = new Map(await Promise.all(KINDS.map(async ([kind]) => {
            const file = lights?.doc[slotKeys(kind).model];
            const text = file ? await w3.workspace.readText(`map/${file}`).catch(() => null) : null;
            return [kind, text === null ? "missing file" : /^Model "([^"]*)"/m.exec(text)?.[1] ?? file] as const;
          })));
          const sections = KINDS.map(([kind, title]) => {
            const fallback = models[kind].get(tileset) ?? [...models[kind].values()][0] ?? "";
            const own = lights?.doc[slotKeys(kind).model] ?? "";
            const enabled = (lights?.doc[slotKeys(kind).enabled] ?? 0) !== 0;
            const rows: (HTMLElement | null)[] = [
              h("div.lighting-row.muted", { title: fallback }, `Tileset (${TILESETS[tileset] ?? tileset}): ${modelName(fallback)}`),
            ];
            if (own && lights) {
              const box = h("input", { type: "checkbox", checked: enabled, onchange: run(async () => {
                lights.doc[slotKeys(kind).enabled] = box.checked ? 1 : 0;
                await writeMapDoc(w3, "war3map.w3l", lights.doc, lights.json);
              }) });
              rows.push(
                h("div.lighting-row", { title: own }, `Map's own: ${ownNames.get(kind)}`),
                h("label.lighting-row", { title: "Off: the tileset's lighting is used, the map's model stays" }, box, " Use the map's own lighting"),
                session.isOpen(kind, own) ? null : h("div.lighting-row", {},
                  h("button", { title: "Edit it here, with the map's terrain view showing the changes", onclick: () => void session.open(kind, own).catch(failed) }, "Edit"),
                  " ", h("button.link-inline", { onclick: run(() => remove(kind, lights)) }, "Remove")),
                session.isOpen(kind, own) ? session.element() : null,
              );
            } else {
              const distinct = [...new Set([fallback, ...models[kind].values()])].filter(Boolean);
              rows.push(h("div.lighting-row", {}, h("button", {
                title: "Copy one of the game's lighting models into the map and edit it",
                onclick: run(async () => {
                  const pick = await w3.window.quickPick(distinct.map((p) => ({
                    label: modelName(p) + (p === fallback ? " (this tileset's)" : ""),
                    description: [...models[kind]].filter(([, v]) => v === p).map(([k]) => TILESETS[k] ?? k).join(", "),
                    value: p,
                  })), { placeholder: `Start the map's ${kind} lighting from…` });
                  if (pick?.value) await customize(kind, pick.value);
                }),
              }, "Customize…")));
            }
            return h("section.lighting-section", {}, h("h4", {}, title), ...rows);
          });
          body.replaceChildren(
            ...(lights ? [] : [h("div.view-empty", {}, "No war3map.w3l yet (maps saved before World Editor 3.0.1); customizing creates it.")]),
            ...sections,
          );
        })().catch((e) => body.replaceChildren(h("div.view-empty", {}, String((e as Error).message ?? e))));
      },
    }),

    w3.editors.registerProvider("w3.lightingEditor", {
      async resolve(el, doc) {
        let model: LightModel;
        try {
          model = readLightMdl(await doc.readText());
          if (!model.lights.length) throw new Error("it has no lights");
        } catch (e) {
          el.append(h("div.view-empty", {}, `${doc.path} isn't a lighting model: ${errorText(e)} `,
            h("button.link-inline", { onclick: () => w3.editors.open(doc.path, "w3.textEditor") }, "Open as text"), " ",
            h("button.link-inline", { onclick: () => w3.editors.open(doc.path, "w3.modelViewer") }, "Open in Model Viewer")));
          return {};
        }
        const history = new History(() => JSON.stringify(model), (state) => {
          model = JSON.parse(state) as LightModel;
          doc.setDirty(history.dirty);
          render();
        });
        /** After every change; `group` keeps dragging in one colour picker one undo step. */
        const changed = (group?: unknown) => { history.commit(group); doc.setDirty(history.dirty); };
        const root = h("div.form-body.lighting-editor");
        el.append(root);
        const unbindKeys = bindUndoKeys(el, () => history.undo(), () => history.redo(), (e) => w3.keybindings.commandsFor(e));

        const host: FormHost = { model: () => model, changed, refused: (why) => void w3.window.showError(why) };
        const render = (): void => {
          root.replaceChildren(
            h("div.lighting-head", {}, h("strong", {}, model.name), h("span.muted", {}, ` · ${doc.path.replace(/^map\//, "")} · times as hours of the game day`),
              " ", h("button", { title: "Save the light as it is here to a file (.mdx or .mdl), the World Editor's Export Current Values", onclick: () => void exportLight(w3, model).catch(failed) }, "Export…")),
            ...lightForms(host, render),
          );
        };
        render();
        return {
          undo: () => { history.undo(); },
          redo: () => { history.redo(); },
          async save() {
            const taken = history.mark();
            await doc.writeText(writeLightMdl(model));
            history.markSaved(taken);
            doc.setDirty(history.dirty);
          },
          dispose: unbindKeys,
        };
      },
    }),
  );
}
