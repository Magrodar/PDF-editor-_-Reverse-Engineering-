import type { Overlay, PageRef, Rotation } from '../types';

export const totalRotation = (p: PageRef): Rotation =>
  (((p.baseRotation + p.userRotation) % 360) as Rotation);

/** Size of the page as displayed (after rotation), in points. */
export function viewSize(p: PageRef): { w: number; h: number } {
  const r = totalRotation(p);
  return r === 90 || r === 270 ? { w: p.height, h: p.width } : { w: p.width, h: p.height };
}

/**
 * Matrix [a b c d e f] mapping "view space with y up" (origin bottom-left of the
 * displayed page) to PDF user space, for a crop box at (x0, y0) with unrotated
 * size w x h and the given /Rotate value. Overlays are drawn inside this matrix,
 * so they always appear upright to the reader no matter how the page is rotated.
 */
export function viewToUserMatrix(
  r: Rotation,
  x0: number,
  y0: number,
  w: number,
  h: number,
): [number, number, number, number, number, number] {
  switch (r) {
    case 0:
      return [1, 0, 0, 1, x0, y0];
    case 90:
      return [0, 1, -1, 0, x0 + w, y0];
    case 180:
      return [-1, 0, 0, -1, x0 + w, y0 + h];
    case 270:
      return [0, -1, 1, 0, x0, y0 + h];
  }
}

export function applyMatrix(
  m: [number, number, number, number, number, number],
  x: number,
  y: number,
): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/**
 * When the user rotates a page 90° clockwise, move every overlay so it stays on
 * the same spot of the page content, while keeping text and images upright.
 * `oldW/oldH` are the view size before rotating.
 */
export function rotateOverlayCW(o: Overlay, oldW: number, oldH: number): Overlay {
  const pt = (x: number, y: number): [number, number] => [oldH - y, x];
  void oldW;
  switch (o.type) {
    case 'text': {
      const approxH = o.fontSize * 1.5;
      const [cx, cy] = pt(o.x + o.w / 2, o.y + approxH / 2);
      const cover = o.cover
        ? (() => {
            const [ccx, ccy] = pt(o.cover.x + o.cover.w / 2, o.cover.y + o.cover.h / 2);
            return { ...o.cover, x: ccx - o.cover.h / 2, y: ccy - o.cover.w / 2, w: o.cover.h, h: o.cover.w };
          })()
        : undefined;
      return { ...o, x: cx - o.w / 2, y: cy - approxH / 2, cover };
    }
    case 'image':
    case 'note': {
      const w = o.type === 'image' ? o.w : 0;
      const h = o.type === 'image' ? o.h : 0;
      const [cx, cy] = pt(o.x + w / 2, o.y + h / 2);
      return { ...o, x: cx - w / 2, y: cy - h / 2 };
    }
    case 'rect':
    case 'ellipse':
    case 'highlight':
    case 'whiteout': {
      const [nx, ny] = pt(o.x, o.y + o.h);
      return { ...o, x: nx, y: ny, w: o.h, h: o.w };
    }
    case 'line':
    case 'arrow': {
      const [x1, y1] = pt(o.x1, o.y1);
      const [x2, y2] = pt(o.x2, o.y2);
      return { ...o, x1, y1, x2, y2 };
    }
    case 'ink':
      return { ...o, strokes: o.strokes.map((s) => s.map(([x, y]) => pt(x, y))) };
  }
}

export function overlayBounds(o: Overlay): { x: number; y: number; w: number; h: number } {
  switch (o.type) {
    case 'text':
      return { x: o.x, y: o.y, w: o.w, h: o.fontSize * 1.5 };
    case 'note':
      return { x: o.x, y: o.y, w: 22, h: 22 };
    case 'line':
    case 'arrow':
      return {
        x: Math.min(o.x1, o.x2),
        y: Math.min(o.y1, o.y2),
        w: Math.abs(o.x2 - o.x1),
        h: Math.abs(o.y2 - o.y1),
      };
    case 'ink': {
      const pts = o.strokes.flat();
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    }
    default:
      return { x: o.x, y: o.y, w: o.w, h: o.h };
  }
}

export function translateOverlay(o: Overlay, dx: number, dy: number): Overlay {
  switch (o.type) {
    case 'line':
    case 'arrow':
      return { ...o, x1: o.x1 + dx, y1: o.y1 + dy, x2: o.x2 + dx, y2: o.y2 + dy };
    case 'ink':
      return { ...o, strokes: o.strokes.map((s) => s.map(([x, y]) => [x + dx, y + dy] as [number, number])) };
    case 'text':
      return {
        ...o,
        x: o.x + dx,
        y: o.y + dy,
        cover: o.cover ? { ...o.cover, x: o.cover.x + dx, y: o.cover.y + dy } : undefined,
      };
    default:
      return { ...o, x: o.x + dx, y: o.y + dy };
  }
}

export function hexToRgb01(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full.slice(0, 6), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
