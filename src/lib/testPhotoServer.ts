import { vi } from 'vitest';
import { clearLibrary } from './libraryMemory';
import { postPhoto, pushOps } from './remote';
import type { PushOp } from './pushOps';

type PushResult = Awaited<ReturnType<typeof pushOps>>;
type PhotoResult = Awaited<ReturnType<typeof postPhoto>>;

export type PhotoServerFake = {
  /** `push:<kind>` per op and `photo:<id>` per upload, in call order. */
  calls: string[];
  pushed: PushOp[];
  liveRecipeIds: Set<string>;
};

/**
 * Test setup for a mocked `./remote`: `pushOps` and `postPhoto` behave like
 * the server. `photosPost` answers 409 `recipe-deleted` (which `postPhoto`
 * reports as `'error'`) unless the recipe row is live, and only an applied
 * `recipe.put` makes it live. `failPush` / `failPhoto` inject a failure; a
 * failed push applies nothing, and `'signedOut'` clears the library as
 * `remote` does on a 401.
 */
export function installPhotoServerFake(opts?: {
  failPush?: (ops: PushOp[]) => PushResult | undefined;
  failPhoto?: (photoId: string) => PhotoResult | undefined;
}): PhotoServerFake {
  const fake: PhotoServerFake = { calls: [], pushed: [], liveRecipeIds: new Set() };
  vi.mocked(pushOps).mockImplementation(async (ops) => {
    for (const op of ops) {
      fake.calls.push(`push:${op.kind}`);
    }
    const failure = opts?.failPush?.(ops);
    if (failure !== undefined && failure !== 'ok') {
      if (failure === 'signedOut') {
        clearLibrary();
      }
      return failure;
    }
    for (const op of ops) {
      fake.pushed.push(op);
      if (op.kind === 'recipe.put') {
        fake.liveRecipeIds.add(op.payload.id);
      } else if (op.kind === 'recipe.delete') {
        fake.liveRecipeIds.delete(op.payload.id);
      }
    }
    return 'ok';
  });
  vi.mocked(postPhoto).mockImplementation(async (photoId, recipeId) => {
    fake.calls.push(`photo:${photoId}`);
    const failure = opts?.failPhoto?.(photoId);
    if (failure !== undefined && failure !== 'ok') {
      if (failure === 'signedOut') {
        clearLibrary();
      }
      return failure;
    }
    return fake.liveRecipeIds.has(recipeId) ? 'ok' : 'error';
  });
  return fake;
}
