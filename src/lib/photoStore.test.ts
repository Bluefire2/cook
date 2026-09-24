import { afterEach, describe, expect, it, vi } from 'vitest';
import { photoStore } from './photoStore';
import { clearLibrary, getPendingBlob } from './libraryMemory';
import { pushOps } from './remote';

vi.mock('./remote', () => ({
  fetchPhotoBlob: vi.fn(),
  pushOps: vi.fn(),
}));

afterEach(() => {
  clearLibrary();
  vi.mocked(pushOps).mockReset();
});

describe('photoStore.discardLocal', () => {
  it('drops the pending blob and does not push', async () => {
    const id = await photoStore.add(new Blob(['x'], { type: 'image/jpeg' }));
    expect(getPendingBlob(id)).toBeDefined();

    photoStore.discardLocal(id);

    expect(getPendingBlob(id)).toBeUndefined();
    expect(pushOps).not.toHaveBeenCalled();
  });
});
