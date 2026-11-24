// Thin wrapper around pdf.js (Mozilla's PDF renderer, the same one Firefox uses).
// pdf.js parses the file and paints pages onto <canvas>. We never modify the
// document with it; editing is done by our overlay layer + pdf-lib on save.
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { FormField, FormValue, Rotation } from '../types';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const assetBase = new URL('./pdfjs/', document.baseURI).href;

const proxies = new Map<string, Promise<PDFDocumentProxy>>();

export function loadPdfjs(docId: string, bytes: Uint8Array, password?: string): Promise<PDFDocumentProxy> {
  let p = proxies.get(docId);
  if (!p) {
    p = pdfjs.getDocument({
      data: bytes.slice(), // pdf.js transfers (detaches) the buffer, so give it a copy
      password,
      cMapUrl: assetBase + 'cmaps/',
      cMapPacked: true,
      standardFontDataUrl: assetBase + 'standard_fonts/',
      wasmUrl: assetBase + 'wasm/',
      isEvalSupported: false,
    }).promise;
    proxies.set(docId, p);
    p.catch(() => proxies.delete(docId));
  }
  return p;
}

export const PasswordException = 'PasswordException';

export async function getPage(docId: string, index: number): Promise<PDFPageProxy> {
  const doc = await proxies.get(docId);
  if (!doc) throw new Error('document not loaded');
  return doc.getPage(index + 1);
}

/** Render a page into a canvas at the given zoom; returns a cancel function. */
export function renderPage(
  page: PDFPageProxy,
  canvas: HTMLCanvasElement,
  zoom: number,
  rotation: Rotation,
): { promise: Promise<void>; cancel: () => void } {
  const dpr = window.devicePixelRatio || 1;
  const viewport = page.getViewport({ scale: zoom * dpr, rotation });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const task = page.render({ canvasContext: ctx, viewport });
  return {
    promise: task.promise.catch((e: unknown) => {
      if ((e as { name?: string })?.name !== 'RenderingCancelledException') throw e;
    }),
    cancel: () => task.cancel(),
  };
}

export interface TextItemBox {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  bold: boolean;
  serif: boolean;
}

/** Positioned text runs of a page in view space (for "Edit existing text"). */
export async function getTextBoxes(page: PDFPageProxy, rotation: Rotation): Promise<TextItemBox[]> {
  const vp = page.getViewport({ scale: 1, rotation });
  const content = await page.getTextContent();
  const out: TextItemBox[] = [];
  for (const item of content.items) {
    if (!('str' in item) || !item.str.trim()) continue;
    const [a, b, , , e, f] = item.transform as number[];
    const size = Math.hypot(a, b) || item.height;
    if (Math.abs(b) > 0.01 * Math.abs(a)) continue; // skip rotated/vertical text
    const style = content.styles[item.fontName];
    const desc = size * 0.25;
    const rect = vp.convertToViewportRectangle([e, f - desc, e + item.width, f + size * 0.95]);
    const x = Math.min(rect[0], rect[2]);
    const y = Math.min(rect[1], rect[3]);
    const fam = (style?.fontFamily ?? '') + ' ' + item.fontName;
    out.push({
      str: item.str,
      x,
      y,
      w: Math.abs(rect[2] - rect[0]),
      h: Math.abs(rect[3] - rect[1]),
      fontSize: size,
      bold: /bold|black|heavy/i.test(fam),
      serif: /serif|times|naskh|amiri|traditional/i.test(fam) && !/sans/i.test(fam),
    });
  }
  return out;
}

interface RawAnnotation {
  id: string;
  subtype: string;
  fieldType?: string;
  fieldName?: string;
  fieldValue?: unknown;
  rect: number[];
  checkBox?: boolean;
  radioButton?: boolean;
  multiLine?: boolean;
  options?: { exportValue: string; displayValue: string }[];
  exportValue?: string;
  buttonValue?: string;
  readOnly?: boolean;
  pushButton?: boolean;
  hidden?: boolean;
}

/** Fillable form fields (AcroForm widgets) on a page, in view space. */
export async function getFormFields(page: PDFPageProxy, rotation: Rotation, docId: string): Promise<FormField[]> {
  const vp = page.getViewport({ scale: 1, rotation });
  const annots = (await page.getAnnotations()) as RawAnnotation[];
  const out: FormField[] = [];
  for (const a of annots) {
    if (a.subtype !== 'Widget' || !a.fieldName || a.pushButton || a.hidden) continue;
    const r = vp.convertToViewportRectangle(a.rect);
    const rect = {
      x: Math.min(r[0], r[2]),
      y: Math.min(r[1], r[3]),
      w: Math.abs(r[2] - r[0]),
      h: Math.abs(r[3] - r[1]),
    };
    const key = `${docId}|${a.fieldName}`;
    let kind: FormField['kind'];
    let initial: FormValue;
    let exportValue: string | undefined;
    if (a.fieldType === 'Tx') {
      kind = 'text';
      initial = typeof a.fieldValue === 'string' ? a.fieldValue : '';
    } else if (a.fieldType === 'Btn' && a.checkBox) {
      kind = 'checkbox';
      exportValue = a.exportValue;
      initial = !!a.fieldValue && a.fieldValue !== 'Off';
    } else if (a.fieldType === 'Btn' && a.radioButton) {
      kind = 'radio';
      exportValue = a.buttonValue;
      initial = typeof a.fieldValue === 'string' ? a.fieldValue : '';
    } else if (a.fieldType === 'Ch') {
      kind = 'choice';
      const v = Array.isArray(a.fieldValue) ? a.fieldValue[0] : a.fieldValue;
      initial = typeof v === 'string' ? v : '';
    } else continue;
    out.push({
      key,
      annotId: a.id,
      fieldName: a.fieldName,
      kind,
      rect,
      multiline: a.multiLine,
      options: a.options?.map((o) => o.displayValue ?? o.exportValue),
      exportValue,
      initial,
      readOnly: a.readOnly,
    });
  }
  return out;
}

export async function releaseDoc(docId: string) {
  const p = proxies.get(docId);
  proxies.delete(docId);
  if (p) (await p.catch(() => null))?.destroy();
}
