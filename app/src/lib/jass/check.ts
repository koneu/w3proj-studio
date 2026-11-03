// A JASS checker: parses JASS (types, globals, natives, functions), and
// reports syntax errors, unknown names, wrong argument counts, type mismatches
// and the rules the game's compiler enforces (locals first, `call`/`set`,
// functions declared before use). Declarations come from an environment built
// from other sources (common.j, Blizzard.j, the map script) with `envFrom`.

export interface Diagnostic { from: number; to: number; message: string; severity: "error" | "warning" }

export interface FunctionSig { params: { name: string; type: string }[]; returns: string; native: boolean; constant: boolean }
export interface GlobalVar { type: string; array: boolean; constant: boolean }
export interface JassEnv {
  /** Type → its parent ("" for the primitives). */
  types: Map<string, string>;
  globals: Map<string, GlobalVar>;
  functions: Map<string, FunctionSig>;
}

const PRIMITIVES = ["integer", "real", "boolean", "string", "handle", "code", "nothing"];

export function emptyEnv(): JassEnv {
  return { types: new Map(PRIMITIVES.map((t) => [t, ""])), globals: new Map(), functions: new Map() };
}

// ---- lexer --------------------------------------------------------------------------
type TokKind = "id" | "kw" | "int" | "real" | "str" | "op" | "nl" | "eof";
interface Tok { kind: TokKind; text: string; from: number; to: number }

const KEYWORDS = new Set(["globals", "endglobals", "type", "extends", "constant", "native", "function", "takes", "returns", "nothing",
  "endfunction", "local", "array", "set", "call", "if", "then", "elseif", "else", "endif", "loop", "exitwhen", "endloop", "return",
  "and", "or", "not", "true", "false", "null", "debug"]);

function lex(src: string, diags: Diagnostic[]): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const push = (kind: TokKind, from: number, to: number) => toks.push({ kind, text: src.slice(from, to), from, to });
  while (i < src.length) {
    const c = src[i];
    if (c === "\n") { push("nl", i, i + 1); i++; continue; }
    if (c === " " || c === "\t" || c === "\r") { i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    const start = i;
    if (/[A-Za-z]/.test(c)) {
      while (i < src.length && /\w/.test(src[i])) i++;
      push(KEYWORDS.has(src.slice(start, i)) ? "kw" : "id", start, i);
      continue;
    }
    if (c === "\"") {
      i++;
      while (i < src.length && src[i] !== "\"") i += src[i] === "\\" ? 2 : 1;
      if (i >= src.length) diags.push({ from: start, to: src.length, message: "Unclosed string", severity: "error" });
      i++;
      push("str", start, Math.min(i, src.length));
      continue;
    }
    if (c === "'") {
      i++;
      while (i < src.length && src[i] !== "'" && src[i] !== "\n") i += src[i] === "\\" ? 2 : 1;
      const len = i - start - 1;
      if (src[i] !== "'") diags.push({ from: start, to: i, message: "Unclosed object code ('hfoo')", severity: "error" });
      else if (len !== 1 && len !== 4 && !src.slice(start + 1, i).includes("\\")) diags.push({ from: start, to: i + 1, message: "Object codes have 1 or 4 characters", severity: "error" });
      i++;
      push("int", start, i);
      continue;
    }
    if (/[0-9.]/.test(c) && (c !== "." || /[0-9]/.test(src[i + 1] ?? ""))) {
      if (c === "0" && /[xX]/.test(src[i + 1] ?? "")) { i += 2; while (/[0-9a-fA-F]/.test(src[i] ?? "")) i++; push("int", start, i); continue; }
      while (/[0-9]/.test(src[i] ?? "")) i++;
      if (src[i] === ".") { i++; while (/[0-9]/.test(src[i] ?? "")) i++; push("real", start, i); continue; }
      push("int", start, i);
      continue;
    }
    if (c === "$" && /[0-9a-fA-F]/.test(src[i + 1] ?? "")) { i++; while (/[0-9a-fA-F]/.test(src[i] ?? "")) i++; push("int", start, i); continue; }
    const two = src.slice(i, i + 2);
    if (["==", "!=", "<=", ">="].includes(two)) { push("op", i, i + 2); i += 2; continue; }
    if ("+-*/<>=(),[]".includes(c)) { push("op", i, i + 1); i++; continue; }
    diags.push({ from: i, to: i + 1, message: `Unexpected character "${c}"`, severity: "error" });
    i++;
  }
  push("eof", src.length, src.length);
  return toks;
}

