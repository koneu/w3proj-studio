// Problems counted by severity. Only errors ask before packing; infos are neither errors nor warnings.
export interface Counted { errors: number; warnings: number; infos: number }
export function countProblems(problems: readonly { severity: "error" | "warning" | "info" }[]): Counted {
  const c: Counted = { errors: 0, warnings: 0, infos: 0 };
  for (const p of problems) {
    if (p.severity === "error") c.errors++;
    else if (p.severity === "info") c.infos++;
    else c.warnings++;
  }
  return c;
}
/** "2 errors, 1 warning, 3 infos" with the infos left out when there are none. */
export const describeCounts = (c: Counted): string => `${c.errors} error${c.errors === 1 ? "" : "s"}, ${c.warnings} warning${c.warnings === 1 ? "" : "s"}${c.infos ? `, ${c.infos} info${c.infos === 1 ? "" : "s"}` : ""}`;
/** Whether packing asks first: errors only. */
export const blocksPacking = (c: Counted): boolean => c.errors > 0;
