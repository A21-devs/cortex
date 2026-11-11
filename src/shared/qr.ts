/**
 * A small QR Code encoder (ISO 18004), byte mode, error correction level M, versions 1 to 6 (up to 106 bytes): enough for a
 * key share's text. The output is a module matrix and an SVG string; nothing is fetched and nothing is stored. Checked by
 * decoding the images with an independent reader (tests/qr.test.ts holds the structure checks; the decoder run is in the
 * package notes). Pure TypeScript.
 */

/** [error-correction codewords per block, blocks, data codewords per block] for level M. */
const LEVEL_M: Readonly<Record<number, readonly [number, number, number]>> = {
  1: [10, 1, 16],
  2: [16, 1, 28],
  3: [26, 1, 44],
  4: [18, 2, 32],
  5: [24, 2, 43],
  6: [16, 4, 27],
};
export const QR_MAX_VERSION = 6;

/** The most bytes one code of the largest supported version holds. */
export function qrCapacity(version: number): number {
  const e = LEVEL_M[version];
  if (!e) return 0;
  return Math.floor((e[1] * e[2] * 8 - 12) / 8);
}

function gmul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 255;
}

function divisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gmul(result[j] as number, root);
      if (j + 1 < degree) result[j] = (result[j] as number) ^ (result[j + 1] as number);
    }
    root = gmul(root, 2);
  }
  return result;
}

function remainder(data: readonly number[], div: readonly number[]): number[] {
  const result = new Array<number>(div.length).fill(0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    for (let i = 0; i < div.length; i++) result[i] = (result[i] as number) ^ gmul(div[i] as number, factor);
  }
  return result;
}

const bit = (v: number, i: number): boolean => ((v >>> i) & 1) !== 0;

