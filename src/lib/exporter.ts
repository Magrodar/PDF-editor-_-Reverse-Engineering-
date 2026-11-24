// Writes the user's edits into a real PDF using pdf-lib.
//
// Strategy (why it is built this way):
// * If the output is exactly the original document's pages in the original
//   order, we edit THAT document in place. This keeps everything we do not
//   touch: bookmarks, links, metadata, untouched form fields, attachments.
// * Otherwise (pages deleted / reordered / merged / blank pages) we build a new
//   document and copy pages into it.
// * Every overlay is appended to the page's content stream inside a coordinate
//   transform (see geometry.viewToUserMatrix), so placement is correct even on
//   rotated pages or pages whose crop box does not start at 0,0.
import fontkit from '@pdf-lib/fontkit';
import {
  BlendMode,
  LineCapStyle,
  PDFArray,
  PDFDict,
  PDFRef,
  PDFDocument,
  PDFFont,
  PDFHexString,
  PDFName,
  PDFPage,
  PDFString,
  concatTransformationMatrix,
  degrees,
  popGraphicsState,
  pushGraphicsState,
  rgb,
} from 'pdf-lib';
import type { DocState, FormField, FormValue, ImageOverlay, Overlay, PageRef, SourceDoc, TextOverlay } from '../types';
import { applyMatrix, hexToRgb01, totalRotation, viewSize, viewToUserMatrix } from './geometry';
import { visualRuns, wrapText, baseDirection } from './bidi';

export const LINE_HEIGHT = 1.5;

export type FontKey = 'cairo' | 'cairo-bold' | 'amiri' | 'amiri-bold';
export type FontBytes = Record<FontKey, Uint8Array>;

export interface ExportInput {
  docs: Record<string, SourceDoc>;
  state: DocState;
  fonts: FontBytes;
  formFields: Record<string, FormField[]>; // pageId -> fields shown on that page
  pageIds?: string[]; // export only these pages (in document order)
  onWarning?: (message: string) => void;
}

interface FontInfo {
  font: PDFFont;
  has: (codePoint: number) => boolean;
  ascent: number; // fraction of 1em
  descent: number; // positive fraction of 1em
}

class FontCache {
  private cache = new Map<FontKey, FontInfo>();
  readonly missing = new Set<string>();
  constructor(private doc: PDFDocument, private bytes: FontBytes) {}
  async get(key: FontKey): Promise<FontInfo> {
    let f = this.cache.get(key);
    if (!f) {
      const font = await this.doc.embedFont(this.bytes[key], { subset: true });
      const fk = fontkit.create(this.bytes[key] as unknown as Parameters<typeof fontkit.create>[0]);
      f = {
        font,
        has: (cp) => fk.hasGlyphForCodePoint(cp),
        ascent: fk.ascent / fk.unitsPerEm,
        descent: Math.abs(fk.descent) / fk.unitsPerEm,
      };
      this.cache.set(key, f);
    }
    return f;
  }
}

export const fontKeyFor = (o: { font: 'cairo' | 'amiri'; bold: boolean }): FontKey =>
  `${o.font}${o.bold ? '-bold' : ''}` as FontKey;

function color(hex: string) {
  const [r, g, b] = hexToRgb01(hex);
  return rgb(r, g, b);
}

/** Width of a logical line once laid out (shaped, bidi-reordered). */
export function lineWidth(font: PDFFont, line: string, size: number): number {
  return visualRuns(line).reduce((w, r) => w + font.widthOfTextAtSize(r.text, size), 0);
}

/**
 * Draw multi-line, mixed Arabic/English text into a box. `top` is in y-down
 * view space; `viewH` converts to the y-up space the page is drawn in.
 */
/** Drop characters the font cannot draw (they would print as empty boxes). */
function supported(fi: FontInfo, text: string, missing: Set<string>): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    // keep whitespace and invisible bidi/joiner marks; fontkit handles them
    if (/\s/.test(ch) || (cp >= 0x200b && cp <= 0x200f) || fi.has(cp)) out += ch;
    else missing.add(ch);
  }
  return out;
}

