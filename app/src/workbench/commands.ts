import type { CommandContribution, Disposable } from "../extensions/api";
import { commandNotFound } from "../lib/commanderror";
import { disposable } from "./dom";
import { eventChord } from "../lib/keybindings";

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

  /** Whether a handler is there now (execute would activate an extension for it first). */
  registered(id: string): boolean {
    return this.handlers.has(id);
  }

  info(id: string): CommandInfo | undefined {
    return this.contributed.get(id);
  }

  all(): CommandInfo[] {
    return [...this.contributed.values()].filter((c) => !c.hidden);
  }

  /** Every declared command, hidden ones too (their keys can still be bound). */
  contributions(): CommandInfo[] {
    return [...this.contributed.values()];
  }

  /** Normalised "ctrl+shift+p" style chord for a keyboard event (keybindings.ts eventChord); "" for a modifier alone. */
  static chord(e: KeyboardEvent): string {
    return eventChord(e) ?? "";
  }
}