// ---- parser and checker -------------------------------------------------------------
class SyntaxError extends Error { constructor(public tok: Tok, msg: string) { super(msg); } }

interface Local { type: string; array: boolean }

class Checker {
  private toks: Tok[];
  private p = 0;
  readonly diags: Diagnostic[] = [];
  /** What this source declares (merged into an environment by envFrom). */
  readonly declared: JassEnv = emptyEnv();
  private locals = new Map<string, Local>();
  private fn: { name: string; returns: string } | null = null;
  /** Loops around the current statement (exitwhen needs one). */
  private loops = 0;
  /** Functions this source defines, by name → position, for "declared later" checks. */
  private defined = new Map<string, number>();

  constructor(src: string, private env: JassEnv, private opts: { semantic: boolean; ordered: boolean }) {
    this.toks = lex(src, this.diags);
    if (opts.ordered) this.prescan();
  }

  // -- token helpers
  private get t() { return this.toks[this.p]; }
  private next() { return this.toks[this.p++]; }
  private is(text: string) { const t = this.t; return (t.kind === "kw" || t.kind === "op") && t.text === text; }
  private accept(text: string) { if (this.is(text)) { this.p++; return true; } return false; }
  private expect(text: string, what = `"${text}"`) {
    if (!this.accept(text)) throw new SyntaxError(this.t, `Expected ${what}${this.t.kind === "eof" ? "" : `, found "${this.t.text || "end of line"}"`}`);
  }
  private ident(what: string): Tok {
    if (this.t.kind !== "id") throw new SyntaxError(this.t, `Expected ${what}${this.t.kind === "nl" ? " before the end of the line" : `, found "${this.t.text}"`}`);
    return this.next();
  }
  private endLine() {
    if (this.t.kind !== "nl" && this.t.kind !== "eof") throw new SyntaxError(this.t, `Unexpected "${this.t.text}"`);
    while (this.t.kind === "nl") this.p++;
  }
  private skipLine() { while (this.t.kind !== "nl" && this.t.kind !== "eof") this.p++; while (this.t.kind === "nl") this.p++; }
  private err(from: number, to: number, message: string, severity: Diagnostic["severity"] = "error") {
    if (this.opts.semantic) this.diags.push({ from, to, message, severity });
  }

  /** Function names this source defines (for use-before-declaration). */
  private prescan() {
    for (let k = 0; k < this.toks.length - 1; k++) {
      const a = this.toks[k];
      if (a.kind === "kw" && (a.text === "function" || a.text === "native") && this.toks[k + 1].kind === "id"
        && (k === 0 || this.toks[k - 1].kind === "nl" || this.toks[k - 1].text === "constant")) this.defined.set(this.toks[k + 1].text, this.toks[k + 1].from);
    }
  }

  // -- environment lookups (own declarations first)
  private typeParent(t: string) { return this.declared.types.get(t) ?? this.env.types.get(t); }
  private isType(t: string) { return this.typeParent(t) !== undefined; }
  private func(name: string) { return this.declared.functions.get(name) ?? this.env.functions.get(name); }
  private global(name: string) { return this.declared.globals.get(name) ?? this.env.globals.get(name); }
  private variable(name: string): (Local & { constant?: boolean }) | GlobalVar | undefined { return this.locals.get(name) ?? this.global(name); }

  /** Whether a value of type `from` can go where `to` is expected. */
  private assignable(from: string, to: string): boolean {
    if (from === "?" || to === "?" || from === to) return true;
    if (from === "integer" && to === "real") return true;
    if (from === "null") return to === "string" || to === "code" || this.isHandle(to);
    for (let t: string | undefined = from; t; t = this.typeParent(t)) if (t === to) return true;
    return false;
  }
  private isHandle(t: string): boolean {
    for (let x: string | undefined = t; x; x = this.typeParent(x)) if (x === "handle") return true;
    return false;
  }

