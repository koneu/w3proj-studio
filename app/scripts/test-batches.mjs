// Splits the test bundles that scripts/test.mjs hands to `node --test` into runs whose command lines fit. Windows
// refuses a command line over 32767 characters (CreateProcess); spawnSync then fails with ENAMETOOLONG before node
// starts, so the run printed nothing and only exited 1 (GitHub CI's Windows job, from the 291st test file on). The
// same limit applies on every platform, so Linux runs take the batched path too and the gate covers it.

/** Windows' limit is 32767 characters including the terminator; the rest is room for quoting we don't count exactly. */
export const COMMAND_LINE_LIMIT = 30000;

/** The length an argument takes on a Windows command line: a space before it, and quotes when it holds a blank. */
function argLength(a) {
  return a.length + 1 + (/[\s"]/.test(a) ? 2 + (a.match(/["\\]/g)?.length ?? 0) : 0);
}

/**
 * The files split into consecutive groups, each of which fits on one command line together with `exe` and the
 * arguments before them (`fixed`). A group holds at least one file, even if that one alone is too long.
 * @param {string[]} files
 * @param {string[]} fixed
 * @param {string} exe
 * @param {number} [limit]
 * @returns {string[][]}
 */
export function testBatches(files, fixed, exe, limit = COMMAND_LINE_LIMIT) {
  const base = argLength(exe) + fixed.reduce((n, a) => n + argLength(a), 0);
  const groups = [];
  let group = [], used = base;
  for (const f of files) {
    const n = argLength(f);
    if (group.length && used + n > limit) {
      groups.push(group);
      group = [];
      used = base;
    }
    group.push(f);
    used += n;
  }
  if (group.length) groups.push(group);
  return groups;
}
