// Image helpers that run in the UI (they need <canvas>).

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('Could not read this image'));
    img.src = src;
  });
}

/** Ensure the image is PNG/JPEG (what PDFs support) and not absurdly large. */
export async function normalizeImage(dataUrl: string, maxSide = 2400): Promise<{ dataUrl: string; w: number; h: number }> {
  const img = await loadImage(dataUrl);
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const isJpeg = /^data:image\/jpe?g/.test(dataUrl);
  const isPng = /^data:image\/png/.test(dataUrl);
  if (scale === 1 && (isJpeg || isPng)) return { dataUrl, w: img.naturalWidth, h: img.naturalHeight };
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * scale);
  c.height = Math.round(img.naturalHeight * scale);
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return {
    dataUrl: isJpeg ? c.toDataURL('image/jpeg', 0.9) : c.toDataURL('image/png'),
    w: c.width,
    h: c.height,
  };
}

export type InkColor = 'original' | 'black' | 'blue';

/**
 * Turn a scanned/photographed signature into a clean transparent PNG:
 *  - pixels brighter than `threshold` become transparent (paper removal),
 *  - edges get soft alpha so the ink does not look jagged,
 *  - the result is cropped to the ink, and optionally recoloured.
 */
export async function cleanSignature(
  dataUrl: string,
  threshold: number,
  ink: InkColor,
): Promise<{ dataUrl: string; w: number; h: number } | null> {
  const img = await loadImage(dataUrl);
  const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, w, h);
  const im = ctx.getImageData(0, 0, w, h);
  const d = im.data;
  const soft = 40; // width of the soft edge in brightness units
  let minX = w,
    minY = h,
    maxX = -1,
    maxY = -1;
  const target = ink === 'black' ? [20, 20, 25] : ink === 'blue' ? [16, 42, 140] : null;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      let a: number;
      if (lum >= threshold) a = 0;
      else if (lum > threshold - soft) a = (threshold - lum) / soft;
      else a = 1;
      a *= d[i + 3] / 255;
      if (a > 0.08) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      if (target) {
        d[i] = target[0];
        d[i + 1] = target[1];
        d[i + 2] = target[2];
      }
      d[i + 3] = Math.round(a * 255);
    }
  }
  if (maxX < 0) return null; // nothing left: threshold too low
  ctx.putImageData(im, 0, 0);
  const pad = 4;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad);
  maxY = Math.min(h - 1, maxY + pad);
  const out = document.createElement('canvas');
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext('2d')!.drawImage(c, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return { dataUrl: out.toDataURL('image/png'), w: out.width, h: out.height };
}

/** Sample the dominant colour around a rectangle on a rendered page canvas. */
export function sampleBackground(canvas: HTMLCanvasElement, x: number, y: number, w: number, h: number): string {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return '#ffffff';
  const pts: [number, number][] = [];
  const X0 = Math.max(0, Math.floor(x - 2));
  const Y0 = Math.max(0, Math.floor(y - 2));
  const X1 = Math.min(canvas.width - 1, Math.ceil(x + w + 2));
  const Y1 = Math.min(canvas.height - 1, Math.ceil(y + h + 2));
  for (let i = 0; i <= 10; i++) {
    const tx = Math.round(X0 + ((X1 - X0) * i) / 10);
    const ty = Math.round(Y0 + ((Y1 - Y0) * i) / 10);
    pts.push([tx, Y0], [tx, Y1], [X0, ty], [X1, ty]);
  }
  const counts = new Map<string, number>();
  for (const [px, py] of pts) {
    const [r, g, b] = ctx.getImageData(px, py, 1, 1).data;
    const key = [r, g, b].map((v) => Math.round(v / 8) * 8).map((v) => Math.min(255, v).toString(16).padStart(2, '0')).join('');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = 'ffffff';
  let n = 0;
  counts.forEach((v, k) => {
    if (v > n) {
      n = v;
      best = k;
    }
  });
  return '#' + best;
}
