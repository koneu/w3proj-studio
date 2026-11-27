import { defineConfig } from "vite";

// Tauri expects a fixed port and no screen clearing so its own logs stay visible.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  // The app loads its chunks from its own files, so their size costs next to nothing; the limit sits above the
  // largest (the terrain view's, about 520 kB) and still says when one grows well past it.
  build: { target: "es2022", outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 600 },
});
