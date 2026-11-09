// The key of a keyboard event, for key bindings.
//
// WebKitGTK (the Linux webview) gives some chords `key: "Unidentified"`: Shift+Tab comes as key "Unidentified" with
// code "Tab", so Ctrl+Shift+Tab matched nothing. There the physical key (`code`) stands in: its name is the key's for
// the named keys (Tab, Enter, Escape, the arrows, Page Up/Down, Delete, F1…), letters and digits are read from KeyA and
// Digit1.

/** `e.key`, or what `e.code` names when the webview couldn't tell the key ("Unidentified" or empty). */
export function keyOf(e: { key: string; code?: string }): string {
  if (e.key && e.key !== "Unidentified") return e.key;
  const code = e.code ?? "";
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1].toLowerCase();
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  if (code === "Space") return " ";
  return code || e.key;
}
