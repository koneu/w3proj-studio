// Checks a hand-edited settings value against its declaration (type, enum, range). Pure: no disk, no workbench.

import type { ConfigurationProperty } from "../extensions/api";

/** Why `value` doesn't fit the declaration, or null when it does. */
export function validateSetting(key: string, p: ConfigurationProperty, value: unknown): string | null {
  const show = (v: unknown) => { const t = JSON.stringify(v); return t === undefined ? String(v) : t.length > 60 ? `${t.slice(0, 57)}...` : t; };
  const got = value === null ? "null" : Array.isArray(value) ? "an array" : typeof value === "object" ? "an object" : `${typeof value} ${show(value)}`;
  switch (p.type) {
    case "boolean": if (typeof value !== "boolean") return `${key} must be true or false, not ${got}.`; break;
    case "string": if (typeof value !== "string") return `${key} must be a string, not ${got}.`; break;
    case "number":
    case "integer":
      if (typeof value !== "number" || !Number.isFinite(value)) return `${key} must be a number, not ${got}.`;
      if (p.type === "integer" && !Number.isInteger(value)) return `${key} must be a whole number, not ${show(value)}.`;
      if (p.minimum !== undefined && value < p.minimum) return `${key} must be at least ${p.minimum}, not ${show(value)}.`;
      if (p.maximum !== undefined && value > p.maximum) return `${key} must be at most ${p.maximum}, not ${show(value)}.`;
      break;
    case "array": if (!Array.isArray(value)) return `${key} must be a list, not ${got}.`; break;
    case "object": if (typeof value !== "object" || value === null || Array.isArray(value)) return `${key} must be an object, not ${got}.`; break;
  }
  if (p.enum && !p.enum.some((e) => e === value)) return `${key} must be one of ${p.enum.map(show).join(", ")}, not ${show(value)}.`;
  return null;
}
