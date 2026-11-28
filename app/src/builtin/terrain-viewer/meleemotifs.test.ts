import assert from "node:assert/strict";
import { test } from "node:test";
import { MOTIF_KINDS, MOTIF_NOTES, motifOf, type Motifs } from "./meleemotifs";
import stored from "./meleemotifs.json";

test("a motif is each measure's median and the span most places lie in", () => {
  const places = Array.from({ length: 11 }, (_, i) => ({ closed: 0.4 + i * 0.04, ways: i < 9 ? 1 : 2, widest: 60 + i * 15, room: 160 + i * 32 }));
  const m = motifOf(places);
  assert.equal(m.places, 11);
  assert.deepEqual(m.ringClosed, { low: 0.44, usual: 0.6, high: 0.76 });
  assert.deepEqual(m.waysIn, { low: 1, usual: 1, high: 2 });
  assert.deepEqual(m.widestGap, { low: 75, usual: 135, high: 195 });
  assert.deepEqual(m.roomAtMiddle, { low: 192, usual: 320, high: 448 });
  assert.throws(() => motifOf([]), /no places/);
});

test("the stored motifs: every kind, spans in order, and numbers only", () => {
  const all = stored as Motifs;
  assert.deepEqual(Object.keys(all).sort(), [...MOTIF_KINDS].sort());
  for (const kind of MOTIF_KINDS) {
    const m = all[kind] as unknown as Record<string, { low: number; usual: number; high: number } | number>;
    assert.ok((m.places as number) >= 20, `${m.places} ${kind}`);
    assert.deepEqual(Object.keys(m).sort(), ["places", ...Object.keys(MOTIF_NOTES)].sort());
    for (const key of Object.keys(MOTIF_NOTES)) {
      const s = m[key] as { low: number; usual: number; high: number };
      assert.ok(s.low <= s.usual && s.usual <= s.high, `${kind} ${key}`);
    }
  }
  // A pocket is mostly closed with one way in, as the camp check holds a camp to.
  assert.ok(all["camp pocket"].ringClosed.usual >= 0.6 && all["camp pocket"].waysIn.usual === 1);
  // Nothing but the kinds' names, the measures' names and numbers: no map, no patch.
  const text = JSON.stringify(all).replace(/"(camp pocket|natural|shop clearing|places|ringClosed|waysIn|widestGap|roomAtMiddle|low|usual|high)"/g, "");
  assert.match(text, /^[\d.,:{}]*$/);
});
