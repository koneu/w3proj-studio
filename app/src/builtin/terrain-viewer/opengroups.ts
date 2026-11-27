// Which of the terrain toolbar's groups are unfolded, kept per user. All start folded, so the
// toolbar stays one line high until a group is asked for.

const KEY = "w3.terrain.openGroups";

export const openGroups = {
  read(): string[] {
    try {
      const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
      return Array.isArray(v) ? v.filter((n): n is string => typeof n === "string") : [];
    } catch {
      return [];
    }
  },
  write(names: string[]) {
    try {
      localStorage.setItem(KEY, JSON.stringify(names));
    } catch { /* not kept: the groups start folded again */ }
  },
};
