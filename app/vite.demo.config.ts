import { defineConfig, type Plugin } from "vite";
import { existsSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The web demo (docs/web-demo.md): the app's own code with the title bar swapped for a browser one and the Rust side
// replaced by src/demo/tauri.ts. A separate config, so the desktop build (vite.config.ts) is untouched.
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** The title bar module of the workbench, whichever way it is imported, is the demo's. */
function demoTitleBar(): Plugin {
  // Vite's resolved ids use '/' also on Windows; fileURLToPath gives '\' there: compare the '/' forms (the Windows
  // CI found the real title bar, with its window buttons, in the demo build).
  const slashes = (p: string) => p.replace(/\\/g, "/");
  const own = slashes(here("./src/workbench/titlebar.ts"));
  return {
    name: "demo-titlebar",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!importer || !/(^|\/)titlebar$/.test(source)) return null;
      const r = await this.resolve(source, importer, { ...options, skipSelf: true });
      return r && slashes(r.id) === own ? here("./src/demo/titlebar.ts") : null;
    },
  };
}

/** demo.html is the entry; the site wants it as index.html. Renamed on disk once the bundle is written: assigning to
 *  generateBundle's bundle (what this did before) is refused by Rolldown, which Vite 8 builds with. */
function indexHtml(): Plugin {
  let outDir = "";
  return {
    name: "demo-index",
    enforce: "post",
    configResolved(config) { outDir = resolve(config.root, config.build.outDir); },
    closeBundle() {
      const page = join(outDir, "demo.html");
      if (existsSync(page)) renameSync(page, join(outDir, "index.html"));
    },
    configureServer(server) {
      server.middlewares.use((req, _res, next) => { if (req.url === "/") req.url = "/demo.html"; next(); });
    },
  };
}

// The site lives at https://koneu.github.io/w3proj-studio/ (a subpath); DEMO_BASE overrides it. The dev server serves from /.
export default defineConfig(({ command }) => ({
  base: command === "serve" ? "/" : process.env.DEMO_BASE ?? "/w3proj-studio/",
  clearScreen: false,
  plugins: [demoTitleBar(), indexHtml()],
  server: { port: 1421, strictPort: true },
  build: { target: "es2022", outDir: "dist-demo", emptyOutDir: true, rollupOptions: { input: here("./demo.html") } },
}));
