export interface EncodedImage {
  mediaType: string;
  base64: string;
}

const JPEG_QUALITY = 0.8;

export const IMPORT_MAX_EDGE_PX = 2048;
export const IMPORT_JPEG_QUALITY = 0.85;

/**
 * `from-image` because iPhone photos record their rotation in EXIF rather than
 * in the pixels, and drawing to a canvas would otherwise bake in the sideways
 * one with no orientation tag left to correct it.
 */
async function downscale(
  blob: Blob,
  maxDim: number,
  background?: string,
): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(blob, {
    imageOrientation: 'from-image',
  });
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d')!;
  if (background) {
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(bitmap, 0, 0, width, height);
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
 * Photos for recipe import: long edge 2048 px, which is enough for handwriting.
 * Gemini's HIGH media resolution bills a photo the same at any size, so larger
 * only costs upload and server memory. White behind transparent PNGs, because
 * JPEG turns transparency black.
 */
export async function encodeImageForImport(blob: Blob): Promise<EncodedImage> {
  const prefix = 'data:image/jpeg;base64,';
  try {
    const canvas = await downscale(blob, IMPORT_MAX_EDGE_PX, '#fff');
    const dataUrl = canvas.toDataURL('image/jpeg', IMPORT_JPEG_QUALITY);
    if (!dataUrl.startsWith(prefix)) throw new Error('not a JPEG data URL');
    return { mediaType: 'image/jpeg', base64: dataUrl.slice(prefix.length) };
  } catch {
    throw new Error('That image could not be encoded.');
  }
}

/**
 * The same downscale as a JPEG blob, for photos we keep rather than send. The
 * originals are several megabytes each.
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
