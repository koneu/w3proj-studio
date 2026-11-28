import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";

// The Linux smoke tests' error collector (scripts/smoke-hook.js) as the page's first script, so errors from its very
// first moments, and after every reload, are kept. Only in a debug build for Linux (`tauri build --debug`, as the smoke
// tests make it: Tauri sets TAURI_ENV_DEBUG and TAURI_ENV_PLATFORM for the build command); a release build, a plain
// `npm run build` and the dev server get nothing.
const smokeHook = (): Plugin => ({
  name: "w3-smoke-hook",
  transformIndexHtml: () => process.env.TAURI_ENV_DEBUG === "true" && process.env.TAURI_ENV_PLATFORM === "linux"
    ? [{ tag: "script", children: readFileSync(new URL("./scripts/smoke-hook.js", import.meta.url), "utf8"), injectTo: "head-prepend" }]
    : [],
});

// Tauri expects a fixed port and no screen clearing so its own logs stay visible.
export default defineConfig({
  clearScreen: false,
  plugins: [smokeHook()],
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  // The app loads its chunks from its own files, so their size costs next to nothing; the limit sits above the
  // largest (the terrain view's, about 520 kB) and still says when one grows well past it.
  build: { target: "es2022", outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 600 },
});
