/**
 * The "Synced N min ago" idiom from Settings, extracted so the /admin screen
 * uses the same relative-time label instead of growing a second one.
 */
export function relativeMinutesLabel(at: number, now: number = Date.now()): string {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) {
    return 'just now';
  }
  return `${minutes} min ago`;
}
