//! The game's SYLK tables (`Units\UnitData.slk` and the like) as rows of text, for `w3proj game slk`.
//!
//! A SYLK file is lines of records split by `;`. `C;X<col>;Y<row>;K<value>` sets a cell; X and Y may be left
//! out, and then the last ones count (an `F;` record can move them too). A value is a number or a quoted
//! string; a `;` inside a value is written `;;`. `E` ends the file. Everything else is skipped. The first
//! row holds the column names, the first column the row's id.

/// A table: column names (row 1), then each row's cells, in file order. Missing cells are empty.
pub struct Table {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

/// The largest table read (cells per side): the game's biggest are a few hundred columns and a few
/// thousand rows; a damaged file asking for more doesn't get a huge allocation.
const MAX_SIDE: usize = 100_000;

/// The record's fields, with `;;` taken as a `;` inside a field.
fn fields(line: &str) -> Vec<String> {
    let mut out = vec![String::new()];
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c == ';' {
            if chars.peek() == Some(&';') {
                chars.next();
                out.last_mut().unwrap().push(';');
            } else {
                out.push(String::new());
            }
        } else {
            out.last_mut().unwrap().push(c);
        }
    }
    out
}

fn value(raw: &str) -> String {
    let v = raw.strip_prefix('"').map(|s| s.strip_suffix('"').unwrap_or(s)).unwrap_or(raw);
    v.to_string()
}

/// Reads a table; text that isn't SYLK gives an empty one, never a panic.
pub fn parse(text: &str) -> Table {
    let mut cells: Vec<(usize, usize, String)> = Vec::new();
    let (mut x, mut y) = (1usize, 1usize);
    let (mut width, mut height) = (0usize, 0usize);
    for line in text.lines() {
        let f = fields(line.trim_end_matches('\r'));
        let kind = f[0].as_str();
        if kind == "E" {
            break;
        }
        if kind != "C" && kind != "F" {
            continue;
        }
        let mut k = None;
        for part in &f[1..] {
            let (tag, rest) = part.split_at(part.char_indices().nth(1).map_or(part.len(), |(i, _)| i));
            match tag {
                "X" => x = rest.parse().unwrap_or(x),
                "Y" => y = rest.parse().unwrap_or(y),
                "K" if kind == "C" => k = Some(value(rest)),
                _ => {}
            }
        }
        if let Some(k) = k {
            if (1..=MAX_SIDE).contains(&x) && (1..=MAX_SIDE).contains(&y) {
                width = width.max(x);
                height = height.max(y);
                cells.push((x, y, k));
            }
        }
    }
    let mut grid = vec![vec![String::new(); width]; height];
    for (x, y, k) in cells {
        grid[y - 1][x - 1] = k;
    }
    let mut rows = grid.into_iter();
    let columns = rows.next().unwrap_or_default();
    Table { columns, rows: rows.filter(|r| r.iter().any(|c| !c.is_empty())).collect() }
}

impl Table {
    /// The index of each named column (case-insensitive), or the names not found.
    pub fn column_indexes(&self, names: &[String]) -> Result<Vec<usize>, Vec<String>> {
        let mut found = Vec::new();
        let mut missing = Vec::new();
        for n in names {
            match self.columns.iter().position(|c| c.eq_ignore_ascii_case(n)) {
                Some(i) => found.push(i),
                None => missing.push(n.clone()),
            }
        }
        if missing.is_empty() { Ok(found) } else { Err(missing) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const UNITS: &str = "ID;PWXL;N;E\r\nB;X3;Y3;D0\r\nC;Y1;X1;K\"unitID\"\r\nC;X2;K\"movetp\"\r\nC;X3;K\"comment;;s\"\r\n\
F;Y2;X1\r\nC;K\"hbot\"\r\nC;X2;K\"float\"\r\nC;Y3;X1;K\"hfoo\"\r\nC;X2;K\"foot\"\r\nC;X3;K12.5\r\nE\r\nC;X1;Y9;K\"after the end\"\r\n";

    #[test]
    fn cells_keep_the_last_row_and_column_and_a_doubled_semicolon_is_one() {
        let t = parse(UNITS);
        assert_eq!(t.columns, ["unitID", "movetp", "comment;s"]);
        assert_eq!(t.rows, [vec!["hbot", "float", ""], vec!["hfoo", "foot", "12.5"]]);
    }

    #[test]
    fn columns_are_found_without_case() {
        let t = parse(UNITS);
        assert_eq!(t.column_indexes(&["MoveTP".into(), "unitid".into()]), Ok(vec![1, 0]));
        assert_eq!(t.column_indexes(&["nope".into()]), Err(vec!["nope".to_string()]));
    }

    #[test]
    fn text_that_isnt_sylk_or_asks_for_a_huge_table_gives_little() {
        let t = parse("hello\nC;X999999999;Y1;K1\nC;X;Y;K\nC\n;;;\n");
        assert!(t.columns.len() <= 1 && t.rows.is_empty());
        assert!(parse("").columns.is_empty());
    }
}