  run() {
    while (this.t.kind === "nl") this.p++;
    while (this.t.kind !== "eof") {
      try {
        this.topLevel();
      } catch (e) {
        if (!(e instanceof SyntaxError)) throw e;
        this.diags.push({ from: e.tok.from, to: Math.max(e.tok.to, e.tok.from + 1), message: e.message, severity: "error" });
        this.recoverTop();
      }
    }
  }
  /** After a syntax error: continue at the next line, or after the function if inside one. */
  private recoverTop() {
    this.skipLine();
    if (this.fn) {
      try { this.body(); } catch { /* resynchronised below */ }
    }
  }

  private topLevel() {
    if (this.accept("type")) {
      const name = this.ident("a type name");
      this.expect("extends");
      const parent = this.ident("the parent type");
      if (!this.isType(parent.text)) this.err(parent.from, parent.to, `Unknown type ${parent.text}`);
      this.declared.types.set(name.text, parent.text);
      this.endLine();
      return;
    }
    if (this.accept("globals")) { this.endLine(); this.globals(); return; }
    const constant = this.accept("constant");
    if (this.accept("native")) {
      const name = this.ident("a function name");
      this.declared.functions.set(name.text, { ...this.signature(), native: true, constant });
      this.endLine();
      return;
    }
    if (this.accept("function")) { this.functionDef(constant); return; }
    throw new SyntaxError(this.t, this.t.kind === "id" && this.is("(") ? "Code must be inside a function" : `Expected a function, globals or type, found "${this.t.text || "end of line"}"`);
  }

  private signature(): { params: { name: string; type: string }[]; returns: string } {
    this.expect("takes");
    const params: { name: string; type: string }[] = [];
    if (!this.accept("nothing")) {
      do {
        const type = this.typeName();
        params.push({ type, name: this.ident("a parameter name").text });
      } while (this.accept(","));
    }
    this.expect("returns");
    const returns = this.accept("nothing") ? "nothing" : this.typeName();
    return { params, returns };
  }
  private typeName(): string {
    const t = this.t;
    if (t.kind === "kw" && t.text === "nothing") throw new SyntaxError(t, "\"nothing\" isn't a type here");
    const id = this.ident("a type");
    if (!this.isType(id.text)) this.err(id.from, id.to, `Unknown type ${id.text}`);
    return id.text;
  }

  private globals() {
    while (!this.is("endglobals")) {
      if (this.t.kind === "eof") throw new SyntaxError(this.t, "Missing endglobals");
      try {
        const constant = this.accept("constant");
        const type = this.typeName();
        const array = this.accept("array");
        const name = this.ident("a variable name");
        if (this.accept("=")) {
          if (array) this.err(name.from, name.to, "Arrays can't have an initial value");
          const v = this.expr();
          if (!this.assignable(v, type)) this.err(name.from, name.to, `${name.text} is ${type}, the value is ${v}`);
        } else if (constant) this.err(name.from, name.to, "Constants need a value");
        this.declared.globals.set(name.text, { type, array, constant });
        this.endLine();
      } catch (e) {
        if (!(e instanceof SyntaxError)) throw e;
        this.diags.push({ from: e.tok.from, to: Math.max(e.tok.to, e.tok.from + 1), message: e.message, severity: "error" });
        this.skipLine();
      }
    }
    this.next();
    this.endLine();
  }

  private functionDef(constant: boolean) {
    const name = this.ident("a function name");
    const sig = this.signature();
    if (this.opts.semantic && (this.declared.functions.has(name.text))) this.err(name.from, name.to, `${name.text} is already defined`);
    this.declared.functions.set(name.text, { ...sig, native: false, constant });
    this.endLine();
    this.locals = new Map(sig.params.map((p) => [p.name, { type: p.type, array: false }]));
    this.fn = { name: name.text, returns: sig.returns };
    try {
      this.body();
    } finally {
      this.fn = null;
      this.locals = new Map();
    }
  }

  /** Locals, then statements, up to endfunction. */
  private body() {
    let statements = false;
    while (!this.accept("endfunction")) {
      if (this.t.kind === "eof") throw new SyntaxError(this.t, `Missing endfunction for ${this.fn?.name ?? "the function"}`);
      if (this.is("function") || this.is("globals") || this.is("native")) throw new SyntaxError(this.t, `Missing endfunction for ${this.fn?.name ?? "the function"}`);
      try {
        if (this.is("local")) {
          if (statements) this.err(this.t.from, this.t.to, "Locals must come before the function's statements");
          this.local();
        } else {
          statements = true;
          this.statement();
        }
      } catch (e) {
        if (!(e instanceof SyntaxError)) throw e;
        this.diags.push({ from: e.tok.from, to: Math.max(e.tok.to, e.tok.from + 1), message: e.message, severity: "error" });
        this.skipLine();
      }
    }
    this.endLine();
  }

