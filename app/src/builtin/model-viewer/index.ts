import type { EditorDocument, ExtensionContext, W3Api } from "../../extensions/api";
import { errorView, formatBytes, h } from "../../workbench/dom";
import { decodeImage } from "../../lib/image/index.ts";
import { parseMdx } from "../../lib/model/mdx";
import { ModelRenderer, TEAM_COLORS, type Clock } from "../../lib/model/renderer";

const FILTER_NAMES = ["none", "transparent", "blend", "additive", "add alpha", "modulate", "modulate 2x"];

/** Where a model's textures are looked up: the model's own layer, the
 *  project (for imported models), then the game's layer resolution. */
function textureLoader(w3: W3Api, doc: EditorDocument) {
  const gamePath = doc.path.startsWith("game:") ? doc.path.slice(5) : null;
  // "War3.w3mod:_HD.w3mod:Units/…/X.mdx" → "War3.w3mod:_HD.w3mod:"
  const layer = gamePath ? gamePath.slice(0, gamePath.lastIndexOf(":") + 1) : null;
  // HD models name .tif/.blp sources that the game ships as .dds.
  const variants = (p: string) => (/\.(blp|tif|tga)$/i.test(p) ? [p, p.replace(/\.\w+$/, ".dds")] : [p]);
  return async (path: string): Promise<Uint8Array> => {
    const slash = path.replace(/\\/g, "/");
    if (layer) {
      for (const v of variants(slash)) {
        try { return await w3.game.read(layer + v); } catch { /* next */ }
      }
    } else if (w3.workspace.project()) {
      try { return await w3.workspace.readBytes(`map/${slash}`); } catch { /* next */ }
    }
    let failed: unknown;
    for (const v of variants(path)) {
      try { return await w3.game.read(v); } catch (e) { failed = e; }
    }
    throw failed;
  };
}

