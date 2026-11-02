// Mass editing and filtering of placed objects.
//
// Expressions (for a field of every selected object):
//   numbers, + - * / % ( ), and the variables
//     v (or the field's own name: x, y, z, facing, scale, variation, owner) the
//     current value; i the object's index in the selection; n the count;
//     x, y, z, facing, scale of the same object
//   functions: random(a, b) / random(a..b), randint(a, b), round, floor, ceil,
//     abs, min, max, sin, cos (degrees), sqrt; constant pi.
//   Examples: "x+64", "random(1..1.2)", "v*2", "i*90", "randint(0, 9)".
//
// Filters (select all matching objects): space-separated conditions, all of
// which must hold: field op value, with op one of = != < > <= >= and ":"
// (contains, for text). Fields: id, kind (unit, item, destructable, doodad),
// owner (Player 1 = 1 … 24, neutral 25–28), name, x, y, z, facing, scale,
// variation. Example: "kind=unit owner=1", "name:tree scale>1.1".

export interface ObjVars { x: number; y: number; z: number; facing: number; scale: number; variation: number; owner: number }

type Tok = { t: "num"; v: number } | { t: "id"; v: string } | { t: "op"; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (src.startsWith("..", i)) { out.push({ t: "op", v: "," }); i += 2; continue; }
    if (/[0-9.]/.test(c)) {
      // A dot followed by another dot is the range "..", not a decimal point.
      const m = /^(\d+(?:\.(?!\.)\d*)?|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i))!;
      if (!m) throw new Error(`unexpected "${c}"`);
      out.push({ t: "num", v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[a-z_]/i.test(c)) {
      const m = /^[a-z_][a-z0-9_]*/i.exec(src.slice(i))!;
      out.push({ t: "id", v: m[0].toLowerCase() });
      i += m[0].length;
      continue;
    }
    if ("+-*/%(),".includes(c)) { out.push({ t: "op", v: c }); i++; continue; }
    throw new Error(`unexpected "${c}"`);
  }
  return out;
}

type Node = (env: Record<string, number>, rnd: () => number) => number;

const FUNCS: Record<string, (rnd: () => number, ...a: number[]) => number> = {
  random: (r, a = 0, b = 1) => a + r() * (b - a),
  randint: (r, a = 0, b = 1) => Math.floor(Math.min(a, b) + r() * (Math.abs(b - a) + 1)),
  round: (_, a, s = 1) => Math.round(a / s) * s,
  floor: (_, a) => Math.floor(a),
  ceil: (_, a) => Math.ceil(a),
  abs: (_, a) => Math.abs(a),
  min: (_, ...a) => Math.min(...a),
  max: (_, ...a) => Math.max(...a),
  sin: (_, a) => Math.sin((a * Math.PI) / 180),
  cos: (_, a) => Math.cos((a * Math.PI) / 180),
  sqrt: (_, a) => Math.sqrt(a),
};

/** Parses an expression; throws with a readable message when invalid. */
export function compileExpr(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek()?.t === "op" && peek()!.v === v;
  const expect = (v: string) => { if (!isOp(v)) throw new Error(`expected "${v}"`); p++; };
  const expr = (): Node => {
    let left = term();
    while (isOp("+") || isOp("-")) {
      const op = (toks[p++] as { v: string }).v, l = left, r = term();
      left = op === "+" ? (e, x) => l(e, x) + r(e, x) : (e, x) => l(e, x) - r(e, x);
    }
    return left;
  };
  const term = (): Node => {
    let left = unary();
    while (isOp("*") || isOp("/") || isOp("%")) {
      const op = (toks[p++] as { v: string }).v, l = left, r = unary();
      left = op === "*" ? (e, x) => l(e, x) * r(e, x) : op === "/" ? (e, x) => l(e, x) / r(e, x) : (e, x) => l(e, x) % r(e, x);
    }
    return left;
  };
  const unary = (): Node => {
    if (isOp("-")) { p++; const a = unary(); return (e, x) => -a(e, x); }
    if (isOp("+")) { p++; return unary(); }
    return atom();
  };
  const atom = (): Node => {
    const t = toks[p++];
    if (!t) throw new Error("unexpected end");
    if (t.t === "num") { const v = t.v; return () => v; }
    if (t.t === "op" && t.v === "(") { const a = expr(); expect(")"); return a; }
    if (t.t === "id") {
      if (isOp("(")) {
        const f = FUNCS[t.v];
        if (!f) throw new Error(`unknown function ${t.v}`);
        p++;
        const args: Node[] = [];
        if (!isOp(")")) { args.push(expr()); while (isOp(",")) { p++; args.push(expr()); } }
        expect(")");
        return (e, r) => f(r, ...args.map((a) => a(e, r)));
      }
      if (t.v === "pi") return () => Math.PI;
      const name = t.v;
      return (e) => {
        if (!(name in e)) throw new Error(`unknown name ${name}`);
        return e[name];
      };
    }
    throw new Error(`unexpected "${t.v}"`);
  };
  const root = expr();
  if (p < toks.length) throw new Error(`unexpected "${(toks[p] as { v: unknown }).v}"`);
  // Validate names once with a dummy environment.
  root({ v: 0, i: 0, n: 1, x: 0, y: 0, z: 0, facing: 0, scale: 1, variation: 0, owner: 1 }, () => 0.5);
  return root;
}

/** Evaluates `src` for object `index` of `count`, field current value `v`. */
export function evalFor(node: Node, vars: ObjVars, v: number, index: number, count: number, rnd: () => number = Math.random): number {
  return node({ ...vars, v, i: index, n: count }, rnd);
}

// ---- filters --------------------------------------------------------------------------

export interface FilterTarget extends ObjVars { id: string; kind: string; name: string }

const KIND_NAMES: Record<string, string> = { unit: "w3u", units: "w3u", item: "w3t", items: "w3t", destructable: "w3b", destructables: "w3b", doodad: "w3d", doodads: "w3d" };
const COND = /^([a-z]+)(<=|>=|!=|=|<|>|:)(.*)$/i;

/** Parses a filter; throws with a readable message when invalid. */
export function compileFilter(src: string): (o: FilterTarget) => boolean {
  const conds = src.trim().split(/\s+/).filter(Boolean).map((tok) => {
    const m = COND.exec(tok);
    if (!m) throw new Error(`"${tok}" isn't a condition (e.g. owner=1, name:tree, scale>1)`);
    const field = m[1].toLowerCase(), op = m[2], raw = m[3].replace(/_/g, " ");
    const textual = field === "id" || field === "kind" || field === "name";
    if (!textual && !["x", "y", "z", "facing", "scale", "variation", "owner"].includes(field)) throw new Error(`unknown field "${field}"`);
    if (!textual && (op === ":" || !Number.isFinite(Number(raw)))) throw new Error(`${field} needs a number (${tok})`);
    const want = field === "kind" ? KIND_NAMES[raw.toLowerCase()] ?? raw.toLowerCase() : raw.toLowerCase();
    return (o: FilterTarget) => {
      if (textual) {
        const have = (field === "id" ? o.id : field === "kind" ? o.kind : o.name).toLowerCase();
        return op === ":" ? have.includes(want) : op === "!=" ? have !== want : op === "=" ? have === want : false;
      }
      const a = o[field as keyof ObjVars], b = Number(raw);
      switch (op) {
        case "=": return Math.abs(a - b) < 1e-6;
        case "!=": return Math.abs(a - b) >= 1e-6;
        case "<": return a < b;
        case ">": return a > b;
        case "<=": return a <= b;
        default: return a >= b;
      }
    };
  });
  return (o) => conds.every((c) => c(o));
}