function drawTextBlock(
  page: PDFPage,
  fi: FontInfo,
  rawText: string,
  box: { x: number; top: number; w: number },
  size: number,
  hex: string,
  align: 'auto' | 'left' | 'center' | 'right',
  viewH: number,
  lineHeight = LINE_HEIGHT,
  missing: Set<string> = new Set(),
) {
  const text = supported(fi, rawText, missing);
  const lh = size * lineHeight;
  const measure = (s: string) => lineWidth(fi.font, s, size);
  const lines = wrapText(text, box.w, measure);
  const c = color(hex);
  // Same baseline position a browser uses for a line box: half-leading on top.
  const baselineOffset = (lh - (fi.ascent + fi.descent) * size) / 2 + fi.ascent * size;
  lines.forEach((line, i) => {
    if (!line) return;
    const runs = visualRuns(line);
    const lw = runs.reduce((w, r) => w + fi.font.widthOfTextAtSize(r.text, size), 0);
    let a = align;
    if (a === 'auto') a = baseDirection(line) === 'rtl' ? 'right' : 'left';
    let x = box.x;
    if (a === 'right') x = box.x + box.w - lw;
    else if (a === 'center') x = box.x + (box.w - lw) / 2;
    const y = viewH - (box.top + i * lh + baselineOffset);
    for (const r of runs) {
      page.drawText(r.text, { x, y, size, font: fi.font, color: c });
      x += fi.font.widthOfTextAtSize(r.text, size);
    }
  });
}

function dataUrlBytes(dataUrl: string): { bytes: Uint8Array; png: boolean } {
  const m = /^data:image\/(png|jpe?g);base64,(.*)$/.exec(dataUrl);
  if (!m) throw new Error('Unsupported image format (use PNG or JPEG)');
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, png: m[1] === 'png' };
}

async function drawOverlay(page: PDFPage, o: Overlay, viewH: number, fonts: FontCache, images: Map<string, unknown>) {
  const Y = (y: number) => viewH - y; // y-down view -> y-up drawing space
  switch (o.type) {
    case 'whiteout':
    case 'rect':
    case 'highlight':
    case 'ellipse': {
      const fill = o.fill ? color(o.fill) : undefined;
      const stroke = o.type === 'rect' || o.type === 'ellipse' ? color(o.stroke) : undefined;
      const bw = stroke ? o.strokeWidth : 0;
      if (o.type === 'ellipse') {
        page.drawEllipse({
          x: o.x + o.w / 2,
          y: Y(o.y + o.h / 2),
          xScale: o.w / 2,
          yScale: o.h / 2,
          color: fill,
          borderColor: stroke,
          borderWidth: bw,
        });
      } else {
        page.drawRectangle({
          x: o.x,
          y: Y(o.y + o.h),
          width: o.w,
          height: o.h,
          color: o.type === 'highlight' ? color(o.fill ?? '#ffe500') : fill,
          opacity: o.type === 'highlight' ? 0.4 : undefined,
          blendMode: o.type === 'highlight' ? BlendMode.Multiply : undefined,
          borderColor: stroke,
          borderWidth: bw,
        });
      }
      return;
    }
    case 'line':
    case 'arrow': {
      const c = color(o.stroke);
      page.drawLine({
        start: { x: o.x1, y: Y(o.y1) },
        end: { x: o.x2, y: Y(o.y2) },
        thickness: o.strokeWidth,
        color: c,
        lineCap: LineCapStyle.Round,
      });
      if (o.type === 'arrow') {
        const ang = Math.atan2(Y(o.y2) - Y(o.y1), o.x2 - o.x1);
        const len = Math.max(8, o.strokeWidth * 4);
        for (const s of [-1, 1]) {
          const a = ang + Math.PI - s * (Math.PI / 7);
          page.drawLine({
            start: { x: o.x2, y: Y(o.y2) },
            end: { x: o.x2 + len * Math.cos(a), y: Y(o.y2) + len * Math.sin(a) },
            thickness: o.strokeWidth,
            color: c,
            lineCap: LineCapStyle.Round,
          });
        }
      }
      return;
    }
    case 'ink': {
      for (const s of o.strokes) {
        if (s.length === 0) continue;
        const pts = s.length === 1 ? [s[0], [s[0][0] + 0.01, s[0][1]] as [number, number]] : s;
        // drawSvgPath uses y-down coordinates from the given origin
        const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
        page.drawSvgPath(d, {
          x: 0,
          y: viewH,
          borderColor: color(o.stroke),
          borderWidth: o.strokeWidth,
          borderLineCap: LineCapStyle.Round,
        });
      }
      return;
    }
    case 'image': {
      const io = o as ImageOverlay;
      let img = images.get(io.dataUrl) as Awaited<ReturnType<PDFDocument['embedPng']>> | undefined;
      if (!img) {
        const { bytes, png } = dataUrlBytes(io.dataUrl);
        img = png ? await page.doc.embedPng(bytes) : await page.doc.embedJpg(bytes);
        images.set(io.dataUrl, img);
      }
      page.drawImage(img, { x: io.x, y: Y(io.y + io.h), width: io.w, height: io.h });
      return;
    }
    case 'text': {
      const t = o as TextOverlay;
      if (t.cover) {
        page.drawRectangle({
          x: t.cover.x,
          y: Y(t.cover.y + t.cover.h),
          width: t.cover.w,
          height: t.cover.h,
          color: color(t.cover.color),
        });
      }
      if (!t.text.trim()) return;
      const fi = await fonts.get(fontKeyFor(t));
      drawTextBlock(page, fi, t.text, { x: t.x, top: t.y, w: t.w }, t.fontSize, t.color, t.align, viewH, LINE_HEIGHT, fonts.missing);
      return;
    }
    case 'note':
      return; // written as a real PDF annotation afterwards
  }
}

