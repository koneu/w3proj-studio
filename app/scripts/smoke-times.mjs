// Writes app-smoke-times.json, by which a split app smoke run cuts its checks into parts of the same length
// (smoke-parts.mjs), from app smoke logs:
//
//   node scripts/smoke-times.mjs ../target/gate-logs/batch-<pid>/appsmoke*.log

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { secondsFromLogs } from "./smoke-parts.mjs";

const logs = process.argv.slice(2);
if (!logs.length) {
  console.error("usage: node scripts/smoke-times.mjs <app smoke logs>");
  process.exit(2);
}
const file = join(dirname(fileURLToPath(import.meta.url)), "app-smoke-times.json");
const seen = secondsFromLogs(logs.map((l) => readFileSync(l, "utf8")));
// A check the logs don't have keeps the time it had (a part that failed early, a check skipped without the game).
const all = { ...JSON.parse(readFileSync(file, "utf8")), ...seen };
writeFileSync(file, `${JSON.stringify(Object.fromEntries(Object.entries(all).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))), null, 2)}\n`);
console.log(`${Object.keys(seen).length} checks read, ${Object.keys(all).length} in ${file}`);
