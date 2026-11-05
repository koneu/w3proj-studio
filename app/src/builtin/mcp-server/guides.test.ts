import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { GUIDES } from "./guides";

const builtin = "src/builtin";
const tools = new Set(readdirSync(builtin, { withFileTypes: true }).filter((d) => d.isDirectory()).flatMap((d) => {
  const manifest = JSON.parse(readFileSync(join(builtin, d.name, "extension.json"), "utf8")) as { contributes?: { mcpTools?: { name: string }[] } };
  return (manifest.contributes?.mcpTools ?? []).map((t) => t.name);
}));

test("guides only name tools that exist", () => {
  assert.ok(tools.size > 40);
  for (const [topic, guide] of Object.entries(GUIDES)) {
    for (const [word] of guide.text.matchAll(/\b[a-z]+_[a-z_]+\b/g)) assert.ok(tools.has(word), `${topic} names ${word}, which is no tool`);
  }
});

test("the guides a client is pointed at exist", () => {
  for (const topic of ["melee", "terrain", "spells"]) assert.ok(GUIDES[topic], topic);
});

test("read_guide is offered, and every guide says what it's for", () => {
  assert.ok(tools.has("read_guide"));
  for (const guide of Object.values(GUIDES)) assert.ok(guide.summary.length > 20 && guide.text.startsWith("# "));
});

test("the place_objects options the melee guide relies on are declared", () => {
  const manifest = readFileSync(join(builtin, "terrain-viewer", "extension.json"), "utf8");
  const tool = (JSON.parse(manifest) as { contributes: { mcpTools: { name: string; inputSchema: { properties: { objects: { items: { properties: Record<string, unknown> } } } } }[] } })
    .contributes.mcpTools.find((t) => t.name === "place_objects")!;
  for (const option of ["camp", "gold", "drops"]) assert.ok(option in tool.inputSchema.properties.objects.items.properties, option);
  assert.ok(new RegExp("camp true").test(GUIDES.melee.text) && GUIDES.melee.text.includes("drops on place_objects"));
});

test("no MCP setting can come from a project: a map from someone else mustn't open the door", () => {
  const manifest = JSON.parse(readFileSync(join(builtin, "mcp-server", "extension.json"), "utf8")) as { contributes: { configuration: { properties: Record<string, { scope?: string }> } } };
  const settings = Object.entries(manifest.contributes.configuration.properties);
  assert.ok(settings.length >= 6);
  for (const [key, value] of settings) assert.equal(value.scope, "user", key);
});