export function activate(w3: W3Api, ctx: ExtensionContext) {
  ctx.subscriptions.push(
    w3.editors.registerProvider("w3.modelViewer", {
      async resolve(el, doc) {
        const bytes = await doc.readBytes();
        let model;
        try {
          model = parseMdx(bytes);
        } catch (e) {
          el.append(errorView(`Can't read ${doc.path}: ${(e as Error).message}`, h("button.link-inline", { onclick: () => w3.editors.open(doc.path, "w3.hexViewer") }, "Open in Binary Viewer")));
          return {};
        }

        const canvas = h("canvas.model-canvas");
        const stage = h("div.model-stage", {}, canvas);
        let renderer: ModelRenderer;
        try {
          renderer = new ModelRenderer(canvas, model);
        } catch (e) {
          el.append(errorView(`WebGL: ${(e as Error).message}`));
          return {};
        }

        // Reforged copies (_DE/_HD) have PopcornFX effects (CORN, not drawn): show the classic
        // model's particles and ribbons instead, as the terrain view does.
        let classicFx = false;
        const gamePath = doc.path.startsWith("game:") ? doc.path.slice(5) : null;
        if (gamePath && /:_(hd|de)\.w3mod:/i.test(gamePath) && !model.particleEmitters2.length && !model.ribbons.length && model.skipped.includes("CORN")) {
          try {
            const sd = parseMdx(await w3.game.read(`War3.w3mod:${gamePath.slice(gamePath.lastIndexOf(":") + 1)}`));
            if (sd.particleEmitters2.length || sd.ribbons.length) {
              renderer.setEffectModel(sd);
              classicFx = true;
              const load = textureLoader(w3, { path: "game:War3.w3mod:" } as EditorDocument);
              sd.textures.forEach((t, i) => {
                if (t.replaceableId !== 0 || !t.path) return;
                load(t.path).then((buf) => renderer.setEffectTexture(i, decodeImage(buf, t.path)), () => {});
              });
            }
          } catch { /* no classic copy */ }
        }

        // ---- animation state ----------------------------------------------------
        let seqIndex = model.sequences.findIndex((s) => /^stand/i.test(s.name));
        if (seqIndex < 0) seqIndex = model.sequences.length ? 0 : -1;
        let playing = true, speed = 1, frame = 0, time = 0;
        const seq = () => model.sequences[seqIndex];
        const resetFrame = () => { frame = seq()?.start ?? 0; };
        resetFrame();

        // ---- toolbar -------------------------------------------------------------
        const seqSelect = h("select", {
          onchange: () => { seqIndex = Number(seqSelect.value); resetFrame(); playing = true; playBtn.textContent = "❚❚"; },
        }, ...model.sequences.map((s, i) =>
          h("option", { value: String(i), selected: i === seqIndex }, `${s.name} (${((s.end - s.start) / 1000).toFixed(2)}s)`)));
        if (!model.sequences.length) seqSelect.append(h("option", {}, "no animations"));
        const playBtn = h("button", { title: "Play / pause", onclick: () => { playing = !playing; playBtn.textContent = playing ? "❚❚" : "▶"; } }, "❚❚");
        const speedSelect = h("select", { title: "Speed", onchange: () => { speed = Number(speedSelect.value); } },
          ...[0.1, 0.25, 0.5, 1, 1.5, 2].map((s) => h("option", { value: String(s), selected: s === 1 }, `${s}×`)));
        const teamSelect = h("select", { title: "Team colour", onchange: () => renderer.setTeamColor(Number(teamSelect.value)) },
          ...TEAM_COLORS.map(([name], i) => h("option", { value: String(i) }, name)));
        const toggle = (label: string, get: () => boolean, set: (v: boolean) => void) => {
          const box = h("input", { type: "checkbox", checked: get(), onchange: () => set(box.checked) });
          return h("label.model-toggle", {}, box, ` ${label}`);
        };
        const scrub = h("input.model-scrub", { type: "range", min: "0", max: "1000", value: "0",
          oninput: () => { const s = seq(); if (s) { frame = s.start + ((s.end - s.start) * Number(scrub.value)) / 1000; playing = false; playBtn.textContent = "▶"; } } });
        const frameLabel = h("span.model-frame.muted");

        // ---- side panel --------------------------------------------------------------
        const texList = h("div.model-list");
        const loadTextures = async () => {
          const load = textureLoader(w3, doc);
          const paths = renderer.texturePaths();
          texList.replaceChildren(...model.textures.map((t, i) => {
            const label = t.replaceableId === 1 ? "team colour" : t.replaceableId === 2 ? "team glow" : paths[i] ?? `replaceable #${t.replaceableId}`;
            const row = h("div.model-row", { title: label }, h("span.model-dot.pending", {}, "●"), h("span", {}, label));
            if (paths[i]) {
              load(paths[i]!).then((buf) => {
                renderer.setTexture(i, decodeImage(buf, paths[i]!));
                row.firstElementChild!.className = "model-dot ok";
              }).catch((e) => {
                row.firstElementChild!.className = "model-dot missing";
                row.title = `${label}: ${(e as Error).message ?? e}`;
              });
            } else {
              row.firstElementChild!.className = t.replaceableId <= 2 ? "model-dot ok" : "model-dot missing";
            }
            return row;
          }));
        };
        loadTextures();

        const geoList = h("div.model-list", {}, ...model.geosets.map((g, i) => {
          const mat = model.materials[g.materialId];
          const desc = mat ? mat.layers.map((l) => FILTER_NAMES[l.filterMode] ?? l.filterMode).join("+") : "?";
          const box = h("input", { type: "checkbox", checked: !renderer.hidden.has(i), onchange: () => { if (box.checked) renderer.hidden.delete(i); else renderer.hidden.add(i); } });
          return h("label.model-row", { title: g.lodName || `geoset ${i}` }, box,
            h("span", {}, `${i}${g.lodName ? ` · ${g.lodName.split(":").pop()}` : ""}`), h("small.muted", {}, ` ${g.positions.length / 3}v · ${desc}${g.lod ? ` · LOD ${g.lod}` : ""}`));
        }));

        const st = renderer.stats;
        const side = h("div.model-side", {},
          h("h3", {}, model.name || doc.path.split(/[/:]/).pop()),
          h("div.model-facts", {},
            h("div", {}, `MDX v${model.version} · ${formatBytes(bytes.length)}`),
            h("div", {}, `${st.vertices.toLocaleString()} vertices · ${st.triangles.toLocaleString()} triangles`),
            h("div", {}, `${st.geosets} geosets · ${model.materials.length} materials · ${st.nodes} nodes`),
            h("div", {}, `${model.sequences.length} animations`),
            model.particleEmitters2.length ? h("div", {}, `${model.particleEmitters2.length} particle emitter${model.particleEmitters2.length === 1 ? "" : "s"}`) : null,
            model.ribbons.length ? h("div", {}, `${model.ribbons.length} ribbon${model.ribbons.length === 1 ? "" : "s"}`) : null,
            classicFx ? h("div.muted", { title: "This Reforged model's own effects are PopcornFX (CORN), which this viewer can't draw; the effects shown are the classic model's" }, "effects: the classic model's (PopcornFX not drawn)") : null,
            model.skipped.length ? h("div.muted", { title: "Present in the model but not drawn by this viewer" }, `not drawn: ${[...new Set(model.skipped)].join(", ")}`) : null,
            ...model.warnings.map((w) => h("div.model-warn", {}, w)),
          ),
          h("h4", {}, `Textures (${model.textures.length})`), texList,
          h("h4", {}, `Geosets (${model.geosets.length})`), geoList,
        );

        el.append(h("div.model-viewer", {},
          h("div.model-main", {},
            h("div.model-toolbar", {}, seqSelect, playBtn, speedSelect, scrub, frameLabel, teamSelect,
              toggle("Wireframe", () => renderer.wireframe, (v) => { renderer.wireframe = v; }),
              toggle("Grid", () => renderer.showGrid, (v) => { renderer.showGrid = v; }),
              renderer.hasParticles ? toggle("Particles", () => renderer.showParticles, (v) => { renderer.showParticles = v; }) : null,
              h("button", { title: "Reset camera", onclick: () => resetCamera() }, "⟲")),
            stage),
          side));

        // ---- camera controls -------------------------------------------------------------
        const initial = { yaw: renderer.yaw, pitch: renderer.pitch, distance: renderer.distance, target: [...renderer.target] as typeof renderer.target };
        const resetCamera = () => Object.assign(renderer, { ...initial, target: [...initial.target] });
        let drag: { x: number; y: number; button: number } | null = null;
        canvas.addEventListener("contextmenu", (e) => e.preventDefault());
        canvas.addEventListener("mousedown", (e) => { drag = { x: e.clientX, y: e.clientY, button: e.button }; });
        const onMove = (e: MouseEvent) => {
          if (!drag) return;
          const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
          drag.x = e.clientX; drag.y = e.clientY;
          if (drag.button === 0) {
            renderer.yaw -= dx * 0.01;
            renderer.pitch = Math.max(-1.5, Math.min(1.5, renderer.pitch + dy * 0.01));
          } else {
            // Pan in the view plane.
            const s = renderer.distance / 600, cy = Math.cos(renderer.yaw), sy = Math.sin(renderer.yaw);
            renderer.target[0] += (sy * dx - cy * Math.sin(renderer.pitch) * dy) * s;
            renderer.target[1] += (-cy * dx - sy * Math.sin(renderer.pitch) * dy) * s;
            renderer.target[2] += Math.cos(renderer.pitch) * dy * s;
          }
        };
        const onUp = () => { drag = null; };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        canvas.addEventListener("wheel", (e) => {
          e.preventDefault();
          renderer.distance = Math.max(5, renderer.distance * (e.deltaY > 0 ? 1.12 : 1 / 1.12));
        }, { passive: false });

        // ---- render loop ---------------------------------------------------------------------
        let raf = 0, last = performance.now();
        const tick = (now: number) => {
          const dt = Math.min(100, now - last);
          last = now;
          const s = seq();
          if (playing) {
            time += dt * speed;
            if (s) {
              frame += dt * speed;
              if (frame > s.end) frame = s.start + ((frame - s.start) % Math.max(1, s.end - s.start));
            }
          }
          if (s) {
            scrub.value = String(Math.round(((frame - s.start) / Math.max(1, s.end - s.start)) * 1000));
            frameLabel.textContent = `${Math.round(frame - s.start)} / ${s.end - s.start} ms`;
          }
          const clock: Clock = { frame, seqStart: s?.start ?? 0, seqEnd: s?.end ?? 0, time };
          // Hidden tabs have zero size; skip drawing until visible.
          if (canvas.clientWidth > 0) renderer.render(clock);
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);

        return {
          dispose: () => {
            cancelAnimationFrame(raf);
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            renderer.dispose();
          },
        };
      },
    }),
  );
}
