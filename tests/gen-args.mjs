// Argument helpers of the make-*.mjs generators (tests/fixtures/we-specs): the arguments after `<cli> <game>`, and the
// exit 2 for a mode a generator doesn't know (a typo must not overwrite the generator's default committed fixture).

/** The arguments after the cli and the game folder, without the flags the binary check reads (--allow-stale). */
export const modeArgs = (argv = process.argv) => argv.slice(4).filter((a) => a !== "--allow-stale");

/** Prints `usage` and exits 2 unless `ok`. */
export function requireValid(ok, usage) {
  if (ok) return;
  console.error(usage);
  process.exit(2);
}
