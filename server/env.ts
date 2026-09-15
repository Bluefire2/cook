function envError(name: string): Error {
  return new Error(
    `${name} is not set. Set ${name} in \`.env.local\` for dev, or via \`scripts/deploy.sh\` on Cloud Run.`,
  );
}

export function publicOrigin(): string {
  const raw = process.env.PUBLIC_ORIGIN;
  if (raw === undefined || raw.trim() === '') {
    throw envError('PUBLIC_ORIGIN');
  }
  return raw.trim().replace(/\/+$/, '');
}

export function redirectUri(): string {
  return `${publicOrigin()}/api/auth/callback/google`;
}

export function googleClient(): { id: string; secret: string } {
  const id = process.env.AUTH_GOOGLE_ID?.trim();
  if (!id) {
    throw envError('AUTH_GOOGLE_ID');
  }
  const secret = process.env.AUTH_GOOGLE_SECRET?.trim();
  if (!secret) {
    throw envError('AUTH_GOOGLE_SECRET');
  }
  return { id, secret };
}

export function sessionSecret(): string | null {
  const raw = process.env.SESSION_SECRET;
  if (raw === undefined || raw.trim() === '') {
    return null;
  }
  return raw;
}

export function allowedEmails(): string {
  const raw = process.env.ALLOWED_EMAILS;
  if (raw === undefined) {
    return '';
  }
  return raw;
}

export function firestoreConfig(): { projectId: string; databaseId?: string } {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT?.trim();
  if (!projectId) {
    throw envError('GOOGLE_CLOUD_PROJECT');
  }
  const databaseId = process.env.FIRESTORE_DATABASE_ID?.trim();
  if (databaseId) {
    return { projectId, databaseId };
  }
  return { projectId };
}

export function photoBucket(): string | null {
  const raw = process.env.PHOTO_BUCKET?.trim();
  if (!raw) {
    return null;
  }
  return raw;
}

export function isSecureOrigin(): boolean {
  return new URL(publicOrigin()).protocol === 'https:';
}