  private local() {
    this.next();
    const type = this.typeName();
    const array = this.accept("array");
    const name = this.ident("a variable name");
    if (this.locals.has(name.text)) this.err(name.from, name.to, `${name.text} is already declared in this function`);
    if (this.accept("=")) {
      if (array) this.err(name.from, name.to, "Arrays can't have an initial value");
      const v = this.expr();
      if (!this.assignable(v, type)) this.err(name.from, name.to, `${name.text} is ${type}, the value is ${v}`);
    }
    this.locals.set(name.text, { type, array });
    this.endLine();
  }

  /** One statement. */
  private statement() {
    this.accept("debug");
    const t = this.t;
    if (this.accept("set")) {
      const name = this.ident("a variable");
      const v = this.variable(name.text);
      let type = "?";
      if (!v) this.err(name.from, name.to, `Unknown variable ${name.text}`);
      else {
        type = v.type;
        if ("constant" in v && v.constant) this.err(name.from, name.to, `${name.text} is a constant`);
      }
      if (this.accept("[")) {
        const i = this.expr();
        if (!this.assignable(i, "integer")) this.err(name.from, name.to, `Array index must be integer, not ${i}`);
        this.expect("]");
        if (v && !v.array) this.err(name.from, name.to, `${name.text} isn't an array`);
      } else if (v?.array) this.err(name.from, name.to, `${name.text} is an array: set ${name.text}[index] = …`);
      this.expect("=");
      const e = this.expr();
      if (!this.assignable(e, type)) this.err(name.from, this.toks[this.p - 1].to, `${name.text} is ${type}, the value is ${e}`);
      this.endLine();
      return;
    }
    if (this.accept("call")) {
      const name = this.ident("a function");
      this.expect("(");
      this.callArgs(name);
      this.endLine();
      return;
    }
    if (this.accept("if")) {
      this.condition();
      this.expect("then");
      this.endLine();
      for (;;) {
        this.block(["elseif", "else", "endif"]);
        if (this.accept("elseif")) { this.condition(); this.expect("then"); this.endLine(); continue; }
        if (this.accept("else")) { this.endLine(); this.block(["endif"]); }
        this.expect("endif");
        this.endLine();
        return;
      }
    }
    if (this.accept("loop")) {
      this.endLine();
      this.loops++;
      try { this.block(["endloop"]); } finally { this.loops--; }
      this.expect("endloop");
      this.endLine();
      return;
    }
    if (this.accept("exitwhen")) {
      if (!this.loops) this.err(t.from, t.to, "exitwhen outside a loop");
      this.condition();
      this.endLine();
      return;
    }
    if (this.accept("return")) {
      const returns = this.fn?.returns ?? "nothing";
      if (this.t.kind === "nl" || this.t.kind === "eof") {
        if (returns !== "nothing") this.err(t.from, t.to, `${this.fn?.name} returns ${returns}: return a value`);
      } else {
        const v = this.expr();
        if (returns === "nothing") this.err(t.from, t.to, `${this.fn?.name} returns nothing`);
        else if (!this.assignable(v, returns)) this.err(t.from, this.toks[this.p - 1].to, `${this.fn?.name} returns ${returns}, not ${v}`);
      }
      this.endLine();
      return;
    }
    if (this.is("local")) throw new SyntaxError(t, "Locals must come before the function's statements");
    if (t.kind === "id" && this.toks[this.p + 1]?.text === "(") throw new SyntaxError(t, `Function calls start with "call": call ${t.text}(…)`);
    if (t.kind === "id" && (this.toks[this.p + 1]?.text === "=" || this.toks[this.p + 1]?.text === "[")) throw new SyntaxError(t, `Assignments start with "set": set ${t.text} = …`);
    throw new SyntaxError(t, `Expected a statement, found "${t.text || "end of line"}"`);
  }

