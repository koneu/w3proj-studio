import type { ExtensionContext, W3Api } from "../../extensions/api";
import { formatBytes, h } from "../../workbench/dom";
import { decodeImage, type Mip } from "../../lib/image/index.ts";

type Channel = "rgba" | "rgb" | "r" | "g" | "b" | "a";

/** RGBA → what the selected channel view shows. */
function viewPixels(m: Mip, channel: Channel): ImageData {
  const src = m.rgba;
  const out = new Uint8ClampedArray(src.length);
  for (let i = 0; i < src.length; i += 4) {
    switch (channel) {
      case "rgba": out[i] = src[i]; out[i + 1] = src[i + 1]; out[i + 2] = src[i + 2]; out[i + 3] = src[i + 3]; break;
      case "rgb": out[i] = src[i]; out[i + 1] = src[i + 1]; out[i + 2] = src[i + 2]; out[i + 3] = 255; break;
      default: {
        const v = src[i + "rgba".indexOf(channel)];
        out[i] = out[i + 1] = out[i + 2] = v;
        out[i + 3] = 255;
      }
    }
  }
  return new ImageData(out, m.width, m.height);
}

export function activate(w3: W3Api, ctx: ExtensionContext) {
  ctx.subscriptions.push(
    w3.editors.registerProvider("w3.imageViewer", {
      async resolve(el, doc) {
        const bytes = await doc.readBytes();
        let img;
        try {
          img = decodeImage(bytes, doc.path);
        } catch (e) {
          el.append(h("div.editor-error", {}, `Can't decode ${doc.path}: ${(e as Error).message} `,
            h("button.link-inline", { onclick: () => w3.editors.open(doc.path, "w3.hexViewer") }, "Open in Binary Viewer")));
          return {};
        }

        let level = 0;
        let channel: Channel = img.hasAlpha ? "rgba" : "rgb";
        let zoom = 0; // 0 = fit
        let current: Mip;

        const canvas = h("canvas.tex-canvas");
        const stage = h("div.tex-stage.checker", {}, canvas);
        const pixelInfo = h("span.tex-pixel");
        const zoomLabel = h("span.tex-zoom");

        const mipSelect = h("select", { onchange: () => { level = Number(mipSelect.value); draw(); } },
          ...Array.from({ length: img.mipCount }, (_, i) =>
            h("option", { value: String(i) }, `Mip ${i} — ${Math.max(1, img.width >> i)}×${Math.max(1, img.height >> i)}`)));
        const channelSelect = h("select", { onchange: () => { channel = channelSelect.value as Channel; draw(); } },
          ...(["rgba", "rgb", "r", "g", "b", "a"] as Channel[]).map((c) =>
            h("option", { value: c, selected: c === channel }, c === "rgba" ? "RGBA" : c === "rgb" ? "RGB (ignore alpha)" : `${c.toUpperCase()} only`)));
        const bgSelect = h("select", { onchange: () => { stage.className = `tex-stage ${bgSelect.value}`; } },
          h("option", { value: "checker" }, "Checkerboard"), h("option", { value: "black" }, "Black"), h("option", { value: "white" }, "White"));

        const applyZoom = () => {
          const fit = Math.min((stage.clientWidth - 24) / current.width, (stage.clientHeight - 24) / current.height);
          const z = zoom || Math.max(0.01, Math.min(fit, 8));
          canvas.style.width = `${current.width * z}px`;
          canvas.style.height = `${current.height * z}px`;
          canvas.classList.toggle("pixelated", z >= 2);
          zoomLabel.textContent = `${zoom ? "" : "Fit "}${Math.round(z * 100)}%`;
        };
        const setZoom = (z: number) => { zoom = Math.min(64, Math.max(0.05, z)); applyZoom(); };
        const effectiveZoom = () => canvas.clientWidth / current.width;

        const draw = () => {
          try {
            current = img.mip(level);
          } catch (e) {
            w3.window.showError(`Mip ${level}: ${(e as Error).message}`);
            return;
          }
          canvas.width = current.width;
          canvas.height = current.height;
          canvas.getContext("2d")!.putImageData(viewPixels(current, channel), 0, 0);
          applyZoom();
        };

        canvas.addEventListener("mousemove", (e) => {
          const r = canvas.getBoundingClientRect();
          const x = Math.floor(((e.clientX - r.left) / r.width) * current.width);
          const y = Math.floor(((e.clientY - r.top) / r.height) * current.height);
          if (x < 0 || y < 0 || x >= current.width || y >= current.height) return;
          const i = (y * current.width + x) * 4, p = current.rgba;
          pixelInfo.textContent = `(${x}, ${y})  R ${p[i]}  G ${p[i + 1]}  B ${p[i + 2]}  A ${p[i + 3]}`;
        });
        canvas.addEventListener("mouseleave", () => { pixelInfo.textContent = ""; });
        stage.addEventListener("wheel", (e) => {
          if (!e.ctrlKey) return;
          e.preventDefault();
          setZoom(effectiveZoom() * (e.deltaY < 0 ? 1.25 : 0.8));
        }, { passive: false });
        const resize = new ResizeObserver(() => current && !zoom && applyZoom());
        resize.observe(stage);

        el.append(
          h("div.tex-viewer", {},
            h("div.tex-toolbar", {},
              h("strong", {}, img.format),
              h("span.muted", {}, `${img.width}×${img.height} · ${img.mipCount} mip${img.mipCount === 1 ? "" : "s"} · ${formatBytes(bytes.length)}`),
              mipSelect, channelSelect, bgSelect,
              h("button", { title: "Zoom out (Ctrl+wheel)", onclick: () => setZoom(effectiveZoom() * 0.8) }, "−"),
              zoomLabel,
              h("button", { title: "Zoom in (Ctrl+wheel)", onclick: () => setZoom(effectiveZoom() * 1.25) }, "+"),
              h("button", { onclick: () => setZoom(1) }, "1:1"),
              h("button", { onclick: () => { zoom = 0; applyZoom(); } }, "Fit"),
              pixelInfo,
            ),
            stage,
          ),
        );
        draw();
        return { dispose: () => resize.disconnect() };
      },
    }),
  );
}
