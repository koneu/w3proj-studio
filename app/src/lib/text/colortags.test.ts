import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { insertBreak, parseColorTags, PLAYER_COLORS, plainText, removeColor, renderColorTags, serializeRuns, wrapColor } from "./colortags";

describe("parseColorTags", () => {
  it("splits colours, resets and breaks", () => {
    assert.deepEqual(parseColorTags("a|cffFF0303red|rb|nc"), [
      { text: "a" }, { text: "red", color: "FF0303", alpha: "ff" }, { text: "b" }, { newline: true, text: "" }, { text: "c" },
    ]);
  });
  it("keeps any alpha and case, and an unterminated colour lasts to the end", () => {
    assert.deepEqual(parseColorTags("|C00aBcDeFx"), [{ text: "x", color: "aBcDeF", alpha: "00" }]);
  });
  it("leaves malformed tags as text", () => {
    assert.equal(plainText("|cff12 |cZZ112233 |x ||"), "|cff12 |cZZ112233 |x ||");
  });
  it("takes a real line break as one", () => {
    assert.equal(plainText("a\r\nb\nc"), "a\nb\nc");
    assert.equal(plainText("a|nb"), "a\nb");
  });
  it("a new colour replaces the old one", () => {
    assert.deepEqual(parseColorTags("|cff111111a|cff222222b").map((r) => r.color), ["111111", "222222"]);
  });
  it("round-trips through serializeRuns", () => {
    const t = "x|cffFF0303a|nb|rc";
    assert.equal(serializeRuns(parseColorTags(t)), t);
  });
  it("never hangs on hostile input", () => {
    const hostile = "|c".repeat(50000) + "|cff".repeat(50000) + "\u0000|".repeat(50000);
    assert.ok(parseColorTags(hostile).length > 0);
  });
});

describe("wrapColor", () => {
  it("wraps the selection", () => {
    assert.deepEqual(wrapColor("Hello world", 6, 11, "ff0303"), { text: "Hello |cffFF0303world|r", selStart: 16, selEnd: 21 });
  });
  it("inserts a pair at the caret, which sits between the tags", () => {
    const r = wrapColor("ab", 1, 1, "#0042ff");
    assert.deepEqual(r, { text: "a|cff0042FF|rb", selStart: 11, selEnd: 11 });
  });
  it("takes a backwards selection", () => {
    assert.equal(wrapColor("abc", 2, 1, "000000").text, "a|cff000000b|rc");
  });
  it("drops colours inside the selection and restores the outer one after it", () => {
    assert.equal(wrapColor("|cff111111abcd|r", 11, 13, "222222").text, "|cff111111a|cff222222bc|cff111111d|r");
  });
  it("a selection edge inside a tag moves out of it", () => {
    assert.equal(wrapColor("|cff111111ab|r", 4, 14, "222222").text, "|cff222222ab|r");
  });
  it("keeps line breaks in the selection and the rest byte-identical", () => {
    const t = "pre|cAABBCCDDx|ny|rpost";
    const r = wrapColor(t, 0, 0, "010203");
    assert.equal(r.text.replace("|cff010203|r", ""), t);
  });
  it("refuses a bad colour", () => {
    assert.throws(() => wrapColor("a", 0, 1, "xyz"));
  });
});

describe("removeColor", () => {
  it("removes the colour from the selection", () => {
    assert.equal(removeColor("a|cffFF0303bcd|re", 12, 13).text, "a|cffFF0303b|rc|cffFF0303d|re");
  });
  it("splits an outer colour around the selection", () => {
    assert.equal(removeColor("|cffFF0303abc|r", 11, 12).text, "|cffFF0303a|rb|cffFF0303c|r");
  });
  it("drops the tags inside the selection", () => {
    const r = removeColor("|cffFF0303abc|r", 0, 14);
    assert.equal(plainText(r.text), "abc");
    assert.ok(!r.text.includes("|cff"));
  });
  it("with a caret removes the colour run around it and keeps the text", () => {
    assert.deepEqual(removeColor("a|cffFF0303bc|rd", 12, 12), { text: "abcd", selStart: 2, selEnd: 2 });
  });
  it("with a caret outside a colour changes nothing", () => {
    assert.equal(removeColor("ab", 1, 1).text, "ab");
  });
  it("an untouched text stays identical", () => {
    const t = "|cff00FF00a|rb|n";
    assert.equal(removeColor(t, 0, 0).text, t);
  });
});

describe("insertBreak", () => {
  it("replaces the selection", () => {
    assert.deepEqual(insertBreak("abcd", 1, 3), { text: "a|nd", selStart: 3, selEnd: 3 });
  });
});

// A minimal stand-in for the DOM: the renderer only creates elements and appends them.
class FakeEl {
  children: FakeEl[] = [];
  style: Record<string, string> = {};
  textContent = "";
  constructor(readonly tag: string, readonly ownerDocument: { createElement(t: string): FakeEl }) {}
  append(c: FakeEl) { this.children.push(c); }
  replaceChildren() { this.children = []; }
}
const fakeDoc = { createElement: (t: string): FakeEl => new FakeEl(t, fakeDoc) };

describe("renderColorTags", () => {
  it("makes coloured spans and breaks from text nodes only", () => {
    const el = fakeDoc.createElement("div");
    renderColorTags("<img src=x onerror=1>|cffFF0303r|nx", el as unknown as HTMLElement, "ffcc00");
    assert.deepEqual(el.children.map((c) => c.tag), ["span", "span", "br", "span"]);
    assert.equal(el.children[0].textContent, "<img src=x onerror=1>", "the text stays text");
    assert.equal(el.children[0].style.color, "#ffcc00");
    assert.equal(el.children[1].style.color, "#FF0303");
  });
});

describe("PLAYER_COLORS", () => {
  it("has 24 players and neutral", () => {
    assert.equal(PLAYER_COLORS.length, 25);
    assert.equal(new Set(PLAYER_COLORS.map((c) => c.rgb)).size, 25);
  });
});
