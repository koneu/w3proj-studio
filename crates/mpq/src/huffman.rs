//! Storm's adaptive Huffman decoder (compression mask 0x01; older maps store WAV sounds with it,
//! after ADPCM).
//!
//! The coder keeps its tree items in one list sorted by weight (heaviest first) with a head
//! sentinel. An internal item points to its lighter child; the heavier one is the item just
//! before that child in the list. The first stream byte picks the initial weight table. The
//! symbol 0x101 brings in a byte not in the tree (the next 8 bits): the lightest leaf splits into
//! itself and the new byte. 0x100 ends the stream. Type 0 streams raise a symbol's weight after
//! every use; the others only after bringing in a new byte. Raising a weight moves the item
//! (and its subtree) in front of the lightest item that is heavier or as heavy, so the order,
//! and with it the codes, stay those of the compressor.

use crate::huffman_tables::WEIGHT_TABLES;

const HEAD: usize = 0;
const NONE: usize = usize::MAX;

#[derive(Clone, Copy)]
struct Item {
    next: usize,
    prev: usize,
    value: u32,
    weight: u32,
    parent: usize,
    child_lo: usize,
}

struct Tree {
    items: Vec<Item>,
    by_value: [usize; 0x102],
}

#[derive(Clone, Copy, PartialEq)]
enum Insert {
    /// At the front of the list (heaviest end).
    First,
    /// At the back (lightest end).
    Last,
}

impl Tree {
    fn new() -> Self {
        let head = Item { next: HEAD, prev: HEAD, value: 0, weight: 0, parent: NONE, child_lo: NONE };
        Tree { items: vec![head], by_value: [NONE; 0x102] }
    }

    fn first(&self) -> usize {
        self.items[HEAD].next
    }
    fn last(&self) -> usize {
        self.items[HEAD].prev
    }

    fn unlink(&mut self, i: usize) {
        let Item { prev, next, .. } = self.items[i];
        self.items[prev].next = next;
        self.items[next].prev = prev;
    }

    /// Puts `item` right after `after`.
    fn link_after(&mut self, after: usize, item: usize) {
        let next = self.items[after].next;
        self.items[item].next = next;
        self.items[item].prev = after;
        self.items[next].prev = item;
        self.items[after].next = item;
    }

    fn create(&mut self, value: u32, weight: u32, at: Insert) -> usize {
        let i = self.items.len();
        self.items.push(Item { next: NONE, prev: NONE, value, weight, parent: NONE, child_lo: NONE });
        match at {
            Insert::First => self.link_after(HEAD, i),
            Insert::Last => {
                let last = self.last();
                self.link_after(last, i);
            }
        }
        i
    }

    /// Walking towards the front from `from`: the first item at least as heavy as `weight`
    /// (the head if there is none).
    fn higher_or_equal(&self, mut from: usize, weight: u32) -> usize {
        while from != HEAD {
            if self.items[from].weight >= weight {
                return from;
            }
            from = self.items[from].prev;
        }
        HEAD
    }

    /// A new item (created at the front) moves behind the heavier items unless it is the
    /// heaviest so far.
    fn fixup_position(&mut self, item: usize, max_weight: u32) -> u32 {
        let weight = self.items[item].weight;
        if weight < max_weight {
            let higher = self.higher_or_equal(self.last(), weight);
            self.unlink(item);
            self.link_after(higher, item);
            max_weight
        } else {
            weight
        }
    }

    fn build(&mut self, table: &[u8; 258]) {
        let mut max_weight = 0;
        for (value, &w) in table.iter().enumerate().take(0x100) {
            if w != 0 {
                let i = self.create(value as u32, w as u32, Insert::First);
                self.by_value[value] = i;
                max_weight = self.fixup_position(i, max_weight);
            }
        }
        self.by_value[0x100] = self.create(0x100, 1, Insert::Last);
        self.by_value[0x101] = self.create(0x101, 1, Insert::Last);
        // Pair items from the light end: each pair gets a parent, placed by its weight.
        let mut lo = self.last();
        while lo != HEAD {
            let hi = self.items[lo].prev;
            if hi == HEAD {
                break;
            }
            let parent = self.create(0, self.items[hi].weight + self.items[lo].weight, Insert::First);
            self.items[lo].parent = parent;
            self.items[hi].parent = parent;
            self.items[parent].child_lo = lo;
            max_weight = self.fixup_position(parent, max_weight);
            lo = self.items[hi].prev;
        }
    }

