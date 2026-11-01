import type { ExtensionContext, ExtensionManifest, ExtensionModule, W3Api } from "./api";

export interface ExtensionRecord {
  manifest: ExtensionManifest;
  source: "builtin" | "user" | "project";
  /** Folder on disk for user/project extensions. */
  dir: string | null;
  load: () => Promise<ExtensionModule>;
  active: boolean;
  activating?: Promise<void>;
  error?: string;
  ctx?: ExtensionContext;
}

interface ExternalExtension {
  dir: string;
  source: "user" | "project";
  manifest: ExtensionManifest;
  main_source: string | null;
}

/** Loads extension manifests, applies their contributions and activates
 *  extensions lazily when one of their activation events fires. */
export class ExtensionHost {
  readonly extensions: ExtensionRecord[] = [];

  constructor(
    private api: W3Api,
    private contribute: (rec: ExtensionRecord) => void,
    private log: (line: string) => void,
  ) {}

  addBuiltins() {
    const manifests = import.meta.glob<ExtensionManifest>("../builtin/*/extension.json", { eager: true, import: "default" });
    const modules = import.meta.glob<ExtensionModule>("../builtin/*/index.ts");
    for (const [path, manifest] of Object.entries(manifests)) {
      const load = modules[path.replace("extension.json", "index.ts")];
      this.add({ manifest, source: "builtin", dir: null, load: load ?? (async () => ({ activate() {} })), active: false });
    }
  }

  addExternal(list: ExternalExtension[]) {
    for (const ext of list) {
      if (!ext.manifest?.id) continue;
      if (this.extensions.some((e) => e.manifest.id === ext.manifest.id)) {
        this.log(`skipping ${ext.manifest.id} from ${ext.dir}: an extension with that id is already loaded`);
        continue;
      }
      const load = async (): Promise<ExtensionModule> => {
        if (!ext.main_source) return { activate() {} };
        // Extensions are plain ES modules; they receive the API in activate().
        const url = URL.createObjectURL(new Blob([ext.main_source], { type: "text/javascript" }));
        try {
          return await import(/* @vite-ignore */ url);
        } finally {
          URL.revokeObjectURL(url);
        }
      };
      this.add({ manifest: ext.manifest, source: ext.source, dir: ext.dir, load, active: false });
    }
  }

  private add(rec: ExtensionRecord) {
    this.extensions.push(rec);
    this.contribute(rec);
  }

  async fire(event: string) {
    const matching = this.extensions.filter((e) => !e.active && !e.error && this.handles(e, event));
    await Promise.all(matching.map((e) => this.activate(e)));
  }

  private handles(e: ExtensionRecord, event: string): boolean {
    const events = e.manifest.activationEvents ?? [];
    if (events.includes("*") || events.includes(event)) return true;
    // Contributing a command/view/editor implies the matching activation event.
    const c = e.manifest.contributes ?? {};
    const [kind, id] = event.split(/:(.*)/s);
    if (kind === "onCommand") return !!c.commands?.some((x) => x.id === id);
    if (kind === "onView") return !!c.views?.some((x) => x.id === id);
    if (kind === "onEditor") return !!c.editors?.some((x) => x.id === id);
    return false;
  }

  activate(e: ExtensionRecord): Promise<void> {
    e.activating ??= (async () => {
      const started = performance.now();
      try {
        const mod = await e.load();
        e.ctx = { extensionId: e.manifest.id, extensionPath: e.dir, subscriptions: [] };
        await mod.activate(this.api, e.ctx);
        e.active = true;
        this.log(`activated ${e.manifest.id} (${e.source}) in ${Math.round(performance.now() - started)} ms`);
      } catch (err) {
        e.error = String(err);
        this.log(`failed to activate ${e.manifest.id}: ${err}`);
        console.error(err);
      }
    })();
    return e.activating;
  }
}
