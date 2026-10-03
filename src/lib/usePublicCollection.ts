import { useEffect, useState } from 'react';
import { fetchPublicCollection, type PublicCollectionResult } from './publicApi';

/**
 * One public collection, fetched when the screen opens (and on retry). Held
 * in this component's state only: a public page never writes the library.
 * `undefined` while the first read for this token is in flight.
 */
export function usePublicCollection(token: string): {
  result: PublicCollectionResult | undefined;
  retry: () => void;
} {
  const [loaded, setLoaded] = useState<{ token: string; result: PublicCollectionResult } | null>(
    null,
  );
  // A fresh object per try: a retry is a new request, not a render counter.
  const [request, setRequest] = useState<object>(() => ({}));
  useEffect(() => {
    let current = true;
    void fetchPublicCollection(token).then((result) => {
      if (current) setLoaded({ token, result });
    });
    return () => {
      current = false;
    };
  }, [token, request]);
  return {
    // A result for the previous token is not this page's.
    result: loaded !== null && loaded.token === token ? loaded.result : undefined,
    retry: () => {
      setLoaded(null);
      setRequest({});
    },
  };
}
