// Lighting Editor: the map's own day/night lighting, like World Editor 3.0.1's lighting editor.
//
// war3map.w3l (format "lights") names the map's terrain and unit lighting models and says whether
// each is used; the models are "<guid>.mdl" text files in the map (also in war3map.imp), copies of
// the game's DNC models (Environment\DNC\…, one per tileset in WorldEditData's TerrainLights and
// UnitLights). The side bar shows both slots: customize (copy a game model into the map), turn
// on/off, remove. The editor (any .mdl that is a lighting model) edits intensities, the colours
// over the day and the direction; it writes the text as the World Editor does (lib/model/dnclight).

import type { ExtensionContext, W3Api } from "../../extensions/api";
import { parseIni } from "../../lib/formats/text";
import { readLightMdl, readLightMdx, writeLightMdl, type Light, type LightModel, type Prop, type Track } from "../../lib/model/dnclight";
import { TILESETS } from "../../lib/terrain/tilesets";
import { bindUndoKeys, History } from "../../lib/undo";
import { h } from "../../workbench/dom";
import { errorText } from "../../lib/oserror";

const VIEW = "w3.lighting.overview";
type Kind = "terrain" | "unit";
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

  /** Copies the game model at `gamePath` (an .mdl path as WorldEditData names it) into the map. */
  const customize = async (kind: Kind, gamePath: string) => {
    const mdx = `War3.w3mod:${gamePath.replace(/\\/g, "/").replace(/\.mdl$/i, ".mdx")}`;
    const model = readLightMdx(await w3.game.read(mdx));
    const file = `${crypto.randomUUID()}.mdl`;
    await w3.workspace.writeText(`map/${file}`, writeLightMdl(model));
    const lights = (await readMapDoc<Lights>(w3, "war3map.w3l")) ?? { doc: emptyLights(), json: true };
    lights.doc[`${kind}Model`] = file;
    lights.doc[`${kind}Enabled`] = 1;
    await writeMapDoc(w3, "war3map.w3l", lights.doc, lights.json);
    // Registered as an import, newest first (as the World Editor does).
    const imports = (await readMapDoc<Imports>(w3, "war3map.imp")) ?? { doc: { format: "w3proj.imports/1", version: 1, files: [] }, json: true };
    imports.doc.files.unshift({ flags: 21, path: file });
    await writeMapDoc(w3, "war3map.imp", imports.doc, imports.json);
    await w3.workspace.refresh();
    await w3.editors.open(`map/${file}`, "w3.lightingEditor");
  };

  /** Takes the map's model for `kind` out: the file, its import entry, its name in war3map.w3l. */
  const remove = async (kind: Kind, lights: { doc: Lights; json: boolean }) => {
    const file = lights.doc[`${kind}Model`];
    const ok = await w3.window.showWarning(`Remove the map's ${kind} lighting (${file})? The tileset's lighting is used again.`, "Remove", "Cancel");
    if (ok !== "Remove") return;
    await w3.editors.close(`map/${file}`).catch(() => {});
    await w3.workspace.delete(`map/${file}`).catch(() => {});
    lights.doc[`${kind}Model`] = "";
    lights.doc[`${kind}Enabled`] = 0;
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
            const file = lights?.doc[`${kind}Model`];
            const text = file ? await w3.workspace.readText(`map/${file}`).catch(() => null) : null;
            return [kind, text === null ? "missing file" : /^Model "([^"]*)"/m.exec(text)?.[1] ?? file] as const;
          })));
          const sections = KINDS.map(([kind, title]) => {
            const fallback = models[kind].get(tileset) ?? [...models[kind].values()][0] ?? "";
            const own = lights?.doc[`${kind}Model`] ?? "";
            const enabled = (lights?.doc[`${kind}Enabled`] ?? 0) !== 0;
            const rows: (HTMLElement | null)[] = [
              h("div.lighting-row.muted", { title: fallback }, `Tileset (${TILESETS[tileset] ?? tileset}): ${modelName(fallback)}`),
            ];
            if (own && lights) {
              const box = h("input", { type: "checkbox", checked: enabled, onchange: run(async () => {
                lights.doc[`${kind}Enabled`] = box.checked ? 1 : 0;
                await writeMapDoc(w3, "war3map.w3l", lights.doc, lights.json);
              }) });
              rows.push(
                h("div.lighting-row", { title: own }, `Map's own: ${ownNames.get(kind)}`),
                h("label.lighting-row", { title: "Off: the tileset's lighting is used, the map's model stays" }, box, " Use the map's own lighting"),
                h("div.lighting-row", {}, h("button.link-inline", { title: own, onclick: () => w3.editors.open(`map/${own}`, "w3.lightingEditor").catch(failed) }, "Edit"),
                  " ", h("button.link-inline", { onclick: run(() => remove(kind, lights)) }, "Remove")),
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
        const seq = model.sequences[0] ?? { start: 0, end: 60000 };
        const span = Math.max(1, seq.end - seq.start);
        /** Animation time ↔ hour of the game day (the "Stand" sequence spans one day). */
        const toHour = (t: number) => ((t - seq.start) / span) * 24;
        const toTime = (hour: number) => Math.round(seq.start + (hour / 24) * span);
        const root = h("div.form-body.lighting-editor");
        el.append(root);
        const unbindKeys = bindUndoKeys(el, () => history.undo(), () => history.redo(), (e) => w3.keybindings.commandsFor(e));

        const num = (get: () => number, set: (v: number) => void, step = "0.05") => {
          const input = h("input.form-input.form-num.lighting-num", { type: "number", step, value: String(Number(get().toPrecision(6))) });
          input.addEventListener("change", () => {
            const v = Number(input.value);
            if (input.value === "" || !Number.isFinite(v)) { input.classList.add("invalid"); return; }
            input.classList.remove("invalid");
            set(v);
            changed();
          });
          return input;
        };
        // Light colours are stored blue, green, red (the game's night colour reads as blue that way).
        const hex = (c: number[]) => "#" + [c[2], c[1], c[0]].map((v) => Math.round(Math.min(1, Math.max(0, v ?? 0)) * 255).toString(16).padStart(2, "0")).join("");
        const unhex = (s: string) => [5, 3, 1].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);
        const row = (label: string, ...control: (Node | string)[]) => h("div.form-row", {}, h("span.form-label", {}, label), h("div.form-control", {}, ...control));

        /** Keyframe table of a track: hour (for day tracks), value editor, remove; plus "Add key". */
        const trackEditor = (t: Track, width: number, value: (k: { value: number[] }) => Node, dayTime: boolean, redraw: () => void) => {
          const body = h("tbody", {}, ...t.keys.map((k, i) => h("tr", {},
            h("td", {}, dayTime
              ? num(() => toHour(k.time), (v) => { k.time = toTime(Math.min(24, Math.max(0, v))); t.keys.sort((a, b) => a.time - b.time); redraw(); }, "0.25")
              : h("span.muted", {}, String(k.time))),
            h("td", {}, value(k)),
            h("td", {}, t.keys.length > 1 ? h("button.icon-button", { title: "Remove this key", onclick: () => { t.keys.splice(i, 1); changed(); redraw(); } }, "×") : null))));
          const add = h("button", { onclick: () => {
            // A new key halfway between the last two (or after the only one), same value as before it.
            const last = t.keys[t.keys.length - 1];
            const prev = t.keys[t.keys.length - 2];
            const time = prev ? Math.round((prev.time + last.time) / 2) : Math.min(seq.end, last.time + 1000);
            const zero = new Array(width).fill(0);
            t.keys.push({ time, value: [...last.value], ...(t.interp > 1 ? { inTan: [...zero], outTan: [...zero] } : {}) });
            t.keys.sort((a, b) => a.time - b.time);
            changed();
            redraw();
          } }, "Add key");
          return h("div", {}, h("table.form-table.lighting-keys", {},
            h("thead", {}, h("tr", {}, h("th", {}, dayTime ? "Hour" : "Time"), h("th", {}, "Value"), h("th", {}))), body), add);
        };

        /** A colour over the day: gradient preview and keys, or one colour. */
        const colorProp = (p: Prop, redraw: () => void) => {
          if (!("track" in p)) {
            const pick = h("input", { type: "color", value: hex(p.value), oninput: () => { p.value = unhex(pick.value); changed(pick); } });
            return pick;
          }
          const t = p.track;
          const stops = t.keys.map((k) => `${hex(k.value)} ${(toHour(k.time) / 24 * 100).toFixed(1)}%`).join(", ");
          return h("div", {},
            h("div.lighting-gradient", { style: { background: `linear-gradient(to right, ${stops})` }, title: "0:00 → 24:00" }),
            trackEditor(t, 3, (k) => h("input", { type: "color", value: hex(k.value), oninput: (e: Event) => { k.value = unhex((e.target as HTMLInputElement).value); changed(e.target); } }), true, redraw));
        };

        /** A number: fixed, or keys over the day. */
        const numberProp = (p: Prop, redraw: () => void) => ("track" in p
          ? trackEditor(p.track, 1, (k) => num(() => k.value[0], (v) => { k.value = [v]; }), true, redraw)
          : num(() => p.value[0], (v) => { p.value = [v]; }));

        const lightForm = (l: Light, redraw: () => void) => h("section.form-section", {},
          h("h3", {}, `${l.name} (${["omnidirectional", "directional", "ambient"][l.type] ?? "light"})`),
          row("Intensity", numberProp(l.intensity, redraw)),
          row("Colour", colorProp(l.color, redraw)),
          row("Ambient intensity", numberProp(l.ambIntensity, redraw)),
          row("Ambient colour", colorProp(l.ambColor, redraw)),
          row("Shadow intensity", num(() => l.shadowIntensity, (v) => { l.shadowIntensity = v; })),
          l.rotation ? row("Direction", h("div", {},
            h("small.muted", {}, "Rotation of the light as a quaternion (x, y, z, w) per key."),
            h("table.form-table.lighting-keys", {}, h("tbody", {}, ...l.rotation.keys.map((k) => h("tr", {},
              h("td.muted", {}, `${Number(toHour(k.time).toFixed(2))} h`),
              ...[0, 1, 2, 3].map((c) => h("td", {}, num(() => k.value[c], (v) => { k.value[c] = v; }, "0.01"))))))))) : null,
        );

        const render = () => {
          root.replaceChildren(
            h("div.lighting-head", {}, h("strong", {}, model.name), h("span.muted", {}, ` · ${doc.path.replace(/^map\//, "")} · times as hours of the game day`)),
            ...model.lights.map((l) => lightForm(l, render)),
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
