// Which animation a placed object stands in. One model can hold several looks: the four Human
// towers share a file, and the unit's Animprops (animProps, "upgrade,second") names the look.

/** Words in animation names that mark a look of the model, not a moment of the animation. */
const LOOKS = new Set(["upgrade", "first", "second", "third", "fourth", "fifth", "alternate", "swim"]);

const wordsOf = (name: string) => name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** An Animprops value as its words. No model has an "alternateex" animation: units with that
 *  word (a Demon Hunter's Metamorphosis) stand in their Alternate ones. */
export const parseAnimProps = (value: string): string[] =>
  [...new Set(value.split(",").map((p) => p.trim().toLowerCase().replace(/^alternateex$/, "alternate")).filter(Boolean))];

/** The first Stand animation with the wanted look and no other look; a look can also be in an
 *  "Attack Stand Ready First". Without the look, the plainest Stand; else the model's first animation. */
export function standSequence<S extends { name: string }>(sequences: readonly S[], props: readonly string[] = []): S | undefined {
  const anywhere = sequences.filter((s) => wordsOf(s.name).includes("stand"));
  const leading = anywhere.filter((s) => wordsOf(s.name)[0] === "stand");
  const fits = (list: S[]) => list.filter((s) => props.every((p) => wordsOf(s.name).includes(p)));
  const looks = (s: S) => wordsOf(s.name).filter((w) => LOOKS.has(w) && !props.includes(w)).length;
  const pool = [fits(leading), fits(anywhere), leading, anywhere].find((l) => l.length) ?? [];
  return pool.reduce<S | undefined>((best, s) => (best === undefined || looks(s) < looks(best) ? s : best), undefined) ?? sequences[0];
}