function maskFn(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function penalty(m: readonly (readonly boolean[])[]): number {
  const n = m.length;
  let score = 0;
  const lines: boolean[][] = [];
  for (let i = 0; i < n; i++) {
    lines.push([...(m[i] as boolean[])]);
    lines.push(m.map((row) => row[i] as boolean));
  }
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= n; i++) {
      if (i < n && line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    const s = line.map((d) => (d ? "1" : "0")).join("");
    for (const pat of ["10111010000", "00001011101"]) for (let i = s.indexOf(pat); i >= 0; i = s.indexOf(pat, i + 1)) score += 40;
  }
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) {
    const c = (m[y] as boolean[])[x];
    if (c === (m[y] as boolean[])[x + 1] && c === (m[y + 1] as boolean[])[x] && c === (m[y + 1] as boolean[])[x + 1]) score += 3;
  }
  let dark = 0;
  for (const row of m) for (const d of row) if (d) dark++;
  const total = n * n;
  score += Math.max(0, Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/** The module matrix (true = dark) for `text` encoded as UTF-8 bytes, or null when it does not fit in version 6. */
export function qrMatrix(text: string): boolean[][] | null {
  const bytes = new TextEncoder().encode(text);
  let version = 0;
  for (let v = 1; v <= QR_MAX_VERSION; v++) {
    if (bytes.length <= qrCapacity(v)) {
      version = v;
      break;
    }
  }
  if (version === 0) return null;
  const [ecLen, blocks, per] = LEVEL_M[version] as readonly [number, number, number];
  const dataLen = blocks * per;

  // data codewords: mode 0100, 8-bit count, the bytes, terminator, padding
  const bits: number[] = [];
  const push = (v: number, len: number): void => {
    for (let i = len - 1; i >= 0; i--) bits.push((v >>> i) & 1);
  };
  push(4, 4);
  push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, dataLen * 8 - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  for (let pad = 0xec; data.length < dataLen; pad ^= 0xec ^ 0x11) data.push(pad);

  // error correction per block, then interleave
  const div = divisor(ecLen);
  const dataBlocks: number[][] = [];
  for (let b = 0; b < blocks; b++) dataBlocks.push(data.slice(b * per, (b + 1) * per));
  const ecBlocks = dataBlocks.map((d) => remainder(d, div));
  const all: number[] = [];
  for (let i = 0; i < per; i++) for (const d of dataBlocks) all.push(d[i] as number);
  for (let i = 0; i < ecLen; i++) for (const e of ecBlocks) all.push(e[i] as number);

  const size = version * 4 + 17;
  const modules: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fn: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const setFn = (x: number, y: number, dark: boolean): void => {
    (modules[y] as boolean[])[x] = dark;
    (fn[y] as boolean[])[x] = true;
  };
  for (let i = 0; i < size; i++) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }
  const finder = (cx: number, cy: number): void => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      const x = cx + dx;
      const y = cy + dy;
      if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, dist !== 2 && dist !== 4);
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  if (version >= 2) {
    const c = size - 7;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFn(c + dx, c + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  const formatBits = (mask: number): number => {
    const d = (0 << 3) | mask; // level M = 00
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((d << 10) | rem) ^ 0x5412;
  };
  const drawFormat = (mask: number): void => {
    const f = formatBits(mask);
    for (let i = 0; i <= 5; i++) setFn(8, i, bit(f, i));
    setFn(8, 7, bit(f, 6));
    setFn(8, 8, bit(f, 7));
    setFn(7, 8, bit(f, 8));
    for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(f, i));
    for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(f, i));
    for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(f, i));
    setFn(8, size - 8, true);
  };
  drawFormat(0); // reserves the format areas so the data skips them

  // data, zigzag from the bottom right
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!(fn[y] as boolean[])[x] && i < all.length * 8) {
          (modules[y] as boolean[])[x] = bit(all[i >>> 3] as number, 7 - (i & 7));
          i++;
        }
      }
    }
  }

  // the best mask by penalty
  let bestMask = 0;
  let bestScore = Infinity;
  let best: boolean[][] = modules;
  for (let mask = 0; mask < 8; mask++) {
    const trial = modules.map((row) => [...row]);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!(fn[y] as boolean[])[x] && maskFn(mask, x, y)) (trial[y] as boolean[])[x] = !(trial[y] as boolean[])[x];
    // draw this mask's format bits on the trial
    const f = formatBits(mask);
    const put = (x: number, y: number, d: boolean): void => {
      (trial[y] as boolean[])[x] = d;
    };
    for (let k = 0; k <= 5; k++) put(8, k, bit(f, k));
    put(8, 7, bit(f, 6));
    put(8, 8, bit(f, 7));
    put(7, 8, bit(f, 8));
    for (let k = 9; k < 15; k++) put(14 - k, 8, bit(f, k));
    for (let k = 0; k < 8; k++) put(size - 1 - k, 8, bit(f, k));
    for (let k = 8; k < 15; k++) put(8, size - 15 + k, bit(f, k));
    put(8, size - 8, true);
    const score = penalty(trial);
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
      best = trial;
    }
  }
  void bestMask;
  return best;
}

/** An SVG of the code with a 4-module quiet zone. `title` becomes the image's accessible name. */
export function qrSvg(matrix: readonly (readonly boolean[])[], opts: { title?: string; dark?: string; light?: string; px?: number } = {}): string {
  const n = matrix.length;
  const q = 4;
  const dark = opts.dark ?? "#000";
  const light = opts.light ?? "#fff";
  let d = "";
  for (let y = 0; y < n; y++) {
    let x = 0;
    while (x < n) {
      if (!(matrix[y] as boolean[])[x]) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < n && (matrix[y] as boolean[])[x + run]) run++;
      d += `M${x + q} ${y + q}h${run}v1h${-run}z`;
      x += run;
    }
  }
  const total = n + q * 2;
  const size = opts.px ? ` width="${opts.px}" height="${opts.px}"` : "";
  const title = opts.title ? `<title>${opts.title.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</title>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}"${size} role="img" shape-rendering="crispEdges">${title}<rect width="${total}" height="${total}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
}
