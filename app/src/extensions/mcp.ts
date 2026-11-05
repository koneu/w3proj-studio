// The tools the MCP server offers. There's one server (`w3proj mcp` and the app's pipe), and it
// knows nothing about what tools do: each extension declares its own in `contributes.mcpTools`
// and answers them with `w3.mcp.registerTool`.
//
// A declared tool is listed without loading its extension, which activates on the first call.
// A disabled extension contributes nothing, so its tools are simply not there. Whatever goes
// wrong in a tool ends as an error result of that one call.

import type { Disposable, McpContent, McpToolContribution, McpToolHandler } from "./api";

interface Declared { tool: McpToolContribution; extensionId: string; source: string }

export interface McpHostHooks {
  /** Activates the extensions answering an event ("onMcpTool:<name>"). */
  activate(event: string): Promise<void>;
  /** Whether a tool may be used now (settings: project extensions' tools, writing tools). */
  allowed(declared: { source: string; readOnly: boolean }): boolean;
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

const failed = (text: string) => ({ content: [{ type: "text", text }] as McpContent[], isError: true });

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
    return this.hooks.allowed({ source: d.source, readOnly: d.tool.readOnly === true });
  }

  list() {
    return [...this.declared.values()].filter((d) => this.usable(d)).map(({ tool }) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
      annotations: { readOnlyHint: tool.readOnly === true },
    }));
  }

  /** Changes when the list does; the bridge tells the client then. */
  revision() {
    return fnv1a(JSON.stringify(this.list()));
  }

  async call(name: string, args: Record<string, unknown>): Promise<{ content: McpContent[]; isError?: boolean }> {
    const d = this.declared.get(name);
    if (!d || !this.usable(d)) return failed(`There's no tool "${name}".`);
    try {
      if (!this.handlers.has(name)) await this.hooks.activate(`onMcpTool:${name}`);
      const handler = this.handlers.get(name);
      if (!handler) return failed(this.hooks.whyUnavailable(d.extensionId) ?? `${d.extensionId} didn't register the tool ${name}.`);
      return { content: toContent(await handler(args)) };
    } catch (e) {
      return failed(e instanceof Error ? e.message : String(e));
    }
  }

  /** One JSON-RPC request from the bridge. Always answers, and never throws. */
  async handle(message: string): Promise<string> {
    let request: { id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    try { request = JSON.parse(message); } catch {
      return JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "not JSON" } });
    }
    const answer = (result: unknown) => JSON.stringify({ jsonrpc: "2.0", id: request.id ?? null, result });
    switch (request.method) {
      case "tools/list": return answer({ tools: this.list() });
      case "tools/call": return answer(await this.call(String(request.params?.name), request.params?.arguments ?? {}));
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
