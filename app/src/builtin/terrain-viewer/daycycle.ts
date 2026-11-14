/** The running day/night cycle of the terrain view (setting terrain.lighting.dayNightCycle). */

/** A game day lasts this many seconds at the game's default (the gameplay constant for the day's length). */
export const DAY_SECONDS = 480;

/** The hour (0 up to, not including, 24) `seconds` of real time after `hour`, wrapped at 24. A bad hour counts as 0,
 *  a negative or non-finite time leaves the hour as it is. */
export function stepHour(hour: number, seconds: number, daySeconds = DAY_SECONDS): number {
  const h0 = Number.isFinite(hour) ? hour : 0;
  const dt = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const len = Number.isFinite(daySeconds) && daySeconds > 0 ? daySeconds : DAY_SECONDS;
  return ((((h0 + (dt / len) * 24) % 24) + 24) % 24);
}