  /** Statements until one of `ends` (not consumed). */
  private block(ends: string[]) {
    while (!ends.some((e) => this.is(e))) {
      if (this.t.kind === "eof" || this.is("endfunction")) throw new SyntaxError(this.t, `Missing ${ends[ends.length - 1]}`);
      try {
        this.statement();
      } catch (e) {
        const atEnd = (this.t.kind as TokKind) === "eof" || this.is("endfunction");
        if (!(e instanceof SyntaxError) || atEnd) throw e;
        this.diags.push({ from: e.tok.from, to: Math.max(e.tok.to, e.tok.from + 1), message: e.message, severity: "error" });
        this.skipLine();
      }
    }
  }

  private condition() {
    const s = this.t.from;
    const c = this.expr();
    if (!this.assignable(c, "boolean")) this.err(s, this.toks[this.p - 1].to, `Condition must be boolean, not ${c}`);
  }

  /** Arguments of a call to `name` (after the "("), checked against its signature. */
  private callArgs(name: Tok): string {
    const f = this.func(name.text);
    if (!f) {
      if (this.defined.has(name.text)) this.err(name.from, name.to, `${name.text} is defined further down: functions must come before their use`);
      else if (this.locals.has(name.text) || this.global(name.text)) this.err(name.from, name.to, `${name.text} is a variable, not a function`);
      else this.err(name.from, name.to, `Unknown function ${name.text}`);
    } else if (this.opts.ordered && !this.declared.functions.has(name.text) && this.defined.has(name.text)) {
      this.err(name.from, name.to, `${name.text} is defined further down: functions must come before their use`);
    }
    const args: { type: string; from: number; to: number }[] = [];
    if (!this.accept(")")) {
      do {
        const from = this.t.from;
        const type = this.expr();
        args.push({ type, from, to: this.toks[this.p - 1].to });
      } while (this.accept(","));
      this.expect(")");
    }
    if (f) {
      if (args.length !== f.params.length) this.err(name.from, this.toks[this.p - 1].to, `${name.text} takes ${f.params.length} argument${f.params.length === 1 ? "" : "s"}, not ${args.length}`);
      else args.forEach((a, k) => {
        if (!this.assignable(a.type, f.params[k].type)) this.err(a.from, a.to, `Argument ${k + 1} of ${name.text} (${f.params[k].name}) is ${f.params[k].type}, not ${a.type}`);
      });
    }
    return f?.returns ?? "?";
  }

