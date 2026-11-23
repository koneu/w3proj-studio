// Edits the trigger folders of an unpacked project (map/triggers/, crates/w3proj/src/trigger_layout.rs) for the make-*.mjs
// generators: one file per trigger, order.txt per folder, variables.json per folder. New items carry no id, `w3proj pack`
// gives them free ids and raises the counters. A file that is absent means "no text".
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const slug = (name) => name.replace(/[<>:"/\\|?*\s]+/g, "_").replace(/^[.$]+/, "_") || "item";
const triggersDir = (project) => join(project, "map", "triggers");
const folderDir = (project, folder) => (folder ? join(triggersDir(project), folder) : triggersDir(project));
const lines = (file) => (existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l !== "") : []);
const setLines = (file, l) => writeFileSync(file, l.length ? `${l.join("\n")}\n` : "");

/** Appends an entry to a folder's order.txt (`folder` "": the root). */
function order(project, folder, entry, before) {
  const file = join(folderDir(project, folder), "order.txt");
  const l = lines(file);
  const at = before ? l.indexOf(before) : -1;
  if (before && at < 0) throw new Error(`${file}: no entry ${before}`);
  l.splice(at < 0 ? l.length : at, 0, entry);
  setLines(file, l);
}

/** A GUI trigger (`item`: type 8 fields, name and ecas) at the end of `folder`. */
export function addGuiTrigger(project, item, folder = "Initialization") {
  const { id, parent, isCustom, ...rest } = item;
  const body = { type: 8, ...rest };
  writeFileSync(join(folderDir(project, folder), `${slug(item.name)}.gui.json`), `${JSON.stringify(body, null, 2)}\n`);
  order(project, folder, `${slug(item.name)}.gui.json`);
}

/** A custom-text trigger `item` (name, description, …) holding `text`. */
export function addScriptTrigger(project, item, text, folder = "Initialization") {
  const { id, parent, isCustom, ecas, ...rest } = item;
  const file = `${slug(item.name)}.j`;
  writeFileSync(join(folderDir(project, folder), file), `// @w3proj ${JSON.stringify({ type: 8, ...rest })}\n${text}`);
  order(project, folder, file);
}

/** A category folder at the root, before the entry `before` (default: at the end). */
export function addCategory(project, name, before) {
  const dir = join(triggersDir(project), slug(name));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "_category.json"), `${JSON.stringify({ type: 4, name, isComment: 0, expanded: 0 })}\n`);
  writeFileSync(join(dir, "order.txt"), "");
  order(project, "", slug(name), before);
}

/** The category folder `folder`'s record. */
export function readCategory(project, folder) {
  return JSON.parse(readFileSync(join(folderDir(project, folder), "_category.json"), "utf8"));
}

/** Renames the category stored in `folder` (its folder keeps its name). */
export function renameCategory(project, folder, name) {
  const file = join(folderDir(project, folder), "_category.json");
  writeFileSync(file, `${JSON.stringify({ ...readCategory(project, folder), name })}\n`);
}

/** Variables `vars` (name, type, isArray, arraySize, initialized, initialValue, unknown) in `folder`, each with its place in the tree. */
export function addVariables(project, vars, folder = "Initialization") {
  const file = join(folderDir(project, folder), "variables.json");
  const l = lines(file);
  for (const v of vars) {
    const { id, parent, ...rest } = v;
    l.push(JSON.stringify(rest));
    order(project, folder, `$${v.name}`);
  }
  setLines(file, l);
}

/** The custom script header text (header.j). */
export function setHeader(project, text) {
  writeFileSync(join(triggersDir(project), "header.j"), text);
}

/** Replaces `project`'s triggers with those of `from` (a project folder). */
export function copyTriggers(from, project) {
  rmSync(triggersDir(project), { recursive: true, force: true });
  for (const f of readdirSync(join(project, "map"))) if (/^war3map\.(wtg|wct)(\.|$)/.test(f)) rmSync(join(project, "map", f), { force: true });
  cpSync(triggersDir(from), triggersDir(project), { recursive: true });
}
