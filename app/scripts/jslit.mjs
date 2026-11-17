// A value as a JavaScript literal, to put into code sent to a page. JSON.stringify alone leaves `<`, `>`, `/` and the
// line separators U+2028/U+2029 as they are; these are escaped too, so the result can't end a <script> or a line.
const MAP = { "<": "\\u003C", ">": "\\u003E", "/": "\\u002F", "\u2028": "\\u2028", "\u2029": "\\u2029" };

export const lit = (value) => JSON.stringify(value)?.replace(/[<>\/\u2028\u2029]/g, (c) => MAP[c]) ?? "undefined";
