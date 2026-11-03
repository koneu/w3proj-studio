//! The game's `UI\TriggerData.txt`, as far as reading `war3map.wtg` needs it: how many
//! arguments each GUI function takes (the file stores parameters without a count).
//!
//! `[TriggerEvents]` / `[TriggerConditions]` / `[TriggerActions]`: `Name=version,argType,…`;
//! `[TriggerCalls]`: `Name=version,usableInEvents,returnType,argType,…`. "nothing" is no
//! argument; `_Name_…` lines are display data.

use std::collections::HashMap;

const SECTIONS: [&str; 4] = ["TriggerEvents", "TriggerConditions", "TriggerActions", "TriggerCalls"];

pub struct TriggerData {
    /// Per kind (0 event, 1 condition, 2 action, 3 call): name → argument count.
    args: [HashMap<String, usize>; 4],
}

/// Splits a comma list, keeping quoted parts (which may contain commas) whole.
fn split_list(v: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let (mut start, mut quoted) = (0, false);
    for (i, c) in v.char_indices() {
        match c {
            '"' => quoted = !quoted,
            ',' if !quoted => {
                out.push(v[start..i].trim());
                start = i + 1;
            }
            _ => {}
        }
    }
    out.push(v[start..].trim());
    out
}

impl TriggerData {
    pub fn parse(text: &str) -> TriggerData {
        let mut args: [HashMap<String, usize>; 4] = Default::default();
        let mut section: Option<usize> = None;
        for raw in text.lines() {
            let line = raw.trim();
            if let Some(rest) = line.strip_prefix('[') {
                let name = rest.split(']').next().unwrap_or("");
                section = SECTIONS.iter().position(|s| *s == name);
                continue;
            }
            let Some(kind) = section else { continue };
            if line.is_empty() || line.starts_with("//") || line.starts_with('_') {
                continue;
            }
            let Some((key, value)) = line.split_once('=') else { continue };
            if key.is_empty() {
                continue;
            }
            let vals = split_list(value);
            let skip = if kind == 3 { 3 } else { 1 };
            let n = vals.iter().skip(skip).filter(|a| !a.is_empty() && **a != "nothing").count();
            args[kind].insert(key.to_string(), n);
        }
        TriggerData { args }
    }

    /// Argument count of a function; a call stored with a kind that doesn't list it is looked up
    /// in the other kinds too.
    pub fn arg_count(&self, kind: u32, name: &str) -> Option<usize> {
        self.args
            .get(kind as usize)
            .and_then(|m| m.get(name))
            .or_else(|| self.args.iter().find_map(|m| m.get(name)))
            .copied()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts() {
        let d = TriggerData::parse(
            "[TriggerActions]\n_Foo_Category=TC_X\nFoo=0,unit,\"a,b\",nothing\nBar=0,nothing\n[TriggerCalls]\nGetX=0,1,real,location\n[Other]\nZ=1,2",
        );
        assert_eq!(d.arg_count(2, "Foo"), Some(2));
        assert_eq!(d.arg_count(2, "Bar"), Some(0));
        assert_eq!(d.arg_count(3, "GetX"), Some(1));
        assert_eq!(d.arg_count(2, "GetX"), Some(1));
        assert_eq!(d.arg_count(2, "Z"), None);
    }
}
