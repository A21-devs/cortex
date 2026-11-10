/** An ICO file from PNG buffers: `size` is the pixel side of each square image (256 is stored as 0). */
export function packIco(entries: readonly { size: number; png: Buffer }[]): Buffer;
