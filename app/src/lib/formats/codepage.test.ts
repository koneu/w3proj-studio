import assert from "node:assert/strict";
import { test } from "node:test";
import { mulberry32, readFixture } from "../testhelpers/testutil";
import { codePageOf, showText, storeNewText, storeText, UnencodableError, type CodePage } from "./codepage";
import { decodeLossless, encodeLossless, hasRawBytes } from "./lossless";

const PAGES: CodePage[] = ["gbk", "cp949", "big5"];
const hex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));
const hexOf = (s: string) => Buffer.from(encodeLossless(s)).toString("hex");
const bytes = (...parts: (string | number[])[]) => new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...Buffer.from(p, "utf8")] : p)));

interface Samples {
  read: { codePage: CodePage; bytes: string; lossless: string; shown: string }[];
  typed: { codePage: CodePage; typed: string; stored: string; bytes: string }[];
}
/** tests/fixtures/codepage-samples.json: crates/w3proj/src/lossless.rs reads the same samples. */
const samples = (): Samples => JSON.parse(readFixture("codepage-samples.json"));

test("the samples: read in their code page, a sequence it can't read kept as its bytes", () => {
  const s = samples();
  assert.ok(s.read.some((r) => hasRawBytes(r.shown)), "control: some sample keeps bytes the code page can't read");
  for (const r of s.read) {
    const text = decodeLossless(hex(r.bytes));
    assert.equal(text, r.lossless, `${r.codePage} ${r.bytes}: lossless`);
    assert.equal(showText(text, r.codePage), r.shown, `${r.codePage} ${r.bytes}: shown`);
    // Untouched: the same text back, byte for byte.
    assert.equal(storeText(r.shown, text, r.codePage), text);
    assert.equal(hexOf(storeText(r.shown, text, r.codePage)), r.bytes);
    // Typed anew as it shows (nothing to compare with): the same bytes too.
    assert.equal(hexOf(storeNewText(r.shown, r.codePage)), r.bytes, `${r.codePage} ${r.bytes}: typed as shown`);
  }
  for (const t of s.typed) {
    assert.equal(storeNewText(t.typed, t.codePage), t.stored, `${t.codePage} ${t.typed}`);
    assert.equal(hexOf(t.stored), t.bytes);
  }
});

test("known answers: 中文 in GBK and Big5, 한국 in CP949", () => {
  const show = (b: number[], cp: CodePage) => showText(decodeLossless(new Uint8Array(b)), cp);
  assert.equal(show([0xd6, 0xd0, 0xce, 0xc4], "gbk"), "中文");
  assert.equal(show([0xc4, 0xe3, 0xba, 0xc3], "gbk"), "你好");
  assert.equal(show([0xa4, 0xa4, 0xa4, 0xe5], "big5"), "中文");
  assert.equal(show([0xc7, 0xd1, 0xb1, 0xb9], "cp949"), "한국");
  // The wrong code page reads other characters, or none: never the right ones.
  assert.notEqual(show([0xd6, 0xd0, 0xce, 0xc4], "big5"), "中文");
});

test("without a code page everything is as it was", () => {
  const text = decodeLossless(new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]));
  assert.equal(showText(text, null), text);
  assert.equal(storeText("anything 中文", text, null), "anything 中文");
  assert.equal(codePageOf("utf-8"), null);
  assert.equal(codePageOf(undefined), null);
  assert.equal(codePageOf("gbk"), "gbk");
  assert.equal(codePageOf("toString"), null);
});

test("a text that is UTF-8 shows as it is; only lines with other bytes are read in the code page", () => {
  for (const cp of PAGES) {
    for (const s of ["", "plain", "Größe", "中文", "😀", "a\nb"]) assert.equal(showText(s, cp), s);
  }
  const text = decodeLossless(bytes("Größe\r\n", [0xd6, 0xd0, 0xce, 0xc4], "\r\nplain"));
  assert.equal(showText(text, "gbk"), "Größe\r\n中文\r\nplain");
});