function addNoteAnnotation(page: PDFPage, m: ReturnType<typeof viewToUserMatrix>, viewH: number, x: number, y: number, text: string) {
  const ctx = page.doc.context;
  const [ax, ay] = applyMatrix(m, x, viewH - y);
  const [bx, by] = applyMatrix(m, x + 22, viewH - y - 22);
  const rect = [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
  const annot = ctx.obj({
    Type: 'Annot',
    Subtype: 'Text',
    Rect: rect,
    Contents: PDFHexString.fromText(text),
    Name: 'Comment',
    C: [1, 0.82, 0.2],
    F: 4,
    M: PDFString.fromDate(new Date()),
  });
  const ref = ctx.register(annot);
  let annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  if (!annots) {
    annots = ctx.obj([]);
    page.node.set(PDFName.of('Annots'), annots);
  }
  annots.push(ref);
}

async function drawFormValue(page: PDFPage, f: FormField, value: FormValue, viewH: number, fonts: FontCache) {
  const { x, y, w, h } = f.rect;
  if (f.kind === 'checkbox' || f.kind === 'radio') {
    const on = f.kind === 'checkbox' ? value === true : value === f.exportValue;
    if (!on) return;
    const s = Math.min(w, h);
    const cx = x + w / 2;
    const cy = y + h / 2;
    if (f.kind === 'radio') {
      page.drawEllipse({ x: cx, y: viewH - cy, xScale: s * 0.28, yScale: s * 0.28, color: rgb(0, 0, 0) });
    } else {
      const d = `M${cx - s * 0.32},${cy} L${cx - s * 0.08},${cy + s * 0.25} L${cx + s * 0.34},${cy - s * 0.28}`;
      page.drawSvgPath(d, { x: 0, y: viewH, borderColor: rgb(0, 0, 0), borderWidth: Math.max(1, s * 0.12) });
    }
    return;
  }
  const text = String(value ?? '');
  if (!text.trim()) return;
  const fi = await fonts.get('cairo');
  const size = f.multiline ? Math.min(11, h * 0.6) : Math.max(6, Math.min(12, h * 0.62));
  const lines = f.multiline ? 1.25 : 1.2;
  const top = f.multiline ? y + 2 : y + (h - size * lines) / 2;
  drawTextBlock(page, fi, text, { x: x + 2, top, w: w - 4 }, size, '#000000', 'auto', viewH, lines, fonts.missing);
}

function isInPlace(pages: PageRef[], docs: Record<string, SourceDoc>, srcCounts: Record<string, number>): string | null {
  if (pages.length === 0 || pages.some((p) => p.blank)) return null;
  const docId = pages[0].docId;
  if (!docs[docId] || pages.some((p) => p.docId !== docId)) return null;
  if (pages.length !== srcCounts[docId]) return null;
  return pages.every((p, i) => p.srcIndex === i) ? docId : null;
}

async function loadDoc(src: SourceDoc): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(src.bytes, { updateMetadata: false });
  } catch (e) {
    if (String(e).includes('encrypted')) {
      throw new Error(
        `"${src.name}" is password-protected / encrypted. It can be viewed but not saved with edits yet.`,
      );
    }
    throw e;
  }
}

/**
 * Remove fields the user changed, so the old appearance does not show under the
 * new value we draw. Unchanged fields stay fillable.
 */
function removeChangedFields(doc: PDFDocument, names: Set<string>) {
  if (names.size === 0) return;
  try {
    const form = doc.getForm();
    for (const name of names) {
      const field = form.getFieldMaybe(name);
      if (field) {
        try {
          form.removeField(field);
        } catch {
          /* keep going; worst case the old value shows under the new one */
        }
      }
    }
  } catch {
    /* no form */
  }
  pruneDanglingRefs(doc);
}

/**
 * pdf-lib's removeField deletes the field objects but can leave references to
 * them in page /Annots and parent /Kids arrays. Strict readers then complain
 * ("Invalid XRef entry"), so drop every reference that no longer resolves.
 */
