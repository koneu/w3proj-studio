// Line icons for the terrain tool buttons (24×24, drawn in the text colour).

const PATHS: Record<string, string> = {
  select: "M6 3l12 9-5.5 1.5L10 19z",
  raise: "M3 20h18M5 20c2-5 12-5 14 0M12 3v9M8.5 6.5L12 3l3.5 3.5",
  lower: "M3 20h18M5 20c2-5 12-5 14 0M12 3v9M8.5 8.5L12 12l3.5-3.5",
  plateau: "M2 19h5l3-7h4l3 7h5",
  smooth: "M3 15c3-6 6 6 9 0s6 6 9 0",
  noise: "M2 19h20M2 15l3-4 2 3 3-6 2 5 3-3 2 4 3-5 2 3",
  paint: "M5 20c2.5 0 4-1.5 4-3.5L18 7.5 16.5 6 7.5 15C5.5 15 4 16.5 4 19zM15 4.5l4.5 4.5",
  cliffUp: "M2 20h8v-8h12M16 8l3-4 3 4",
  cliffDown: "M2 12h8v8h12M16 4l3 4 3-4",
  cliffUp2: "M2 20h5v-5h5v-5h10M17 7l2.5-3.5L22 7",
  cliffDown2: "M2 10h5v5h5v5h10M17 4l2.5 3.5L22 4",
  cliffLevel: "M2 20h8v-8h12M14 6h8M14 9h8",
  shallow: "M2 15c2.5-2.5 4.5 2.5 7 0s4.5 2.5 7 0 4.5 2.5 6 1",
  deep: "M2 10c2.5-2.5 4.5 2.5 7 0s4.5 2.5 7 0 4.5 2.5 6 1M2 17c2.5-2.5 4.5 2.5 7 0s4.5 2.5 7 0 4.5 2.5 6 1",
  dry: "M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2M12 8a4 4 0 1 0 .01 0",
  blight: "M4 18c2-7 14-7 16 0zM8 12L7 8M12 10.5V6M16 12l1-4",
  unblight: "M4 18c2-7 14-7 16 0zM3 3l18 18",
  boundary: "M4 4h16v16H4zM4 12h16M12 4v16",
  unboundary: "M4 4h16v16H4zM3 3l18 18",
  ramp: "M2 20h6l8-8h6",
};

/** An inline SVG icon for a tool, or an empty span when there is none. */
export function toolIcon(tool: string): HTMLElement {
  const span = document.createElement("span");
  span.className = "tool-icon";
  const d = PATHS[tool];
  if (d) span.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
  return span;
}