test("random bytes: what shows turns back into the same bytes, typed as it shows or left alone", () => {
  const seed = 0x5eed_c0de;
  const rnd = mulberry32(seed);
  for (const cp of PAGES) {
    for (let round = 0; round < 400; round++) {
      const len = Math.floor(rnd() * 40);
      // Mostly lead and trail bytes of the code pages, some ASCII and line breaks.
      const b = new Uint8Array(len).map(() => { const r = rnd(); return r < 0.1 ? 0x0a : r < 0.3 ? Math.floor(rnd() * 0x80) : 0x80 + Math.floor(rnd() * 0x80); });
      const text = decodeLossless(b);
      const shown = showText(text, cp);
      assert.equal(storeText(shown, text, cp), text, `seed ${seed} ${cp}: untouched`);
      // Each line that holds other bytes, typed anew: its bytes again (the lines that are UTF-8 show as they are).
      shown.split("\n").forEach((line, i) => {
        const was = text.split("\n")[i];
        if (!hasRawBytes(was)) return;
        assert.equal(hexOf(storeNewText(line, cp)), hexOf(was), `seed ${seed} ${cp}: line ${i} of ${Buffer.from(b).toString("hex")}`);
      });
    }
  }
});

test("an edit writes its line in the code page; the lines it didn't touch keep their bytes", () => {
  const gbk = [0xd6, 0xd0, 0xce, 0xc4];
  // A GBK line, a UTF-8 line (a later editor's), an ASCII line, a line with a byte GBK can't read.
  const text = decodeLossless(bytes(gbk, "\nGröße 中\nplain\n", [0xff, 0x41]));
  const shown = showText(text, "gbk");
  assert.equal(shown.split("\n")[0], "中文");
  // The ASCII line changed: the others are their bytes.
  const edited = storeText(shown.replace("plain", "plain!"), text, "gbk");
  assert.deepEqual(encodeLossless(edited), bytes(gbk, "\nGröße 中\nplain!\n", [0xff, 0x41]));
  // A line typed above the others: they move and keep their bytes; the new one is GBK.
  const above = storeText(`你好\n${shown}`, text, "gbk");
  assert.deepEqual(encodeLossless(above), bytes([0xc4, 0xe3, 0xba, 0xc3], "\n", gbk, "\nGröße 中\nplain\n", [0xff, 0x41]));
  // The GBK line edited: written in GBK.
  const first = storeText(shown.replace("中文", "中文字"), text, "gbk");
  assert.deepEqual(encodeLossless(first).subarray(0, 6), new Uint8Array([...gbk, 0xd7, 0xd6]));
  // Two lines that show alike, 中 in UTF-8 and in GBK: each keeps its own bytes where it is, and an edit of another line
  // leaves both (and, both moved down, neither is guessed: an edit then writes them anew in GBK).
  const twins = decodeLossless(bytes("中\n", [0xd6, 0xd0], "\nx"));
  assert.deepEqual(showText(twins, "gbk").split("\n"), ["中", "中", "x"]);
  assert.deepEqual(encodeLossless(storeText("中\n中\ny", twins, "gbk")), bytes("中\n", [0xd6, 0xd0], "\ny"));
  assert.deepEqual(encodeLossless(storeText("new\n中\n中\nx", twins, "gbk")), bytes("new\n", [0xd6, 0xd0], "\n", [0xd6, 0xd0], "\nx"));
  // Control: an edit of the UTF-8 line writes it in GBK (an edited text goes in the chosen code page), and its ö
  // can't be: refused.
  assert.throws(() => storeText(shown.replace("Größe 中", "Größe 中!"), text, "gbk"), UnencodableError);
  assert.deepEqual(encodeLossless(storeText(shown.replace("Größe 中", "Grosse 中"), text, "gbk")).subarray(5, 14), bytes("Grosse ", [0xd6, 0xd0]));
});

test("a character the code page can't write refuses the edit and says which", () => {
  const text = decodeLossless(new Uint8Array([0xc7, 0xd1, 0xb1, 0xb9]));
  assert.throws(() => storeText("한국 😀 €", text, "cp949"), (e: unknown) => {
    assert.ok(e instanceof UnencodableError);
    assert.deepEqual(e.chars, ["😀", "€"]);
    assert.match(e.message, /"😀" \(U\+1F600\).*can't be written in CP949/);
    return true;
  });
  // Control: what it can write is taken.
  assert.deepEqual(encodeLossless(storeText("한국 Ork", text, "cp949")), bytes([0xc7, 0xd1, 0xb1, 0xb9], " Ork"));
  // Hangul isn't in GBK, Chinese is.
  assert.throws(() => storeNewText("한", "gbk"), UnencodableError);
  assert.doesNotThrow(() => storeNewText("中", "cp949"));
});
