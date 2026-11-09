// The key of a keyboard event, for key bindings and every other keyboard shortcut.
//
// WebKitGTK (the Linux webview) gives some chords `key: "Unidentified"`. Found with app-smoke's keys over WebDriver
// (app-drive.mjs --key, branch keys-everywhere): Shift+Tab with any other modifiers (X's ISO_Left_Tab), Ctrl+Alt+F1…F12
// (X's switch-terminal keys) and Ctrl+Alt with the number pad's + - * / (X's video mode and grab keys); every other
// chord of letters, digits, named keys, the number pad and punctuation with Ctrl, Shift and Alt came as the key.
// There the physical key (`code`) stands in: its name is the key's for the named keys (Tab, Enter, Escape, the arrows,
// Page Up/Down, Delete, F1…), letters and digits are read from KeyA and Digit1, the number pad's operators from
// NumpadAdd and the like, a modifier from its left or right key.
//
// Shortcut handlers read the key through keyOf, never `e.key` itself: scripts/check-keys.mjs (in `npm run check`)
// finds the ones that don't. Where the typed character is what counts (a menu's Alt+letter mnemonic is still a
// shortcut; text typed into a field isn't handled by key events here), a line can say why with `keys-ok: <reason>`.

const NUMPAD: Record<string, string> = {
  NumpadAdd: "+", NumpadSubtract: "-", NumpadMultiply: "*", NumpadDivide: "/", NumpadDecimal: ".", NumpadEnter: "Enter", NumpadEqual: "=",
};

/** `e.key`, or what `e.code` names when the webview couldn't tell the key ("Unidentified" or empty). A letter with
 *  Shift is its capital, as the webview gives it when it can tell. */
export function keyOf(e: { key: string; code?: string; shiftKey?: boolean }): string {
  if (e.key && e.key !== "Unidentified") return e.key;
  const code = e.code ?? "";
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return e.shiftKey ? letter[1] : letter[1].toLowerCase();
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (digit) return digit[1];
  if (code === "Space") return " ";
  if (NUMPAD[code]) return NUMPAD[code];
  const modifier = /^(Shift|Control|Alt|Meta)(?:Left|Right)$/.exec(code);
  if (modifier) return modifier[1];
  return code || e.key;
}
