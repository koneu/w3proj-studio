import type { StreamParser } from "@codemirror/language";

const KEYWORDS = new Set(
  "function takes returns return endfunction local set call if then else elseif endif loop endloop exitwhen globals endglobals constant native type extends array and or not debug"
    .split(" "),
);
// vJASS additions handled by JassHelper.
const VJASS = new Set(
  "library endlibrary scope endscope struct endstruct method endmethod interface endinterface module endmodule implement private public static stub operator requires needs uses initializer readonly delegate thistype hook textmacro endtextmacro runtextmacro optional defaults keyword".split(" "),
);
const TYPES = new Set(
  "nothing integer real boolean string code handle agent unit item player group force trigger timer location rect region effect sound destructable widget ability buff event triggeraction triggercondition boolexpr conditionfunc filterfunc dialog button quest multiboard leaderboard texttag lightning image ubersplat hashtable framehandle"
    .split(" "),
);
const ATOMS = new Set(["true", "false", "null"]);

export const jass: StreamParser<{ inComment: boolean }> = {
  name: "jass",
  startState: () => ({ inComment: false }),
  token(stream, state) {
    if (state.inComment) {
      if (stream.skipTo("*/")) { stream.match("*/"); state.inComment = false; }
      else stream.skipToEnd();
      return "comment";
    }
    if (stream.eatSpace()) return null;
    if (stream.match("//")) { stream.skipToEnd(); return "comment"; }
    if (stream.match("/*")) { state.inComment = true; return "comment"; }
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";
    if (stream.match(/^'(?:[^'\\]|\\.){1,4}'/)) return "number"; // rawcode 'hfoo'
    if (stream.match(/^(?:0x|\$)[0-9a-f]+/i) || stream.match(/^\d*\.?\d+/)) return "number";
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) {
      const w = stream.current();
      if (KEYWORDS.has(w) || VJASS.has(w)) return "keyword";
      if (TYPES.has(w)) return "typeName";
      if (ATOMS.has(w)) return "atom";
      if (stream.match(/^\s*\(/, false)) return "function";
      return "variableName";
    }
    stream.next();
    return "operator";
  },
  languageData: { commentTokens: { line: "//", block: { open: "/*", close: "*/" } } },
};
