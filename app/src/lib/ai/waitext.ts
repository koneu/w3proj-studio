// A .wai file (binary) as a text, for the places that hold files as texts: the AI edit list (MCP), whose edits and
// undo compare and write back whole file texts. The text is this marker and the file's bytes in base64; nothing else
// reads or writes it, and it never reaches the disk.

const MARK = "w3proj.wai.base64:";

export const isWaiPath = (path: string) => /\.wai$/i.test(path);

export function waiToText(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return MARK + btoa(binary);
}

/** The bytes of a text waiToText made; throws for any other text (a client's own text for a .wai file). */
export function waiFromText(text: string): Uint8Array {
  if (!text.startsWith(MARK)) throw new Error("An AI file (.wai) isn't text: use set_ai to change it.");
  const binary = atob(text.slice(MARK.length));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
