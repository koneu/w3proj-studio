// War3map.w3i colours.

/** war3map.w3i stores its colours (water tint, fog) blue, green, red, alpha. As `#rrggbb`, for a colour picker. */
export function w3iColorHex(bgra: number[]): string {
  return "#" + [bgra[2], bgra[1], bgra[0]].map((c) => (c ?? 0).toString(16).padStart(2, "0")).join("");
}

/** A picked `#rrggbb` into a w3i colour (blue, green, red, alpha), keeping its alpha. */
export function setW3iColorHex(bgra: number[], hex: string): void {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return;
  bgra[2] = parseInt(m[1], 16);
  bgra[1] = parseInt(m[2], 16);
  bgra[0] = parseInt(m[3], 16);
}
