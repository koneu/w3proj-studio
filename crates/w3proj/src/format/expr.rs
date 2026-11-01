//! Tiny expression language for format definitions: conditions (`version >= 39`),
//! counts (`len(positions)`, `width * height`) and checks (`value <= 1`).
//!
//! Grammar (lowest to highest precedence):
//! `||` · `&&` · `== != < <= > >=` · `+ -` · `* / %` · `&` · unary `! -` · atoms
//! Atoms: numbers (`39`, `0x2000`, `1.5`), `true`/`false`, identifiers (looked
//! up in the scope), `len(name)`, `abs(expr)`, parentheses.

use crate::{Error, Result};

#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    Num(f64),
    Bool(bool),
    Var(String),
    Len(String),
    Abs(Box<Expr>),
    Not(Box<Expr>),
    Neg(Box<Expr>),
    Bin(Op, Box<Expr>, Box<Expr>),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Op {
    Or,
    And,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    Add,
    Sub,
    Mul,
    Div,
    Rem,
    BitAnd,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Val {
    Num(f64),
    Bool(bool),
}

impl Val {
    pub fn truthy(self) -> bool {
        match self {
            Val::Bool(b) => b,
            Val::Num(n) => n != 0.0,
        }
    }
    pub fn num(self) -> f64 {
        match self {
            Val::Num(n) => n,
            Val::Bool(b) => b as u8 as f64,
        }
    }
}

/// What expressions can see: field values (by name) and list lengths.
pub trait Scope {
    fn get(&self, name: &str) -> Option<Val>;
    fn len(&self, name: &str) -> Option<usize>;
}

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Num(f64),
    Ident(String),
    Sym(&'static str),
}

fn tokenize(src: &str) -> Result<Vec<Tok>> {
    const SYMS: &[&str] = &["||", "&&", "==", "!=", "<=", ">=", "<", ">", "+", "-", "*", "/", "%", "&", "!", "(", ")"];
    let b = src.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c.is_ascii_whitespace() {
            i += 1;
        } else if c.is_ascii_digit() || (c == b'.' && b.get(i + 1).is_some_and(u8::is_ascii_digit)) {
            let start = i;
            if src[i..].starts_with("0x") || src[i..].starts_with("0X") {
                i += 2;
                while i < b.len() && b[i].is_ascii_hexdigit() {
                    i += 1;
                }
                let v = u64::from_str_radix(&src[start + 2..i], 16).map_err(|_| bad(src, "bad hex number"))?;
                out.push(Tok::Num(v as f64));
            } else {
                while i < b.len() && (b[i].is_ascii_digit() || b[i] == b'.' || b[i] == b'e' || b[i] == b'E') {
                    i += 1;
                }
                let v: f64 = src[start..i].parse().map_err(|_| bad(src, "bad number"))?;
                out.push(Tok::Num(v));
            }
        } else if c.is_ascii_alphabetic() || c == b'_' {
            let start = i;
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_' || b[i] == b'.') {
                i += 1;
            }
            out.push(Tok::Ident(src[start..i].to_string()));
        } else if let Some(sym) = SYMS.iter().find(|s| src[i..].starts_with(**s)) {
            out.push(Tok::Sym(sym));
            i += sym.len();
        } else {
            return Err(bad(src, &format!("unexpected character {:?}", c as char)));
        }
    }
    Ok(out)
}

fn bad(src: &str, what: &str) -> Error {
    Error::Format(format!("expression {src:?}: {what}"))
}

struct Parser<'a> {
    toks: Vec<Tok>,
    p: usize,
    src: &'a str,
}

