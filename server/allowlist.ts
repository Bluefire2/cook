export function parseAllowedEmails(raw: string): Set<string> {
  const out = new Set<string>();
  for (const part of raw.split(',')) {
    const email = part.trim().toLowerCase();
    if (email !== '') {
      out.add(email);
    }
  }
  return out;
}

export function isAllowed(
  email: string | undefined,
  emailVerified: boolean | undefined,
  raw: string,
): boolean {
  if (raw.trim() === '') {
    return false;
  }
  if (emailVerified !== true) {
    return false;
  }
  if (email === undefined || email.trim() === '') {
    return false;
  }
  return parseAllowedEmails(raw).has(email.trim().toLowerCase());
}