  // -- expressions (precedence: or < and < not < comparison < + - < * / < unary)
  private expr(): string { return this.or(); }
  private or(): string {
    let a = this.and();
    while (this.is("or")) { const op = this.next(); const b = this.and(); this.boolOp(op, a, b); a = "boolean"; }
    return a;
  }
  private and(): string {
    let a = this.not();
    while (this.is("and")) { const op = this.next(); const b = this.not(); this.boolOp(op, a, b); a = "boolean"; }
    return a;
  }
  private boolOp(op: Tok, a: string, b: string) {
    if (!this.assignable(a, "boolean") || !this.assignable(b, "boolean")) this.err(op.from, op.to, `"${op.text}" needs boolean values, not ${a} and ${b}`);
  }
  private not(): string {
    if (this.is("not")) {
      const op = this.next();
      const a = this.not();
      if (!this.assignable(a, "boolean")) this.err(op.from, op.to, `"not" needs a boolean, not ${a}`);
      return "boolean";
    }
    return this.compare();
  }
  private compare(): string {
    const a = this.sum();
    if (["==", "!=", "<", ">", "<=", ">="].some((o) => this.is(o))) {
      const op = this.next();
      const b = this.sum();
      if (op.text === "==" || op.text === "!=") {
        if (!this.assignable(a, b) && !this.assignable(b, a)) this.err(op.from, op.to, `Can't compare ${a} with ${b}`);
      } else if (!this.numeric(a) || !this.numeric(b)) this.err(op.from, op.to, `"${op.text}" compares numbers, not ${a} and ${b}`);
      return "boolean";
    }
    return a;
  }
  private numeric(t: string) { return t === "?" || t === "integer" || t === "real"; }
  private sum(): string {
    let a = this.product();
    while (this.is("+") || this.is("-")) {
      const op = this.next();
      const b = this.product();
      if (op.text === "+" && (a === "string" || b === "string")) {
        if (!this.assignable(a, "string") || !this.assignable(b, "string")) this.err(op.from, op.to, `Can't add ${a} and ${b}`);
        a = "string";
      } else a = this.arith(op, a, b);
    }
    return a;
  }
  private product(): string {
    let a = this.unary();
    while (this.is("*") || this.is("/")) { const op = this.next(); a = this.arith(op, a, this.unary()); }
    return a;
  }
  private arith(op: Tok, a: string, b: string): string {
    if (!this.numeric(a) || !this.numeric(b)) { this.err(op.from, op.to, `"${op.text}" needs numbers, not ${a} and ${b}`); return "?"; }
    return a === "?" || b === "?" ? "?" : a === "real" || b === "real" ? "real" : "integer";
  }
  private unary(): string {
    if (this.is("-") || this.is("+")) {
      const op = this.next();
      const a = this.unary();
      if (!this.numeric(a)) this.err(op.from, op.to, `"${op.text}" needs a number, not ${a}`);
      return a;
    }
    return this.primary();
  }
  private primary(): string {
    const t = this.t;
    if (t.kind === "int") { this.p++; return "integer"; }
    if (t.kind === "real") { this.p++; return "real"; }
    if (t.kind === "str") { this.p++; return "string"; }
    if (this.accept("true") || this.accept("false")) return "boolean";
    if (this.accept("null")) return "null";
    if (this.accept("(")) { const v = this.expr(); this.expect(")"); return v; }
    if (this.accept("function")) {
      const name = this.ident("a function name");
      const f = this.func(name.text);
      if (!f) this.err(name.from, name.to, this.defined.has(name.text) ? `${name.text} is defined further down: functions must come before their use` : `Unknown function ${name.text}`);
      else if (f.params.length) this.err(name.from, name.to, `${name.text} takes arguments: only functions that take nothing can be used as code`);
      else if (this.opts.ordered && !this.declared.functions.has(name.text) && this.defined.has(name.text)) {
        this.err(name.from, name.to, `${name.text} is defined further down: functions must come before their use`);
      }
      return "code";
    }
    if (t.kind === "id") {
      this.p++;
      if (this.accept("(")) return this.callArgs(t);
      const v = this.variable(t.text);
      if (!v) {
        this.err(t.from, t.to, this.func(t.text) ? `${t.text} is a function: use ${t.text}(…) or function ${t.text}` : `Unknown variable ${t.text}`);
        if (this.accept("[")) { this.expr(); this.expect("]"); }
        return "?";
      }
      if (this.accept("[")) {
        const i = this.expr();
        if (!this.assignable(i, "integer")) this.err(t.from, t.to, `Array index must be integer, not ${i}`);
        this.expect("]");
        if (!v.array) this.err(t.from, t.to, `${t.text} isn't an array`);
      } else if (v.array) this.err(t.from, t.to, `${t.text} is an array: ${t.text}[index]`);
      return v.type;
    }
    throw new SyntaxError(t, t.kind === "nl" || t.kind === "eof" ? "Expected a value before the end of the line" : `Expected a value, found "${t.text}"`);
  }
}

/** Declarations of `sources` (in order) merged into one environment; syntax errors are ignored. */
export function envFrom(sources: string[], base: JassEnv = emptyEnv()): JassEnv {
  const env: JassEnv = { types: new Map(base.types), globals: new Map(base.globals), functions: new Map(base.functions) };
  for (const src of sources) {
    const c = new Checker(src, env, { semantic: false, ordered: false });
    c.run();
    for (const [k, v] of c.declared.types) env.types.set(k, v);
    for (const [k, v] of c.declared.globals) env.globals.set(k, v);
    for (const [k, v] of c.declared.functions) env.functions.set(k, v);
  }
  return env;
}

/** Checks `src` against `env`. `ordered`: the source is a whole script, whose own functions must
 *  be defined before use (off for fragments such as one trigger's custom text). */
export function checkJass(src: string, env: JassEnv, opts: { ordered?: boolean } = {}): Diagnostic[] {
  const c = new Checker(src, env, { semantic: true, ordered: opts.ordered ?? true });
  c.run();
  return c.diags;
}

/** `env` without the declarations `src` makes itself (so checking it doesn't find them twice). */
export function envWithout(env: JassEnv, src: string): JassEnv {
  const own = envFrom([src]);
  const out: JassEnv = { types: new Map(env.types), globals: new Map(env.globals), functions: new Map(env.functions) };
  for (const k of own.functions.keys()) out.functions.delete(k);
  for (const k of own.globals.keys()) out.globals.delete(k);
  return out;
}
