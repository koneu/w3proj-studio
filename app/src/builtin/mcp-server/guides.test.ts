import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { GUIDES, guideTemplate, hasRules, isTopic, LAYOUT_IDEAS, layoutIdea, ownTopics, parseGuide, parseOwnGuide, rulesTemplate, withOwnRules } from "./guides";

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

test("sources and notes stay out of what the AI reads", () => {
  const g = parseGuide("<!--\nsummary: What it's for.\n\nSources: https://example.org\n-->\n\n# Title\n\nText <!-- inline --> here.\n");
  assert.equal(g.summary, "What it's for.");
  assert.ok(g.text.startsWith("# Title") && !g.text.includes("example.org") && !g.text.includes("inline"));
  for (const guide of Object.values(GUIDES)) assert.ok(!/<!--|https?:/.test(guide.text));
});

test("every guide keeps its sources in its file", () => {
  for (const topic of Object.keys(GUIDES)) assert.match(readFileSync(join(builtin, "mcp-server", "guides", `${topic}.md`), "utf8"), /Sources of the \w+ guide/);
});

test("a user's rules follow the guide and win", () => {
  const text = withOwnRules(GUIDES.melee.text, "Camps only in corners.");
  assert.ok(text.startsWith(GUIDES.melee.text));
  assert.match(text, /own rules[\s\S]*they win[\s\S]*Camps only in corners\.$/m);
});

test("a template nobody filled in changes nothing", () => {
  const empty = rulesTemplate("melee");
  assert.equal(hasRules(empty), false);
  assert.equal(hasRules(""), false);
  assert.equal(withOwnRules("Guide.\n", empty), "Guide.\n");
  assert.equal(hasRules(`${empty}No trees.`), true);
  assert.ok(!withOwnRules("Guide.\n", `${empty}No trees.`).includes("Your own rules for"), "the comment isn't sent");
});

test("a file dropped in the folder is a guide, and one named like a built-in holds rules", () => {
  const folder = "C:\\Users\\me\\AppData\\guides";
  assert.deepEqual(ownTopics([`${folder}\\pathing.md`, `${folder}\\melee.md`, `${folder}\\My Style.md`, `${folder}\\notes.txt`], folder), ["My Style", "pathing"]);
  assert.deepEqual(ownTopics(["pathing.md", "MELEE.md"], folder), ["pathing"], "relative paths too, in any case");
});

test("a folder inside the folder, or an odd name, is no topic", () => {
  assert.deepEqual(ownTopics(["C:/g/old/pathing.md", "C:/g/a.b.md", "C:/g/../x.md"], "C:/g"), []);
  for (const bad of ["", " x", "a/b", "..", "a.b", "a\\b"]) assert.equal(isTopic(bad), false, bad);
  assert.equal(isTopic("Über pathing_2"), true);
});

test("a user's guide can be plain text", () => {
  const plain = parseOwnGuide("# Pathing\n\nKeep ways wide.\n");
  assert.equal(plain.summary, "Pathing");
  assert.match(plain.text, /Keep ways wide/);
  assert.equal(parseOwnGuide("Just some rules.\n").summary, "Just some rules.");
  const made = parseOwnGuide(`${guideTemplate("pathing")}Text.\n`);
  assert.equal(made.summary, "One line on when the AI should read this guide.");
  assert.ok(made.text.startsWith("# pathing") && !made.text.includes("AI doesn't see"));
});

test("layout ideas differ by chance, and every one can come up", () => {
  const seen = new Set(LAYOUT_IDEAS.map((_, i) => layoutIdea(() => i / LAYOUT_IDEAS.length)));
  assert.equal(seen.size, LAYOUT_IDEAS.length);
  assert.ok(layoutIdea(() => 0.999999).includes(LAYOUT_IDEAS[LAYOUT_IDEAS.length - 1]));
  assert.ok(!LAYOUT_IDEAS.some((idea) => /main base on|plateau for the base/i.test(idea)), "not the habit it's meant to break");
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
