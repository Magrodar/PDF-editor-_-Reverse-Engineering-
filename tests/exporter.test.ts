import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import { exportPdf, type FontBytes } from '../src/lib/exporter';
import { visualRuns } from '../src/lib/bidi';
import type { DocState, PageRef, Rotation } from '../src/types';

const font = (f: string) => new Uint8Array(readFileSync(`src/assets/fonts/${f}`));
const fonts: FontBytes = {
  cairo: font('Cairo_400Regular.ttf'),
  'cairo-bold': font('Cairo_700Bold.ttf'),
  amiri: font('Amiri_400Regular.ttf'),
  'amiri-bold': font('Amiri_700Bold.ttf'),
};
// 1x1 red PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

async function sourcePdf() {
  const d = await PDFDocument.create();
  const hf = await d.embedFont(StandardFonts.Helvetica);
  const rots: Rotation[] = [0, 90, 180, 270];
  for (const r of rots) {
    const p = d.addPage([400, 300]);
    p.setCropBox(20, 10, 360, 280); // crop box not at origin on purpose
    p.setRotation(degrees(r));
    p.drawText(`page rot ${r} - TOP-LEFT marker`, { x: 30, y: 270, size: 10, font: hf, color: rgb(0.4, 0.4, 0.4) });
  }
  return d.save();
}

describe('bidi', () => {
  it('orders mixed text visually', () => {
    const runs = visualRuns('Hello 2026 مرحبا');
    expect(runs.map((r) => r.text)).toEqual(['Hello 2026 ', 'مرحبا']);
    const ar = visualRuns('عقد رقم 15 لسنة 2026');
    // In an Arabic sentence numbers are LTR islands; visual order starts at the far left (end of sentence)
    expect(ar[0].text).toBe('2026');
    expect(ar[ar.length - 1].rtl).toBe(true);
  });
});

describe('exportPdf', () => {
  it('draws overlays upright on rotated, cropped pages', async () => {
    const bytes = await sourcePdf();
    const pages: PageRef[] = ([0, 90, 180, 270] as Rotation[]).map((r, i) => ({
      id: `p${i}`, docId: 'd', srcIndex: i, baseRotation: r, userRotation: 0, width: 360, height: 280,
    }));
    const overlays: DocState['overlays'] = {};
    for (const p of pages) {
      overlays[p.id] = [
        { id: 't', type: 'text', x: 10, y: 10, w: 230, text: 'الطرف الأول: محمود (Planning Head)\nعقد رقم 15 لسنة 2026', fontSize: 14, color: '#1a3d8f', font: 'cairo', bold: false, align: 'auto' },
        { id: 'i', type: 'image', x: 10, y: 80, w: 40, h: 20, dataUrl: PNG, signature: true },
        { id: 'r', type: 'rect', x: 60, y: 80, w: 60, h: 20, stroke: '#000000', fill: null, strokeWidth: 1 },
        { id: 'h', type: 'highlight', x: 130, y: 80, w: 60, h: 20, stroke: '#ffe500', fill: '#ffe500', strokeWidth: 0 },
        { id: 'a', type: 'arrow', x1: 10, y1: 130, x2: 120, y2: 130, stroke: '#d00000', strokeWidth: 2 },
        { id: 'k', type: 'ink', strokes: [[[130, 130], [150, 115], [170, 140]]], stroke: '#007700', strokeWidth: 2 },
        { id: 'n', type: 'note', x: 200, y: 120, text: 'ملاحظة' },
      ];
    }
    const out = await exportPdf({
      docs: { d: { id: 'd', name: 'src.pdf', bytes: new Uint8Array(bytes) } },
      state: { pages, overlays, formValues: {} },
      fonts,
      formFields: {},
    });
    expect(out.length).toBeGreaterThan(1000);
    const reloaded = await PDFDocument.load(out);
    expect(reloaded.getPageCount()).toBe(4);
    if (process.env.EXPORT_OUT) writeFileSync(process.env.EXPORT_OUT, out);
  });

  it('reorders, deletes, adds blank pages and applies user rotation', async () => {
    const bytes = await sourcePdf();
    const mk = (i: number, userRotation: Rotation, extra: Partial<PageRef> = {}): PageRef => ({
      id: `q${i}`, docId: 'd', srcIndex: i, baseRotation: ([0, 90, 180, 270] as Rotation[])[i], userRotation, width: 360, height: 280, ...extra,
    });
    const pages = [mk(2, 0), mk(0, 90), { ...mk(0, 0), id: 'blank', blank: true, docId: '', width: 595, height: 842 }];
    const out = await exportPdf({
      docs: { d: { id: 'd', name: 'src.pdf', bytes: new Uint8Array(bytes) } },
      state: { pages, overlays: { blank: [{ id: 'x', type: 'text', x: 50, y: 50, w: 300, text: 'صفحة جديدة', fontSize: 20, color: '#000000', font: 'amiri', bold: true, align: 'auto' }] }, formValues: {} },
      fonts,
      formFields: {},
    });
    const reloaded = await PDFDocument.load(out);
    expect(reloaded.getPageCount()).toBe(3);
    expect(reloaded.getPage(1).getRotation().angle).toBe(90);
    if (process.env.EXPORT_OUT2) writeFileSync(process.env.EXPORT_OUT2, out);
  });
});

