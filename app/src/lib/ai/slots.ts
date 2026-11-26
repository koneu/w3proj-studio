// The control number of a .wai Test Configuration slot: who controls it, whether it only watches, and which AI it runs.

export type SlotControl = "User" | "Computer";
export type SlotAi = "Standard" | "Custom" | "Current";
const AI: readonly SlotAi[] = ["Standard", "Custom", "Current", "Current"];

/** As the World Editor reads it: bit 0 is Control (odd = User, even = Computer); bit 1 Observer: it is set in the
 *  slot the editor shows as "Observer" (GruntMaster.wai's user, 3, on the user's screenshot 2026-11-26; its computers,
 *  12 and 0, show Team 1 and Team 2 from the stored teams 0 and 1) and in every user slot of the game's AI files;
 *  (value >> 2) & 3 the AI (0 Standard, 1 Custom, 2 and 3 Current). */
export function decodeAiType(value: number): { control: SlotControl; observer: boolean; ai: SlotAi } {
  const v = value >>> 0;
  return { control: v & 1 ? "User" : "Computer", observer: (v & 2) !== 0, ai: AI[(v >> 2) & 3] };
}

/** `value` with the parts given changed; its other bits stay (Current stays 2 or 3 as stored). */
export function encodeAiType(value: number, change: { control?: SlotControl; observer?: boolean; ai?: SlotAi }): number {
  let v = value >>> 0;
  if (change.control !== undefined) v = (v & ~1) | (change.control === "User" ? 1 : 0);
  if (change.observer !== undefined) v = (v & ~2) | (change.observer ? 2 : 0);
  if (change.ai !== undefined && decodeAiType(v).ai !== change.ai) v = (v & ~0xc) | ((change.ai === "Current" ? 3 : AI.indexOf(change.ai)) << 2);
  return v >>> 0;
}
