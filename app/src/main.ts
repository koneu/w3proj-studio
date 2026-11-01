import { Workbench } from "./workbench/workbench";

const wb = new Workbench(document.getElementById("app")!);
// Handy for poking at the API from devtools.
(window as any).w3 = wb.api;
wb.start().catch((e) => {
  console.error(e);
  wb.notifications.show("error", `Startup failed: ${e}`);
});
