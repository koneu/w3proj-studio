import type { ExtensionContext, W3Api } from "../../extensions/api";
import { formatBytes, h } from "../../workbench/dom";

const ROW = 16;
const PAGE_ROWS = 2048;

function hexRows(bytes: Uint8Array, start: number, rows: number): string {
  const out: string[] = [];
  for (let r = 0; r < rows; r++) {
    const off = start + r * ROW;
    if (off >= bytes.length) break;
    const chunk = bytes.subarray(off, off + ROW);
    const hex = [...chunk].map((b) => b.toString(16).padStart(2, "0")).join(" ").padEnd(ROW * 3 - 1);
    const ascii = [...chunk].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("");
    out.push(`${off.toString(16).padStart(8, "0")}  ${hex}  ${ascii}`);
  }
  return out.join("\n");
}

export function activate(w3: W3Api, ctx: ExtensionContext) {
  ctx.subscriptions.push(
    w3.editors.registerProvider("w3.hexViewer", {
      async resolve(el, doc) {
        const bytes = await doc.readBytes();
        const magic = new TextDecoder("latin1").decode(bytes.subarray(0, 4)).replace(/[^\x20-\x7e]/g, ".");
        const pre = h("pre.hex");
        let shown = 0;
        const more = h("button", { onclick: () => page() }, "Show more");
        const page = () => {
          pre.append(hexRows(bytes, shown * ROW, PAGE_ROWS) + "\n");
          shown += PAGE_ROWS;
          more.hidden = shown * ROW >= bytes.length;
        };
        el.append(
          h("div.hex-viewer", {},
            h("div.hex-header", {},
              h("strong", {}, doc.path),
              h("span", {}, `${formatBytes(bytes.length)} · magic "${magic}"`),
              h("span.muted", {}, "Binary map data is edited in the World Editor (Ctrl+Shift+P → Open in World Editor)."),
            ),
            pre,
            more,
          ),
        );
        page();
        return {};
      },
    }),
  );
}
