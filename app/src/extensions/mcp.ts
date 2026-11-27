// The tools the MCP server offers. There's one server (`w3proj mcp` and the app's pipe), and it
// knows nothing about what tools do: each extension declares its own in `contributes.mcpTools`
// and answers them with `w3.mcp.registerTool`.
//
// A declared tool is listed without loading its extension, which activates on the first call.
// A disabled extension contributes nothing, so its tools are simply not there. Whatever goes
// wrong in a tool ends as an error result of that one call.

import type { Disposable, McpCall, McpContent, McpToolContribution, McpToolHandler } from "./api";

interface Declared { tool: McpToolContribution; extensionId: string; source: string }

export interface McpHostHooks {
  /** Activates the extensions answering an event ("onMcpTool:<name>"). */
  activate(event: string): Promise<void>;
  /** What every call waits for before its tool runs (the open project's whole file list: tools decide by it whether
   *  a file is there, and right after an open it may still be read). A rejection is the call's error, so a host lets
   *  tools run that don't need what it waits for (the workbench's never rejects). */
  ready?(): Promise<void>;
  /** Whether a tool may be used now (settings: project extensions' tools, writing tools). */
  allowed(declared: { source: string; readOnly: boolean; needs?: string }): boolean;
  /** What the user wants a tool's description to say besides, right now. */
  note?(name: string): string | undefined;
  /** What the app is busy with right now, in a few words (the status bar's progress text), if anything: what a long
   *  tool's progress says when the tool itself says nothing. */
  activity?(): string | undefined;
  /** Why an extension can't answer, if it's known. */
  whyUnavailable(extensionId: string): string | undefined;
  log(line: string): void;
}

const NAME = /^[A-Za-z0-9_-]{1,64}$/;

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}

const isContent = (v: unknown): v is McpContent => {
  const type = (v as { type?: unknown } | null)?.type;
  return type === "text" || type === "image";
};

/** What a handler returned as MCP content: strings as they are, anything else as JSON. */
function toContent(value: unknown): McpContent[] {
  if (Array.isArray(value) && value.length && value.every(isContent)) return value;
  if (isContent(value)) return [value];
  if (value === undefined) return [{ type: "text", text: "Done." }];
  return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }];
}

/** The arguments a call gave that the tool's schema doesn't list, or none: a tool with a `properties` list takes those and
 *  nothing else (unless it says `additionalProperties: true`), so a misspelt or unsupported one is refused instead of
 *  being dropped without a word. */
export function unknownArguments(schema: unknown, args: Record<string, unknown>): string[] {
  const s = schema as { properties?: Record<string, unknown>; additionalProperties?: unknown } | undefined;
  if (!s || typeof s.properties !== "object" || s.properties === null || s.additionalProperties === true) return [];
  return Object.keys(args).filter((k) => !Object.prototype.hasOwnProperty.call(s.properties, k));
}

const failed = (text: string) => ({ content: [{ type: "text", text }] as McpContent[], isError: true });

/** An error that reads differently to an AI client: code shared by the app's own commands and the MCP tools refuses
 *  with words for the person (`message`), and an MCP call answers with `forAi` (e.g. "ask the user to …"). */
export class AiWordedError extends Error {
  constructor(message: string, readonly forAi: string) { super(message); }
}

/** What an MCP call answers for a failure. */
export function mcpErrorText(e: unknown): string {
  if (e instanceof AiWordedError) return e.forAi;
  return e instanceof Error ? e.message : String(e);
}

/** How long a tool runs before a listening client first hears that it is still at work, and how often after that (ms). */
export const PROGRESS_EVERY = 3000;
/** The least time between two reports of a tool that says how far it is (ms): a loop over thousands reports each step. */
const PROGRESS_GAP = 250;

/** A tool call's progress, as MCP's notifications/progress for the client's token. A tool that reports counts (`done`)
 *  is passed on as it reports, never backwards (the protocol wants the value to grow); one that doesn't is reported by
 *  the clock, every PROGRESS_EVERY, with the seconds it has run as the value and what it last said, or what the app
 *  shows as its activity, as the message. */
export class CallProgress implements McpCall {
  private last = -1;
  private counted = false;
  private said: string | undefined;
  private sentAt = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly started: number;

  constructor(private token: string | number, private notify: (line: string) => void, private activity: () => string | undefined = () => undefined,
    private now: () => number = Date.now, every = PROGRESS_EVERY) {
    this.started = now();
    this.timer = setInterval(() => this.beat(), every);
  }

