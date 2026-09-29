export function legacyCollectionRedirectTarget(
  c: string | null,
  href: (collectionId: string | undefined) => string,
): string | null {
  if (c === null) {
    return null;
  }
  return href(c);
}
