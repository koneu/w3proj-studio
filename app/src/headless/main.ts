// The entry of the bundle the w3proj CLI runs in Node (app/scripts/headless.mjs builds it):
// `node w3proj-headless.mjs <job as JSON>`. The job's kind is its `task`; the report goes back over the pipe.

import { finish, install } from "./ipc";
import { rebuild, type Job } from "./rebuild";

const text = (e: unknown) => (e instanceof Error ? e.message : String(e));

install();
const job = JSON.parse(process.argv[2] ?? "{}") as Job & { task?: string };
if (job.task !== "rebuild") void finish({ error: `the headless host has no task ${JSON.stringify(job.task)}` });
else rebuild(job).then(finish, (e) => finish({ error: text(e) }));