  private send(progress: number, message: string, total?: number) {
    if (!(progress > this.last)) return;
    this.last = progress;
    this.sentAt = this.now();
    const params = { progressToken: this.token, progress, ...(total !== undefined ? { total } : {}), message };
    try { this.notify(JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params })); } catch { /* a client that's gone */ }
  }

  private beat() {
    if (this.counted) return;
    const seconds = Math.round((this.now() - this.started) / 1000);
    this.send(seconds, `${this.said ?? this.activity() ?? "Working"} (${seconds} s)`);
  }

  progress(message: string, done?: number, total?: number) {
    if (this.timer === undefined) return;
    this.said = message;
    if (typeof done !== "number" || !Number.isFinite(done)) return;
    // The first count starts the value anew: the seconds sent so far would hold a small count back.
    if (!this.counted) { this.counted = true; this.last = -1; }
    const whole = typeof total === "number" && Number.isFinite(total) ? total : undefined;
    if (this.now() - this.sentAt < PROGRESS_GAP && done !== whole) return;
    this.send(done, message, whole);
  }

  /** The call is answered: nothing is sent after it. */
  end() {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** The call of a client that doesn't listen. */
const QUIET: McpCall = { progress() {} };

export class McpTools {
  private declared = new Map<string, Declared>();
  private handlers = new Map<string, McpToolHandler>();

  constructor(private hooks: McpHostHooks) {}

  /** From an extension's manifest. The first declaration of a name stays. */
  declare(extensionId: string, source: string, tools: McpToolContribution[]) {
    for (const tool of tools) {
      const other = this.declared.get(tool.name);
      if (!NAME.test(tool.name)) this.hooks.log(`${extensionId}: "${tool.name}" isn't a valid MCP tool name`);
      else if (other) this.hooks.log(`${extensionId}: the MCP tool ${tool.name} is already declared by ${other.extensionId}`);
      else this.declared.set(tool.name, { tool, extensionId, source });
    }
  }

  registerTool(name: string, handler: McpToolHandler): Disposable {
    if (!this.declared.has(name)) throw new Error(`The MCP tool "${name}" isn't declared in contributes.mcpTools.`);
    this.handlers.set(name, handler);
    return { dispose: () => { if (this.handlers.get(name) === handler) this.handlers.delete(name); } };
  }

  private usable(d: Declared) {
    return this.hooks.allowed({ source: d.source, readOnly: d.tool.readOnly === true, needs: d.tool.needs });
  }

  list() {
    return [...this.declared.values()].filter((d) => this.usable(d)).map(({ tool }) => ({
      name: tool.name,
      description: [tool.description, this.hooks.note?.(tool.name)].filter(Boolean).join(" "),
      inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
      annotations: { readOnlyHint: tool.readOnly === true },
    }));
  }

  /** Changes when the list does; the bridge tells the client then. */
  revision() {
    return fnv1a(JSON.stringify(this.list()));
  }

  async call(name: string, args: Record<string, unknown>, call: McpCall = QUIET): Promise<{ content: McpContent[]; isError?: boolean }> {
    const d = this.declared.get(name);
    if (!d || !this.usable(d)) return failed(`There's no tool "${name}".`);
    const unknown = unknownArguments(d.tool.inputSchema, args);
    if (unknown.length) {
      const takes = Object.keys((d.tool.inputSchema as { properties: object }).properties);
      return failed(`${name} doesn't take ${unknown.length === 1 ? "the argument" : "the arguments"} ${unknown.map((k) => `"${k}"`).join(", ")}, so nothing was done. It takes: ${takes.length ? takes.join(", ") : "no arguments"}.`);
    }
    try {
      if (!this.handlers.has(name)) await this.hooks.activate(`onMcpTool:${name}`);
      const handler = this.handlers.get(name);
      if (!handler) return failed(this.hooks.whyUnavailable(d.extensionId) ?? `${d.extensionId} didn't register the tool ${name}.`);
      await this.hooks.ready?.();
      return { content: toContent(await handler(args, call)) };
    } catch (e) {
      return failed(mcpErrorText(e));
    }
  }

  /** One JSON-RPC request from the bridge. Always answers, and never throws. */
  async handle(message: string, notify?: (line: string) => void): Promise<string> {
    let request: { id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown>; _meta?: { progressToken?: unknown } } };
    try { request = JSON.parse(message); } catch {
      return JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "not JSON" } });
    }
    const answer = (result: unknown) => JSON.stringify({ jsonrpc: "2.0", id: request.id ?? null, result });
    switch (request.method) {
      case "tools/list": return answer({ tools: this.list() });
      case "tools/call": {
        // A client that wants to hear of a long call's progress gives a token for it (MCP: params._meta.progressToken).
        const token = request.params?._meta?.progressToken;
        const progress = notify && (typeof token === "string" || typeof token === "number") ? new CallProgress(token, notify, () => this.hooks.activity?.()) : null;
        try {
          return answer(await this.call(String(request.params?.name), request.params?.arguments ?? {}, progress ?? QUIET));
        } finally {
          progress?.end();
        }
      }
      case "w3/revision": return answer({ revision: this.revision() });
      default: return JSON.stringify({ jsonrpc: "2.0", id: request.id ?? null, error: { code: -32601, message: `unknown method ${request.method}` } });
    }
  }
}

/** A project-relative path, with forward slashes; throws for anything that could leave the project. */
export function projectPath(path: string): string {
  const p = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!p || p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.split("/").includes("..")) throw new Error(`"${path}" isn't a path inside the project.`);
  return p;
}
