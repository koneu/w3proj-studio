import assert from "node:assert/strict";
import { test } from "node:test";
import { vjassExports, vjassSymbols } from "./symbols";

const SMOKE_LIB = `library SmokeLib initializer Init requires Other
    globals
        public integer Count = 0
        private real hidden = 1.0
        boolean Plain = true
    endglobals

    public function Build takes unit u returns nothing
        local integer i = 0
    endfunction

    private function Secret takes nothing returns nothing
    endfunction

    function Helper takes nothing returns integer
        return 1
    endfunction

    public struct Box
        integer size
        static method create takes nothing returns thistype
            return 0
        endmethod
    endstruct

    module Mod
    endmodule

    private function Init takes nothing returns nothing
    endfunction
endlibrary

function Outside takes nothing returns nothing
endfunction
`;

test("another library's functions: public ones by Library_Name, plain ones by name, private ones not", () => {
  const out = vjassExports(SMOKE_LIB, "trigger:Smoke Lib");
  const names = out.map((s) => s.name);
  assert.ok(names.includes("SmokeLib_Build"), names.join(" "));
  assert.deepEqual(names.filter((n) => n.startsWith("SmokeLib_Bu")), ["SmokeLib_Build"]);
  assert.deepEqual(names.sort(), ["Helper", "Outside", "Plain", "SmokeLib_Box", "SmokeLib_Build", "SmokeLib_Count"]);
  const build = out.find((s) => s.name === "SmokeLib_Build")!;
  assert.equal(build.kind, "function");
  assert.equal(build.location, "trigger:Smoke Lib");
  assert.equal(build.at, undefined);
  assert.match(build.detail, /public function Build takes unit u/);
});

test("scopes prefix their public members too; CRLF texts", () => {
  const out = vjassExports("scope Spells\r\n    public function Cast takes nothing returns nothing\r\n    endfunction\r\nendscope\r\n", "trigger:x");
  assert.deepEqual(out.map((s) => s.name), ["Spells_Cast"]);
});

test("library globals know their library", () => {
  const g = vjassSymbols(SMOKE_LIB).find((s) => s.name === "Count")!;
  assert.equal(g.container, "SmokeLib");
});
