import assert from "node:assert/strict";
import { test } from "node:test";
import { AiWordedError, McpTools, projectPath, type McpHostHooks } from "./mcp";

function tools(over: Partial<McpHostHooks> = {}) {
  const logged: string[] = [];
  const t = new McpTools({ activate: async () => {}, allowed: () => true, whyUnavailable: () => undefined, log: (l) => logged.push(l), ...over });
  return { t, logged };
}
const read = { name: "look", description: "Looks", readOnly: true };

test("a note from the user joins a tool's description, and the client hears of it", () => {
  let note: string | undefined;
  const t = new McpTools({ activate: async () => {}, allowed: () => true, whyUnavailable: () => undefined, log: () => {}, note: (name) => (name === "one" ? note : undefined) });
  t.declare("x", "builtin", [{ name: "one", description: "Does a thing." }, { name: "two", description: "Another." }]);
  const before = t.revision();
  assert.equal(t.list()[0].description, "Does a thing.");
  note = "Don't plan around undo.";
  assert.equal(t.list()[0].description, "Does a thing. Don't plan around undo.");
  assert.equal(t.list()[1].description, "Another.");
  assert.notEqual(t.revision(), before);
});

test("a declared tool is listed before its extension runs, which activates on the first call", async () => {
  let activated = "";
  const { t } = tools({ activate: async (e) => { activated = e; t.registerTool("look", () => "seen"); } });
  t.declare("ext.a", "builtin", [read]);
  assert.deepEqual(t.list().map((x) => [x.name, x.annotations.readOnlyHint]), [["look", true]]);
  assert.equal(activated, "");
  assert.deepEqual(await t.call("look", {}), { content: [{ type: "text", text: "seen" }] });
  assert.equal(activated, "onMcpTool:look");
});

test("a failing tool, or one that can't start, is an error of that call only", async () => {
  const { t } = tools({ whyUnavailable: (id) => `${id} failed to activate` });
  t.declare("ext.a", "builtin", [read, { name: "boom", description: "Fails" }]);
  t.registerTool("boom", () => { throw new Error("no terrain"); });
  assert.deepEqual(await t.call("boom", {}), { content: [{ type: "text", text: "no terrain" }], isError: true });
  assert.deepEqual(await t.call("look", {}), { content: [{ type: "text", text: "ext.a failed to activate" }], isError: true });
  assert.equal((await t.call("nothing", {})).isError, true);
});

test("an error worded for people and for an AI: the MCP call answers with the AI's words", async () => {
  const { t } = tools();
  t.declare("ext.a", "builtin", [{ name: "refuse", description: "Refuses" }]);
  t.registerTool("refuse", () => { throw new AiWordedError("Save it first.", "Ask the user to save it first."); });
  assert.deepEqual(await t.call("refuse", {}), { content: [{ type: "text", text: "Ask the user to save it first." }], isError: true });
  assert.equal(new AiWordedError("Save it first.", "Ask the user.").message, "Save it first.", "the app shows the message");
});

test("an activation that throws is an error too", async () => {
  const { t } = tools({ activate: async () => { throw new Error("broken"); } });
  t.declare("ext.a", "builtin", [read]);
  assert.deepEqual(await t.call("look", {}), { content: [{ type: "text", text: "broken" }], isError: true });
});

test("handlers return text, images or data", async () => {
  const { t } = tools();
  t.declare("ext.a", "builtin", [read]);
  const result = async (value: unknown) => { const d = t.registerTool("look", () => value); const r = await t.call("look", {}); d.dispose(); return r.content; };
  const image = { type: "image", data: "QQ==", mimeType: "image/png" };
  assert.deepEqual(await result(image), [image]);
  assert.deepEqual(await result([image, image]), [image, image]);
  assert.deepEqual(await result({ n: 1 }), [{ type: "text", text: '{\n  "n": 1\n}' }]);
  assert.deepEqual(await result(undefined), [{ type: "text", text: "Done." }]);
});

test("names: one owner, valid, and declared before registering", () => {
  const { t, logged } = tools();
  t.declare("ext.a", "builtin", [read]);
  t.declare("ext.b", "builtin", [read, { name: "has space", description: "" }]);
  assert.equal(t.list().length, 1);
  assert.equal(logged.length, 2);
  assert.throws(() => t.registerTool("secret", () => "x"), /isn't declared/);
});

test("settings can hide a tool from the list and from calls", async () => {
  const { t } = tools({ allowed: ({ source, readOnly }) => source === "builtin" && readOnly });
  t.declare("ext.a", "project", [read]);
  t.declare("ext.b", "builtin", [{ name: "edit", description: "Writes" }, { name: "peek", description: "Reads", readOnly: true }]);
  t.registerTool("look", () => "seen");
  assert.deepEqual(t.list().map((x) => x.name), ["peek"]);
  assert.equal((await t.call("look", {})).isError, true);
});

test("a tool can need a setting of its own", () => {
  let on = false;
  const { t } = tools({ allowed: ({ needs }) => !needs || on });
  t.declare("ext.a", "builtin", [read, { name: "save", description: "Saves", needs: "mcp.saveTool" }]);
  assert.deepEqual(t.list().map((x) => x.name), ["look"]);
  const closed = t.revision();
  on = true;
  assert.deepEqual(t.list().map((x) => x.name), ["look", "save"]);
  assert.notEqual(t.revision(), closed);
});

test("the revision follows the list", () => {
  const { t } = tools();
  const empty = t.revision();
  t.declare("ext.a", "builtin", [read]);
  assert.notEqual(t.revision(), empty);
});

test("requests from the bridge always get an answer", async () => {
  const { t } = tools();
  t.declare("ext.a", "builtin", [read]);
  t.registerTool("look", (a) => `arg ${a.x}`);
  const ask = async (m: unknown) => JSON.parse(await t.handle(typeof m === "string" ? m : JSON.stringify(m)));
  assert.equal((await ask({ id: 1, method: "tools/list" })).result.tools[0].name, "look");
  assert.equal((await ask({ id: 2, method: "tools/call", params: { name: "look", arguments: { x: 5 } } })).result.content[0].text, "arg 5");
  assert.equal((await ask({ id: 3, method: "w3/revision" })).result.revision, t.revision());
  assert.equal((await ask({ id: 4, method: "nope" })).error.code, -32601);
  assert.equal((await ask("{broken")).error.code, -32700);
});

test("paths stay in the project", () => {
  assert.equal(projectPath("map\\war3map.j"), "map/war3map.j");
  assert.equal(projectPath("./w3proj.toml"), "w3proj.toml");
  for (const bad of ["", "../secret", "map/../../secret", "C:\\Windows\\win.ini", "/etc/passwd", "map\\..\\..\\x"]) assert.throws(() => projectPath(bad), bad);
});
