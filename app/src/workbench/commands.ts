import type { CommandContribution, Disposable } from "../extensions/api";
import { commandNotFound } from "../lib/commanderror";
import { disposable } from "./dom";

export interface CommandInfo extends CommandContribution {
  extensionId: string;
}

/** Commands are declared in manifests (so the palette knows them before the
 *  extension loads) and get their handler when the extension activates. */
export class CommandService {
  private handlers = new Map<string, (...args: any[]) => unknown>();
  private contributed = new Map<string, CommandInfo>();
  /** Set by the extension host: activates whatever handles an event. */
  activate: (event: string) => Promise<void> = async () => {};

  contribute(extensionId: string, c: CommandContribution) {
    this.contributed.set(c.id, { ...c, extensionId });
  }

  register(id: string, handler: (...args: any[]) => unknown): Disposable {
    if (this.handlers.has(id)) console.warn(`command ${id} registered twice`);
    this.handlers.set(id, handler);
    return disposable(() => this.handlers.delete(id));
  }

  async execute<T>(id: string, ...args: any[]): Promise<T> {
    if (!this.handlers.has(id)) await this.activate(`onCommand:${id}`);
    const handler = this.handlers.get(id);
    if (!handler) throw new Error(commandNotFound(id));
    return (await handler(...args)) as T;
  }

  info(id: string): CommandInfo | undefined {
    return this.contributed.get(id);
  }

  all(): CommandInfo[] {
    return [...this.contributed.values()].filter((c) => !c.hidden);
  }

  /** Normalised "ctrl+shift+p" style chord for a keyboard event. */
  static chord(e: KeyboardEvent): string {
    const parts = [];
    if (e.ctrlKey || e.metaKey) parts.push("ctrl");
    if (e.altKey) parts.push("alt");
    if (e.shiftKey) parts.push("shift");
    parts.push(e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase());
    return parts.join("+");
  }

  forChord(chord: string): CommandInfo | undefined {
    return [...this.contributed.values()].find((c) => c.keybinding?.toLowerCase() === chord);
  }
}

/** Whether the key's target, or an element around it, keeps this chord for itself (its data-own-keys lists it, space
 *  separated): then no command bound to the chord runs, and the key goes on to the element. */
export function ownsChord(target: EventTarget | null, chord: string): boolean {
  const owner = (target as { closest?: (s: string) => { dataset?: Record<string, string | undefined> } | null } | null)?.closest?.("[data-own-keys]");
  return !!owner?.dataset?.ownKeys?.split(/\s+/).includes(chord);
}
