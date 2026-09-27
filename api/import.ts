// Vercel-only. Cloud Run serves `POST /api/import` from `server/importRoute.ts`
// (see `scripts/server.ts`); the import pipeline is `server/recipeImport.ts`.
// The Vercel copy at https://cook-seven-mu.vercel.app is not a supported
// deployment for import, so it refuses every request.

export function POST(): Response {
  return new Response('Unauthorized', { status: 401 });
}
