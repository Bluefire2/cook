import { useEffect, useRef } from 'react';
import type { ImgHTMLAttributes } from 'react';
import { selectPendingBlob } from '../lib/librarySelectors';
import { photoStore, useObjectUrl } from '../lib/photoStore';
import { useLibrarySelect } from '../lib/useLibrary';

type MemoryBlobImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  blob: Blob | undefined;
};

/**
 * Renders a photo preview from an in-memory blob (picked file or fetched bytes).
 * `src` is applied on the element after `URL.createObjectURL`, not from request data.
 */
export function MemoryBlobImage({ blob, alt, className, ...rest }: MemoryBlobImageProps) {
  const url = useObjectUrl(blob);
  const ref = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const img = ref.current;
    if (!img) {
      return;
    }
    if (url === undefined) {
      img.removeAttribute('src');
      return;
    }
    try {
      if (new URL(url).protocol !== 'blob:') {
        img.removeAttribute('src');
        return;
      }
    } catch {
      img.removeAttribute('src');
      return;
    }
    img.src = url;
  }, [url]);

  if (blob === undefined) {
    return null;
  }

  return <img ref={ref} alt={alt} className={className} {...rest} />;
}

type StoredPhotoImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  photoId: string | undefined;
};

/** Photo already in the library session (pending upload or fetched from the server). */
export function StoredPhotoImage({ photoId, ...rest }: StoredPhotoImageProps) {
  const blob = useLibrarySelect(selectPendingBlob(photoId));
  useEffect(() => {
    if (photoId) {
      void photoStore.ensureLocal(photoId);
    }
  }, [photoId]);
  return <MemoryBlobImage blob={blob} {...rest} />;
}
