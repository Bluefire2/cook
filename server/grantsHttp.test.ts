import { describe, expect, it } from 'vitest';
import { collectionIdFromPath } from './grantsHttp.ts';

const id = '11111111-1111-4111-8111-111111111111';

describe('collectionIdFromPath', () => {
  it('reads a collection UUID from grant routes', () => {
    expect(collectionIdFromPath(`/api/collections/${id}/grants`)).toBe(id);
    expect(collectionIdFromPath(`/api/collections/${id}/grants/revoke`)).toBe(id);
    expect(collectionIdFromPath(`/api/collections/not-a-uuid/grants`)).toBeNull();
    expect(collectionIdFromPath('/api/sync/shared')).toBeNull();
  });
});
