// Makes target/object-texts/object-texts-a.w3x and -b.w3x (flat.w3x with object texts and a war3map.wts of its own) for
// what the World Editor's save does with literal object texts (docs/testing/object-text-strings.md): open each with
// `we-drive --map <in> --wait-ready --save <out> --close` and unpack the result.
// - a: units out of id order with duplicate literals, a reference (7) with a comment of its own, a string two fields
//   share (12), an unused string (9), a literal equal to an unreferenced string (20), a text holding a reference, a
//   name in both the main and the Skin file, Skin-only fields, an item, an ability's tip on three levels, an empty tip;
// - b: a literal with string 7's text before the unit that refers to 7, three literals for two strings of the same text
//   (8, 15), units in the file as h005 before h004, a reference the table lacks (50), an item named as player 1.
// Packed with --keep-unused-strings, so the table holds what is written here.
//
//   node tests/fixtures/we-specs/make-object-texts.mjs <w3proj cli> <game folder> [--out DIR] [--allow-stale]
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const [cli, game] = argv.slice(0, 2).map((p) => (p ? resolve(p) : p));
if (!game) { console.error("usage: make-object-texts.mjs <w3proj cli> <game folder> [--out DIR]"); process.exit(2); }
requireFresh(cli, "cli");
let out = resolve(here, "..", "..", "..", "target", "object-texts");
for (let i = 2; i < argv.length; i++) {
  if (argv[i] === "--out") out = resolve(argv[++i]);
  else if (argv[i] !== "--allow-stale") throw new Error(`unknown argument ${argv[i]}`);
}
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const s = (field, value, level) => (level === undefined ? { field, type: "string", value } : { field, type: "string", level, data: 0, value });
const file = (original, custom) => JSON.stringify({ format: "w3proj.objects/1", version: 3, original, custom }, null, 2) + "\n";
/** A war3map.wts from [number, text, comment?] rows, as the editor writes it (BOM, CRLF). */
const table = (rows) => String.fromCharCode(0xfeff) + rows.map(([n, text, comment]) => [`STRING ${n}`, ...(comment ? [comment] : []), "{", text, "}", ""].join("\r\n")).join("\r\n") + "\r\n";
const players = [[1, "Player 1"], [2, "Force 1"]];

const inputs = {
  "object-texts-a.w3x": {
    "war3map.wts": table([...players, [7, "Existing Tip", "// my own comment"], [9, "Orphan"], [12, "Shared Text"], [20, "Same As Literal"]]),
    "war3map.w3u.json": file([{ base: "hfoo", mods: [s("unam", "Plain Footman")] }], [
      { base: "hfoo", id: "h002", mods: [s("unam", "TRIGSTR_012"), s("utip", "Same As Literal")] },
      { base: "hfoo", id: "h000", mods: [s("unam", "Dup Text"), s("utip", "Dup Text"), s("uhot", "Q")] },
      { base: "hfoo", id: "h001", mods: [s("unam", "Dup Text"), s("utip", "TRIGSTR_007"), s("ides", "TRIGSTR_012"), s("utub", "See TRIGSTR_007 here")] },
      { base: "hfoo", id: "h003", mods: [s("unam", "Main Name"), { field: "uhpm", type: "int", value: 500 }] },
    ]),
    "war3mapSkin.w3u.json": file([{ base: "hfoo", mods: [s("utip", "Skin Footman Tip")] }], [
      { base: "hfoo", id: "h000", mods: [s("unsf", "Skin Suffix")] },
      { base: "hfoo", id: "h003", mods: [s("unam", "Skin Name")] },
    ]),
    "war3map.w3a.json": file([], [{ base: "AHhb", id: "A000", mods: [
      s("anam", "Abil Name", 0), s("atp1", "Lvl", 1), s("atp1", "Lvl", 2), s("atp1", "Lvl", 3), s("aub1", "", 1),
    ] }]),
    "war3map.w3t.json": file([], [{ base: "ratc", id: "I000", mods: [s("unam", "Dup Text")] }]),
  },
  "object-texts-b.w3x": {
    "war3map.wts": table([...players, [7, "Existing Tip"], [8, "Twice"], [15, "Twice"]]),
    "war3map.w3u.json": file([], [
      { base: "hfoo", id: "h005", mods: [s("unam", "Five")] },
      { base: "hfoo", id: "h004", mods: [s("unam", "Four"), s("ides", "TRIGSTR_050")] },
      { base: "hfoo", id: "h006", mods: [s("unam", "Six"), s("utip", "Existing Tip")] },
      { base: "hfoo", id: "h007", mods: [s("unam", "Seven"), s("utip", "TRIGSTR_007")] },
      { base: "hfoo", id: "h008", mods: [s("unam", "Twice"), s("utip", "Twice"), s("utub", "Twice")] },
    ]),
    "war3map.w3t.json": file([], [{ base: "ratc", id: "I000", mods: [s("unam", "Player 1")] }]),
  },
};

mkdirSync(out, { recursive: true });
for (const [name, files] of Object.entries(inputs)) {
  const scratch = mkdtempSync(join(tmpdir(), "we-object-texts-"));
  try {
    const dir = join(scratch, "map");
    run("unpack", join(here, "flat.w3x"), dir, "--game", game);
    for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, "map", f), text);
    run("pack", "--keep-objects", dir, "-o", join(out, name), "--force-stale", "--keep-unused-strings");
    console.log(`made ${join(out, name)}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
