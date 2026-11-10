// rust-test-modules.mjs: which modules of a Rust file are test-only, and where they end, on made-up sources with the
// usual traps (braces in strings, raw strings, characters, comments; lifetimes; nested and file modules).

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { baseWithTests, cfgOnlyInTests, rustTestModules } from "./rust-test-modules.mjs";

test("cfg predicates that only hold in tests", () => {
  for (const yes of ["cfg(test)", "cfg(all(test, unix))", "cfg(all(unix, test))", `cfg(all(test, feature = "x"))`, "cfg(not(not(test)))", "cfg(any(test, test))", "cfg( test )"]) assert.equal(cfgOnlyInTests(yes), true, yes);
  for (const no of ["cfg(not(test))", "cfg(unix)", `cfg(any(test, feature = "x"))`, "cfg(any(test, unix))", "cfg_attr(test, allow(dead_code))", "allow(dead_code)", "test", "cfg(test", "cfg(all(test, unix)"]) assert.equal(cfgOnlyInTests(no), false, no);
});

test("test modules by any name, with what they hold, and only those", () => {
  const src = [
    "fn a<'a>(x: &'a str) -> &'a str { x }", // a lifetime isn't a character literal
    "#[cfg(not(test))]",
    "mod real { fn b() {} }",
    "#[cfg(all(test, unix))]",
    "#[allow(clippy::all)]",
    "mod fs_tests {",
    "    // }",
    "    /* } /* nested } */ */",
    `    fn t() { let _ = ['}', '\\'', '\\u{7D}']; let _ = "}\\""; let _ = r##"}"#"##; let _ = b'}'; }`,
    "}",
    "mod outer {",
    "    #[cfg(test)]",
    "    pub(crate) mod inner { fn u() {} }",
    "}",
    "#[cfg(test)] mod by_file;",
    `const S: &str = "#[cfg(test)] mod fake { }";`,
    "// #[cfg(test)] mod commented { }",
    "#[cfg(test)]",
    "fn helper() {}",
    "",
  ].join("\n");
  const found = rustTestModules(src);
  assert.deepEqual(found.map((m) => m.name), ["fs_tests", "inner", "by_file"]);
  assert.equal(src.slice(found[0].start, found[0].end), src.split("\n").slice(3, 10).join("\n") + "\n");
  assert.equal(src.slice(found[1].start, found[1].end), "    #[cfg(test)]\n    pub(crate) mod inner { fn u() {} }\n");
  assert.equal(src.slice(found[2].start, found[2].end), "#[cfg(test)] mod by_file;\n");
});

test("the base's code with the new tests", () => {
  const old = "fn a() { 1 }\n#[cfg(test)]\nmod tests { OLD }\nfn b() {}\n#[cfg(test)]\nmod more { OLD2 }\n";
  const cur = "fn a() { 2 }\n#[cfg(test)]\nmod tests { NEW }\nfn b() { 3 }\n#[cfg(all(test, unix))]\nmod fs_tests { NEW2 }";
  assert.equal(baseWithTests(old, cur), "fn a() { 1 }\n#[cfg(test)]\nmod tests { NEW }\n#[cfg(all(test, unix))]\nmod fs_tests { NEW2 }\nfn b() {}\n");
  assert.equal(baseWithTests("fn a() {}", cur), "fn a() {}\n\n#[cfg(test)]\nmod tests { NEW }\n#[cfg(all(test, unix))]\nmod fs_tests { NEW2 }\n");
  assert.equal(baseWithTests(old, "fn a() {}\n"), null);
  // CRLF files keep their line ends.
  assert.equal(baseWithTests("fn a() {}\r\n#[cfg(test)]\r\nmod tests { OLD }\r\n", "fn a() { 2 }\r\n#[cfg(test)]\r\nmod tests { NEW }\r\n"), "fn a() {}\r\n#[cfg(test)]\r\nmod tests { NEW }\r\n");
});

test("every Rust file of the repository: its test modules end in a closing brace or a semicolon, and taking them out and putting them back is the file", () => {
  const repo = join(process.cwd(), "..");
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!["target", "node_modules", ".git", ".worktrees"].includes(e.name)) walk(join(dir, e.name)); } else if (e.name.endsWith(".rs")) files.push(join(dir, e.name));
    }
  };
  walk(join(repo, "crates"));
  walk(join(repo, "app", "src-tauri", "src"));
  assert.ok(files.length > 20, `only ${files.length} Rust files found`);
  let modules = 0;
  for (const f of files) {
    const s = readFileSync(f, "utf8");
    const found = rustTestModules(s);
    modules += found.length;
    for (const m of found) assert.match(s.slice(m.start, m.end).trimEnd(), /[};]$/, `${f}: ${m.name}`);
    if (found.length) assert.equal(baseWithTests(s, s), s.slice(0, found[0].start) + found.map((m) => s.slice(m.start, m.end)).join("") + found.slice(0, -1).map((m, n) => s.slice(m.end, found[n + 1].start)).join("") + s.slice(found.at(-1).end), f);
  }
  assert.ok(modules > 20, `only ${modules} test modules found`);
});
