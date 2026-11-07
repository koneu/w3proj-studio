// What the backend's file errors say. Rust's io::Error text ends in "(os error N)" whatever the
// system language, so the number is what to go by, not the words.

/** Whether a failed file operation says the file is not there: Windows error 2 (file) or 3 (path),
 *  as an Error or as the plain string a backend call rejects with. Nothing else is "not there": a
 *  file locked by another program (32, 33) or a bad name (123, 267) is there and must not be taken
 *  for gone. */
export function isNotFoundError(e: unknown): boolean {
  const text = e instanceof Error ? e.message : String(e);
  return /os error (2|3)(?!\d)/.test(text);
}