    /// Raises the weights from `item` up to the root, swapping items that became heavier than
    /// items before them.
    fn increment(&mut self, mut item: usize) {
        while item != NONE {
            self.items[item].weight += 1;
            let weight = self.items[item].weight;
            let higher = self.higher_or_equal(self.items[item].prev, weight);
            let other = self.items[higher].next;
            if other != item {
                // `other` (the lightest item at least as heavy before) and `item` trade places.
                self.unlink(other);
                self.link_after(item, other);
                self.unlink(item);
                self.link_after(higher, item);
                // Keep each parent's child_lo pointing at its lighter child, then swap parents.
                let other_parent = self.items[other].parent;
                let item_parent = self.items[item].parent;
                if other_parent == NONE || item_parent == NONE {
                    return; // only in a malformed tree; the stream then fails to decode
                }
                let other_parent_lo = self.items[other_parent].child_lo;
                if self.items[item_parent].child_lo == item {
                    self.items[item_parent].child_lo = other;
                }
                if other_parent_lo == other {
                    self.items[other_parent].child_lo = item;
                }
                self.items[item].parent = other_parent;
                self.items[other].parent = item_parent;
            }
            item = self.items[item].parent;
        }
    }

    /// The lightest leaf becomes a parent of itself (`old`) and the new byte (`new`, weight 0).
    fn add_value(&mut self, old: u32, new: u32) {
        let last = self.last();
        let hi = self.create(old, self.items[last].weight, Insert::Last);
        self.items[hi].parent = last;
        self.by_value[old as usize] = hi;
        let lo = self.create(new, 0, Insert::Last);
        self.items[lo].parent = last;
        self.items[last].child_lo = lo;
        self.by_value[new as usize] = lo;
        self.increment(lo);
    }
}

/// Least-significant-bit-first reader.
struct Bits<'a> {
    data: &'a [u8],
    pos: usize,
    buf: u32,
    count: u32,
}

impl Bits<'_> {
    fn get(&mut self, n: u32) -> Option<u32> {
        while self.count < n {
            self.buf |= (*self.data.get(self.pos)? as u32) << self.count;
            self.pos += 1;
            self.count += 8;
        }
        let v = self.buf & ((1u32 << n) - 1);
        self.buf >>= n;
        self.count -= n;
        Some(v)
    }
}

/// Decodes a Huffman stream into at most `max` bytes; None if it's malformed.
pub(crate) fn decompress(data: &[u8], max: usize) -> Option<Vec<u8>> {
    let mut bits = Bits { data, pos: 0, buf: 0, count: 0 };
    let kind = bits.get(8)?;
    let table = WEIGHT_TABLES.get((kind & 0x0F) as usize)?;
    let adaptive = kind == 0;
    let mut tree = Tree::new();
    tree.build(table);
    let mut out = Vec::with_capacity(max);
    while out.len() < max {
        // From the root (the heaviest item) down to a leaf: 1 = heavier child.
        let mut item = tree.first();
        while tree.items[item].child_lo != NONE {
            let lo = tree.items[item].child_lo;
            item = if bits.get(1)? == 1 { tree.items[lo].prev } else { lo };
        }
        let mut value = tree.items[item].value;
        if value == 0x100 {
            break;
        }
        if value == 0x101 {
            value = bits.get(8)?;
            let lightest = tree.items[tree.last()].value;
            tree.add_value(lightest, value);
            if !adaptive {
                tree.increment(tree.by_value[value as usize]);
            }
        }
        out.push(value as u8);
        if adaptive {
            tree.increment(tree.by_value[value as usize]);
        }
    }
    Some(out)
}