impl Parser<'_> {
    fn peek_sym(&self) -> Option<&'static str> {
        match self.toks.get(self.p) {
            Some(Tok::Sym(s)) => Some(s),
            _ => None,
        }
    }
    fn eat(&mut self, sym: &str) -> bool {
        if self.peek_sym() == Some(sym) {
            self.p += 1;
            true
        } else {
            false
        }
    }
    fn expect(&mut self, sym: &str) -> Result<()> {
        if self.eat(sym) {
            Ok(())
        } else {
            Err(bad(self.src, &format!("expected {sym:?}")))
        }
    }

    fn binary(&mut self, level: usize) -> Result<Expr> {
        const LEVELS: &[&[(&str, Op)]] = &[
            &[("||", Op::Or)],
            &[("&&", Op::And)],
            &[("==", Op::Eq), ("!=", Op::Ne), ("<=", Op::Le), (">=", Op::Ge), ("<", Op::Lt), (">", Op::Gt)],
            &[("+", Op::Add), ("-", Op::Sub)],
            &[("*", Op::Mul), ("/", Op::Div), ("%", Op::Rem)],
            &[("&", Op::BitAnd)],
        ];
        if level == LEVELS.len() {
            return self.unary();
        }
        let mut lhs = self.binary(level + 1)?;
        'outer: loop {
            for (sym, op) in LEVELS[level] {
                if self.eat(sym) {
                    let rhs = self.binary(level + 1)?;
                    lhs = Expr::Bin(*op, Box::new(lhs), Box::new(rhs));
                    continue 'outer;
                }
            }
            return Ok(lhs);
        }
    }

    fn unary(&mut self) -> Result<Expr> {
        if self.eat("!") {
            return Ok(Expr::Not(Box::new(self.unary()?)));
        }
        if self.eat("-") {
            return Ok(Expr::Neg(Box::new(self.unary()?)));
        }
        if self.eat("(") {
            let e = self.binary(0)?;
            self.expect(")")?;
            return Ok(e);
        }
        match self.toks.get(self.p).cloned() {
            Some(Tok::Num(n)) => {
                self.p += 1;
                Ok(Expr::Num(n))
            }
            Some(Tok::Ident(name)) => {
                self.p += 1;
                match name.as_str() {
                    "true" => Ok(Expr::Bool(true)),
                    "false" => Ok(Expr::Bool(false)),
                    "len" => {
                        self.expect("(")?;
                        let Some(Tok::Ident(arg)) = self.toks.get(self.p).cloned() else {
                            return Err(bad(self.src, "len() takes a field name"));
                        };
                        self.p += 1;
                        self.expect(")")?;
                        Ok(Expr::Len(arg))
                    }
                    "abs" => {
                        self.expect("(")?;
                        let e = self.binary(0)?;
                        self.expect(")")?;
                        Ok(Expr::Abs(Box::new(e)))
                    }
                    _ => Ok(Expr::Var(name)),
                }
            }
            _ => Err(bad(self.src, "unexpected end")),
        }
    }
}

pub fn parse(src: &str) -> Result<Expr> {
    let mut p = Parser { toks: tokenize(src)?, p: 0, src };
    let e = p.binary(0)?;
    if p.p != p.toks.len() {
        return Err(bad(src, "trailing tokens"));
    }
    Ok(e)
}

impl Expr {
    pub fn eval(&self, scope: &dyn Scope) -> Result<Val> {
        Ok(match self {
            Expr::Num(n) => Val::Num(*n),
            Expr::Bool(b) => Val::Bool(*b),
            Expr::Var(name) => scope
                .get(name)
                .ok_or_else(|| Error::Format(format!("unknown name {name:?} in expression")))?,
            Expr::Len(name) => Val::Num(
                scope
                    .len(name)
                    .ok_or_else(|| Error::Format(format!("len({name}): no such list")))? as f64,
            ),
            Expr::Abs(e) => Val::Num(e.eval(scope)?.num().abs()),
            Expr::Not(e) => Val::Bool(!e.eval(scope)?.truthy()),
            Expr::Neg(e) => Val::Num(-e.eval(scope)?.num()),
            Expr::Bin(op, a, b) => {
                // Short-circuit so `version >= 39 && newField == 1` is safe on old files.
                if *op == Op::And {
                    return Ok(Val::Bool(a.eval(scope)?.truthy() && b.eval(scope)?.truthy()));
                }
                if *op == Op::Or {
                    return Ok(Val::Bool(a.eval(scope)?.truthy() || b.eval(scope)?.truthy()));
                }
                let (x, y) = (a.eval(scope)?.num(), b.eval(scope)?.num());
                match op {
                    Op::Eq => Val::Bool(x == y),
                    Op::Ne => Val::Bool(x != y),
                    Op::Lt => Val::Bool(x < y),
                    Op::Le => Val::Bool(x <= y),
                    Op::Gt => Val::Bool(x > y),
                    Op::Ge => Val::Bool(x >= y),
                    Op::Add => Val::Num(x + y),
                    Op::Sub => Val::Num(x - y),
                    Op::Mul => Val::Num(x * y),
                    Op::Div => Val::Num(x / y),
                    Op::Rem => Val::Num(x % y),
                    Op::BitAnd => Val::Num(((x as i64 as u64) & (y as i64 as u64)) as f64),
                    Op::And | Op::Or => unreachable!(),
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct S(HashMap<&'static str, f64>);
    impl Scope for S {
        fn get(&self, n: &str) -> Option<Val> {
            self.0.get(n).map(|v| Val::Num(*v))
        }
        fn len(&self, n: &str) -> Option<usize> {
            (n == "positions").then_some(3)
        }
    }

    fn ev(src: &str) -> Val {
        let s = S(HashMap::from([("version", 39.0), ("editorVersion", 6127.0), ("flags", 0x2004 as f64)]));
        parse(src).unwrap().eval(&s).unwrap()
    }

    #[test]
    fn expressions() {
        assert_eq!(ev("version >= 39"), Val::Bool(true));
        assert_eq!(ev("version >= 39 && editorVersion >= 6128"), Val::Bool(false));
        assert_eq!(ev("!(version < 31) || nope"), Val::Bool(true)); // short-circuit
        assert_eq!(ev("len(positions) * 4 + 1"), Val::Num(13.0));
        assert!(ev("flags & 0x2000").truthy());
        assert_eq!(ev("abs(-5) <= 5"), Val::Bool(true));
        assert!(parse("version >=").is_err());
    }
}
