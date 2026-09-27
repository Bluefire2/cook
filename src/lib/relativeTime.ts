import { formatDistance } from 'date-fns';

/**
 * Past relative time for the invitations menu. date-fns picks the unit
 * (minutes, hours, days, and beyond) from the delta. A future timestamp is
 * clock skew and stays "just now", so a row never reads as upcoming.
 */
export function relativeAgoLabel(at: number, now: number = Date.now()): string {
  if (at > now) {
    return 'just now';
  }
  return formatDistance(at, now, { addSuffix: true });
}

/** Future timestamp for an unused invite link. */
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
