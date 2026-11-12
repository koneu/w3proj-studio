import { Workbench } from "./workbench/workbench";

const wb = new Workbench(document.getElementById("app")!);
// Handy for poking at the API from devtools.
(window as any).w3 = wb.api;
// The smoke test (scripts/ui-smoke.mjs) asks the extension host and the command list directly.
(window as any).w3Workbench = wb;
// Resolves once the start is over (or failed): app-smoke waits on it instead of a pause after the first window.
(window as any).w3Started = wb.start().catch((e) => {
  console.error(e);
  wb.notifications.show("error", `Startup failed: ${e}`);
});
