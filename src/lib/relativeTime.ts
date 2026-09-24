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

/** Future timestamp for unused invite expiry, matching the same rounding. */
export function relativeExpiryLabel(at: number, now: number = Date.now()): string {
  const minutes = Math.round((at - now) / 60_000);
  if (minutes < 1) {
    return 'expires in under a minute';
  }
  if (minutes < 60) {
    return `expires in ${minutes} min`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `expires in ${hours} h`;
  }
  const days = Math.round(hours / 24);
  return `expires in ${days} days`;
}
