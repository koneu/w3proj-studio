// Another graphics mode (game.graphicsMode: Classic, Reforged HD, Reforged DE): the editors showing the mode's art
// open again in place (EditorContribution.graphicsMode). The terrain editor follows by itself.

import type { Disposable } from "../extensions/api";

export interface GraphicsModeHost {
  get(): string | undefined;
  onDidChange(listener: (key: string) => void): Disposable;
  /** Reopens the editors of the mode's art; resolves with the files left as they were for unsaved changes. */
  follow(): Promise<string[]>;
  /** Saves the editors of a file (as its tab's Save); resolves with how many were saved. */
  save(path: string): Promise<number>;
  /** Opens the editors of a file again in place; resolves with how many were left for unsaved changes. */
  reopen(path: string): Promise<number>;
  ask(message: string, ...actions: string[]): Promise<string | undefined>;
}

export const SAVE_AND_REOPEN = "Save and Reopen";

/** Follows changes of the mode. A settings file loaded again fires every key: only a real change counts. */
export function followGraphicsMode(host: GraphicsModeHost): Disposable {
  let mode = host.get() ?? "hd";
  return host.onDidChange((key) => {
    if (key !== "game.graphicsMode") return;
    const now = host.get() ?? "hd";
    if (now === mode) return;
    mode = now;
    void host.follow().then(async (kept) => {
      if (!kept.length) return;
      const names = kept.map((p) => p.split(/[/:]/).pop()).join(", ");
      const one = kept.length === 1;
      const pick = await host.ask(`${names} ${one ? "has" : "have"} unsaved changes, so ${one ? "it still shows" : "they still show"} the graphics mode `
        + `${one ? "it was" : "they were"} opened in. Save to see the new one.`, SAVE_AND_REOPEN);
      if (pick !== SAVE_AND_REOPEN) return;
      for (const p of kept) if ((await host.save(p)) > 0) await host.reopen(p);
    }).catch(() => { /* an editor that can't open again shows why in its tab */ });
  });
}
