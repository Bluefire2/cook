export interface EncodedImage {
  mediaType: string;
  base64: string;
}

const JPEG_QUALITY = 0.8;

/**
 * `from-image` because iPhone photos record their rotation in EXIF rather than
 * in the pixels, and drawing to a canvas would otherwise bake in the sideways
 * one with no orientation tag left to correct it.
 */
async function downscale(blob: Blob, maxDim: number): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(blob, {
    imageOrientation: 'from-image',
  });
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return canvas;
}

/**
 * Downscales a photo to at most `maxDim` on its long edge and re-encodes as
 * JPEG, so we don't send multi-megabyte camera originals to the LLM.
 */
export async function encodeImageForChat(
  blob: Blob,
  maxDim = 1280,
): Promise<EncodedImage> {
  const canvas = await downscale(blob, maxDim);
  const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  return {
    mediaType: 'image/jpeg',
    base64: dataUrl.slice(dataUrl.indexOf(',') + 1),
  };
}

/**
 * The same downscale as a JPEG blob, for photos we keep rather than send. The
 * originals are several megabytes each and the IndexedDB quota is finite.
 */
export async function encodeImageForStorage(
  blob: Blob,
  maxDim = 1280,
): Promise<Blob> {
  const canvas = await downscale(blob, maxDim);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (encoded) =>
        encoded
          ? resolve(encoded)
          : reject(new Error('That image could not be encoded.')),
      'image/jpeg',
      JPEG_QUALITY,
    );
  });
}