export function pruneDanglingRefs(doc: PDFDocument) {
  const ctx = doc.context;
  const keys = ['Annots', 'Kids', 'Fields'].map((k) => PDFName.of(k));
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    for (const key of keys) {
      const arr = obj.lookupMaybe(key, PDFArray);
      if (!arr) continue;
      for (let i = arr.size() - 1; i >= 0; i--) {
        const item = arr.get(i);
        if (item instanceof PDFRef && !ctx.lookup(item)) arr.remove(i);
      }
    }
  }
}

export async function exportPdf(input: ExportInput): Promise<Uint8Array> {
  const { docs, state, fonts: fontBytes, formFields } = input;
  const pages = input.pageIds
    ? state.pages.filter((p) => input.pageIds!.includes(p.id))
    : state.pages;
  if (pages.length === 0) throw new Error('There are no pages to save.');

  // Which form fields changed (per source document)?
  const changedByDoc = new Map<string, Set<string>>();
  const changedFields: { page: PageRef; field: FormField; value: FormValue }[] = [];
  for (const p of pages) {
    for (const f of formFields[p.id] ?? []) {
      const v = state.formValues[f.key];
      if (v === undefined || v === f.initial) continue;
      changedFields.push({ page: p, field: f, value: v });
      if (!changedByDoc.has(p.docId)) changedByDoc.set(p.docId, new Set());
      changedByDoc.get(p.docId)!.add(f.fieldName);
    }
  }

  const loaded = new Map<string, PDFDocument>();
  const getSrc = async (docId: string) => {
    let d = loaded.get(docId);
    if (!d) {
      d = await loadDoc(docs[docId]);
      removeChangedFields(d, changedByDoc.get(docId) ?? new Set());
      loaded.set(docId, d);
    }
    return d;
  };

  const srcCounts: Record<string, number> = {};
  for (const id of Object.keys(docs)) srcCounts[id] = -1;
  const inPlaceId = (() => {
    const first = pages[0];
    return first && !first.blank ? first.docId : null;
  })();
  let out: PDFDocument;
  let outPages: PDFPage[];
  if (inPlaceId) {
    const d = await getSrc(inPlaceId);
    srcCounts[inPlaceId] = d.getPageCount();
  }
  if (inPlaceId && isInPlace(pages, docs, srcCounts)) {
    out = await getSrc(inPlaceId);
    outPages = out.getPages();
  } else {
    out = await PDFDocument.create();
    outPages = [];
    for (const p of pages) {
      if (p.blank) {
        outPages.push(out.addPage([p.width, p.height]));
        continue;
      }
      const src = await getSrc(p.docId);
      const [copied] = await out.copyPages(src, [p.srcIndex]);
      outPages.push(out.addPage(copied));
    }
    const firstDoc = pages.find((p) => !p.blank);
    if (firstDoc) {
      const title = docs[firstDoc.docId].name.replace(/\.pdf$/i, '');
      out.setTitle(title);
    }
  }
  out.registerFontkit(fontkit);
  out.setProducer('Nour PDF');
  out.setModificationDate(new Date());

  const fontCache = new FontCache(out, fontBytes);
  const images = new Map<string, unknown>();

  for (let i = 0; i < pages.length; i++) {
    const ref = pages[i];
    const page = outPages[i];
    const r = totalRotation(ref);
    page.setRotation(degrees(r));
    const overlays = state.overlays[ref.id] ?? [];
    const fields = changedFields.filter((c) => c.page.id === ref.id);
    if (overlays.length === 0 && fields.length === 0) continue;

    const crop = page.getCropBox();
    const m = viewToUserMatrix(r, crop.x, crop.y, crop.width, crop.height);
    const { h: viewH } = viewSize({ ...ref, width: crop.width, height: crop.height });

    // Isolate the original content so its graphics state cannot leak into ours.
    page.node.normalize();
    const start = out.context.contentStream([pushGraphicsState()]);
    const end = out.context.contentStream([popGraphicsState()]);
    page.node.wrapContentStreams(out.context.register(start), out.context.register(end));

    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...m));
    for (const o of overlays) await drawOverlay(page, o, viewH, fontCache, images);
    for (const { field, value } of fields) await drawFormValue(page, field, value, viewH, fontCache);
    page.pushOperators(popGraphicsState());

    for (const o of overlays) {
      if (o.type === 'note' && o.text.trim()) addNoteAnnotation(page, m, viewH, o.x, o.y, o.text);
    }
  }

  if (fontCache.missing.size && input.onWarning) {
    input.onWarning(
      `These characters are not in the font and were left out: ${[...fontCache.missing].join(' ')}`,
    );
  }
  return out.save({ useObjectStreams: true });
}
