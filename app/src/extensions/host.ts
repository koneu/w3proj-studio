import type { ExtensionContext, ExtensionManifest, ExtensionModule, W3Api } from "./api";

export interface ExtensionRecord {
  manifest: ExtensionManifest;
  source: "builtin" | "user" | "project";
  /** Folder on disk for user/project extensions. */
  dir: string | null;
  load: () => Promise<ExtensionModule>;
  active: boolean;
  /** Listed in "extensions.disabled": contributes nothing and never activates. */
  disabled: boolean;
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
    private isDisabled: (id: string) => boolean = () => false,
  ) {}

  addBuiltins() {
    const manifests = import.meta.glob<ExtensionManifest>("../builtin/*/extension.json", { eager: true, import: "default" });
    const modules = import.meta.glob<ExtensionModule>("../builtin/*/index.ts");
    for (const [path, manifest] of Object.entries(manifests)) {
      const load = modules[path.replace("extension.json", "index.ts")];
      this.add({ manifest, source: "builtin", dir: null, load: load ?? (async () => ({ activate() {} })), active: false, disabled: false });
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
      this.add({ manifest: ext.manifest, source: ext.source, dir: ext.dir, load, active: false, disabled: false });
    }
  }

  private add(rec: ExtensionRecord) {
    rec.disabled = this.isDisabled(rec.manifest.id);
    this.extensions.push(rec);
    if (rec.disabled) this.log(`${rec.manifest.id} is disabled (setting "extensions.disabled")`);
    else this.contribute(rec);
  }

  async fire(event: string) {
    const matching = this.extensions.filter((e) => !e.active && !e.disabled && !e.error && this.handles(e, event));
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
    if (kind === "onService") return !!c.services?.some((x) => x.id === id);
    if (kind === "onMcpTool") return !!c.mcpTools?.some((x) => x.name === id);
    return false;
  }

  private services = new Map<string, unknown>();

  provideService(id: string, impl: unknown): { dispose(): void } {
    if (this.services.has(id)) throw new Error(`The service "${id}" is already provided.`);
    this.services.set(id, impl);
    return { dispose: () => { if (this.services.get(id) === impl) this.services.delete(id); } };
  }

  async getService<T>(id: string): Promise<T> {
    if (!this.services.has(id)) {
      const provider = this.extensions.find((e) => e.manifest.contributes?.services?.some((s) => s.id === id));
      if (!provider) throw new Error(`No extension provides the service "${id}".`);
      if (provider.disabled) throw new Error(`The service "${id}" comes from ${provider.manifest.name} (${provider.manifest.id}), which is disabled.`);
      await this.activate(provider);
      if (provider.error) throw new Error(`The service "${id}" is unavailable: ${provider.manifest.id} failed to activate (${provider.error}).`);
    }
    if (!this.services.has(id)) throw new Error(`${id} is declared but its extension didn't register it.`);
    return this.services.get(id) as T;
  }

  /** Activates the extensions `e` depends on; throws naming a missing or
   *  disabled one. */
  private async activateDependencies(e: ExtensionRecord) {
    for (const id of e.manifest.extensionDependencies ?? []) {
      const dep = this.extensions.find((x) => x.manifest.id === id);
      if (!dep) throw new Error(`requires ${id}, which isn't installed`);
      if (dep.disabled) throw new Error(`requires ${dep.manifest.name} (${id}), which is disabled`);
      await this.activate(dep);
      if (dep.error) throw new Error(`requires ${id}, which failed to activate`);
    }
  }

  activate(e: ExtensionRecord): Promise<void> {
    e.activating ??= (async () => {
      const started = performance.now();
      try {
        await this.activateDependencies(e);
        const mod = await e.load();
        e.ctx = { extensionId: e.manifest.id, extensionPath: e.dir, subscriptions: [] };
        await mod.activate(this.api, e.ctx);
        e.active = true;
        this.log(`activated ${e.manifest.id} (${e.source}) in ${Math.round(performance.now() - started)} ms`);
      } catch (err) {
        e.error = err instanceof Error ? err.message : String(err);
        this.log(`failed to activate ${e.manifest.id}: ${err}`);
        console.error(err);
      }
    })();
    return e.activating;
  }
}