describe('bidi brackets', () => {
  it('mirrors brackets around English inside Arabic', () => {
    const runs = visualRuns('محمود (Planning Head)');
    expect(runs.map((r) => r.text)).toEqual(['(', 'Planning Head', 'محمود )']);
  });
});

describe('form filling', () => {
  it('removes changed fields cleanly (no dangling references)', async () => {
    const { PDFArray, PDFDict, PDFRef } = await import('pdf-lib');
    const src = await PDFDocument.create();
    const p = src.addPage([400, 300]);
    const form = src.getForm();
    form.createTextField('name').addToPage(p, { x: 50, y: 200, width: 200, height: 20 });
    form.createCheckBox('ok').addToPage(p, { x: 50, y: 150, width: 14, height: 14 });
    form.createTextField('untouched').addToPage(p, { x: 50, y: 100, width: 200, height: 20 });
    const bytes = await src.save();
    const pages: PageRef[] = [{ id: 'p', docId: 'd', srcIndex: 0, baseRotation: 0, userRotation: 0, width: 400, height: 300 }];
    const out = await exportPdf({
      docs: { d: { id: 'd', name: 'f.pdf', bytes } },
      state: { pages, overlays: {}, formValues: { 'd|name': 'محمود Mahmoud', 'd|ok': true } },
      fonts,
      formFields: {
        p: [
          { key: 'd|name', annotId: 'a', fieldName: 'name', kind: 'text', rect: { x: 50, y: 80, w: 200, h: 20 }, initial: '' },
          { key: 'd|ok', annotId: 'b', fieldName: 'ok', kind: 'checkbox', rect: { x: 50, y: 136, w: 14, h: 14 }, initial: false },
        ],
      },
    });
    const doc = await PDFDocument.load(out);
    const names = doc.getForm().getFields().map((f) => f.getName());
    expect(names).toEqual(['untouched']); // untouched field stays fillable
    const ctx = doc.context;
    for (const [, obj] of ctx.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFDict)) continue;
      for (const [, v] of obj.entries()) {
        if (v instanceof PDFArray) v.asArray().forEach((x) => x instanceof PDFRef && expect(ctx.lookup(x)).toBeDefined());
      }
    }
  });
});

describe('unsupported characters', () => {
  it('drops glyphs missing from the font and warns', async () => {
    const src = await PDFDocument.create();
    src.addPage([300, 200]);
    const warnings: string[] = [];
    await exportPdf({
      docs: { d: { id: 'd', name: 'x.pdf', bytes: await src.save() } },
      state: {
        pages: [{ id: 'p', docId: 'd', srcIndex: 0, baseRotation: 0, userRotation: 0, width: 300, height: 200 }],
        overlays: { p: [{ id: 't', type: 'text', x: 10, y: 10, w: 200, text: 'تم ✓ OK', fontSize: 12, color: '#000000', font: 'cairo', bold: false, align: 'auto' }] },
        formValues: {},
      },
      fonts,
      formFields: {},
      onWarning: (m) => warnings.push(m),
    });
    expect(warnings[0]).toContain('✓');
  });
});
