export interface EncodedImage {
  mediaType: string;
  base64: string;
}

/**
 * Downscales a photo to at most `maxDim` on its long edge and re-encodes as
 * JPEG, so we don't send multi-megabyte camera originals to the LLM.
 */
export async function encodeImageForChat(
  blob: Blob,
  maxDim = 1280,
): Promise<EncodedImage> {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
  return {
    mediaType: 'image/jpeg',
    base64: dataUrl.slice(dataUrl.indexOf(',') + 1),
  };
}
