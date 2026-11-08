import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import type { Disposable } from "../extensions/api";

export function invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> {
  return tauriInvoke<T>(command, args);
}

export async function listen<T>(event: string, handler: (payload: T) => void): Promise<Disposable> {
  const un = await tauriListen<T>(event, (e) => handler(e.payload));
  return { dispose: un };
}

export async function readBytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await invoke<ArrayBuffer>("fs_read_bytes", { path }));
}

export class NotUtf8Error extends Error {
  constructor(path: string) {
    super(`${path} is not valid UTF-8`);
    this.name = "NotUtf8Error";
  }
}

export async function readText(path: string): Promise<string> {
  try {
    return await invoke<string>("fs_read_text", { path });
  } catch (e) {
    if (e === "NOT_UTF8") throw new NotUtf8Error(path);
    throw e;
  }
}

export function writeText(path: string, text: string): Promise<{ size: number; modified: number }> {
  return invoke("fs_write_text", { path, text });
}

/** Binary files go as the raw request body (no JSON number arrays). */
export function writeBytes(path: string, bytes: Uint8Array): Promise<{ size: number; modified: number }> {
  return tauriInvoke("fs_write_bytes", bytes, { headers: { path: encodeURIComponent(path) } });
}

export { isAbsolutePath, joinPath } from "../lib/paths";
