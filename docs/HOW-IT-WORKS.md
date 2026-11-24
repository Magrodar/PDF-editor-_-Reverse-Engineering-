# How a PDF editor works

This is the "reverse engineering" part of the project. Adobe's code was not decompiled; its licence forbids that, and it is not needed.
The PDF format is a public ISO standard (ISO 32000-2). This document explains what is inside a PDF, why editing one is hard, and how Nour PDF is built.

---

## 1. What is inside a PDF file

A PDF is a small database of numbered **objects**, plus an index that says where each object starts in the file.

```
%PDF-1.7
1 0 obj  << /Type /Catalog /Pages 2 0 R /AcroForm 9 0 R >>        endobj   ← root
2 0 obj  << /Type /Pages /Kids [3 0 R 7 0 R] /Count 2 >>           endobj   ← page tree
3 0 obj  << /Type /Page /MediaBox [0 0 595 842] /Rotate 0
            /Resources << /Font << /F1 5 0 R >> >>
            /Contents 4 0 R /Annots [10 0 R] >>                    endobj   ← one page
4 0 obj  << /Length 44 >> stream
         BT /F1 24 Tf 72 770 Td (Hello) Tj ET                      ← drawing program
         endstream                                                 endobj
5 0 obj  << /Type /Font /Subtype /Type0 ... /ToUnicode 6 0 R >>    endobj   ← embedded font
...
xref  0 11  0000000000 65535 f  0000000017 00000 n ...                      ← index (byte offsets)
trailer << /Root 1 0 R /Size 11 >>
startxref 1234
%%EOF
```

| Building block | Meaning |
|---|---|
| Dictionary `<< /Key value >>` | Most objects; like a JSON object |
| Reference `4 0 R` | Pointer to object number 4 |
| Stream | Binary data (page drawing commands, images, fonts), usually compressed |
| `xref` + `trailer` | Index of byte positions, so a reader can jump to any object |

### A page is a drawing program, not a document

The page's **content stream** is a list of drawing instructions in a stack-based language similar to PostScript:

| Operator | Meaning |
|---|---|
| `q` / `Q` | Save / restore the graphics state |
| `cm` | Change the coordinate system (move, scale, rotate) |
| `BT … ET` | Begin / end a text object |
| `/F1 24 Tf` | Use font F1 at 24 pt |
| `72 770 Td` | Move the text cursor to (72, 770) |
| `<0012003A> Tj` | Draw these **glyph IDs**, not letters |
| `re f` | Rectangle, fill |
| `Do` | Draw an image or other XObject |

Three facts make PDFs hard to edit:

1. **No words, lines or paragraphs.** There are only glyphs at coordinates. "Hello world" might be one `Tj`, or 11 separate ones, in any order.
2. **Text is glyph IDs in a subset font.** To write a new letter, that glyph must exist in the embedded font, and a subset font usually contains only the letters already used.
3. **Arabic is stored already shaped and in visual order.** The file holds the final connected letter forms laid out left to right. The logical text is only recoverable through an optional `/ToUnicode` map.

So "edit this paragraph", as Acrobat Pro does it, means reverse-engineering the layout from coordinates, re-shaping text, and finding or replacing fonts. Acrobat has had 30 years of work on that.

### Coordinates

- The unit is the **point** (1/72 inch). A4 is 595 × 842 pt.
- The origin is at the **bottom-left** and *y* points **up** (screens have *y* pointing down).
- `/MediaBox` is the paper size; `/CropBox` is the visible area and does not have to start at (0, 0).
- `/Rotate 90` rotates the page *when displayed*; the content inside is still drawn unrotated.

### Forms and annotations

Things that "float" over a page (comments, highlights, links, form fields) are **annotations** listed in the page's `/Annots`.
A form field (AcroForm) is a *field* dictionary (name and value) plus one or more *widget* annotations (where it appears and how it looks).

---

## 2. How Acrobat-class editors are structured

Every serious PDF editor has the same three layers:

```
┌──────────────────────────────────────────────┐
│  UI: toolbar, thumbnails, tools, selection   │
├──────────────────────────────────────────────┤
│  Document model: pages, edits, undo history  │
├────────────────────┬─────────────────────────┤
│  Renderer (read)   │  Writer (save)          │
│  parse → rasterize │  modify objects → file  │
└────────────────────┴─────────────────────────┘
```

Acrobat uses Adobe's own PDF Library for both renderer and writer. Chrome uses PDFium, Firefox uses pdf.js, and Preview uses Apple's PDFKit.
The engines are interchangeable; the product is mostly the UI and the edit model.

---

## 3. Nour PDF's architecture

```
electron/main.cjs        Desktop shell: window, menus, native file dialogs,
                         signature library on disk, "Open with" handling
electron/preload.cjs     The ONLY bridge from UI to the operating system (12 functions)

src/lib/pdfjs.ts         READ  – pdf.js renders pages to <canvas>, finds text runs
                                 (for Edit text) and form fields
src/store.ts             MODEL – pages + overlays + form values, immutable, undo/redo
src/components/*         UI    – toolbar, page view, overlay editing, thumbnails, dialogs
src/lib/exporter.ts      WRITE – pdf-lib writes every edit into the real PDF on save
src/lib/bidi.ts          Arabic/English bidirectional layout for writing text
src/lib/geometry.ts      Coordinate conversions, including rotated pages
```

### Key design decision: non-destructive overlays

The original file bytes are **never modified while you work**. Every edit (text, signature, shape) is an *overlay* object in the model, shown as an HTML element on top of the rendered page.
Only when you save does the exporter write the overlays into a new PDF. This gives:

- unlimited undo/redo (the model is immutable; each edit is a new snapshot),
- instant rendering, because pages are not re-rendered after each edit,
- safety: the original file stays untouched until you choose where to save.

### Saving: in place vs. rebuild

- If the pages are still the original pages in the original order, the exporter edits **that** document. Bookmarks, links, metadata and untouched form fields survive.
- If pages were deleted, reordered, merged or added, it builds a new document and copies pages into it.

Overlays are appended to each page's content stream as `q <matrix> cm … Q`.
The matrix (`viewToUserMatrix`) maps "what the user sees" to PDF user space for every `/Rotate` value and crop-box offset. That is why a signature lands exactly where you dropped it even on a sideways scanned page.

### Arabic text: the hard part

Writing Arabic into a PDF needs three steps that a browser normally does for you:

1. **Bidirectional algorithm (UBA, Unicode Annex #9).** `"عقد رقم 15 (Planning)"` contains right-to-left and left-to-right runs. `bidi-js` resolves the levels; `visualRuns()` reorders the runs into left-to-right drawing order and mirrors brackets: `(` inside Arabic becomes `)`.
2. **Shaping.** Each Arabic letter has up to four forms (isolated, initial, medial, final) plus ligatures such as `لا`. fontkit applies the font's OpenType GSUB tables.
3. **Embedding.** Only the glyphs used are embedded (subsetting), with a ToUnicode map, so the saved text stays searchable and copyable.

Fonts: **Cairo** (modern sans) and **Amiri** (classic Naskh serif), both under the SIL Open Font License, which allows embedding.

### "Edit text": what it really does

pdf.js extracts positioned text runs. When you click one, the app:

1. samples the page pixels around the run to find the background colour,
2. creates a *cover* rectangle in that colour over the old text,
3. opens a text box with the old text, at the same size and position, in Cairo or Amiri.

This is the same approach most lightweight editors use. True in-place editing (changing the original glyphs and reflowing a paragraph) would need content-stream rewriting and font-subset extension; that is the biggest gap from Acrobat Pro.

### Signatures from a scan

`cleanSignature()` converts luminance to transparency with a soft edge (no jagged outline), crops to the ink bounding box, and optionally recolours the ink.
Result: a transparent PNG that sits naturally on any document. It is stored in the app's data folder (`%APPDATA%/Nour PDF/signatures` on Windows).

Note: this is a **visual** signature (an image), like a wet signature that has been scanned.
It is not a cryptographic **digital signature** (PKI certificate per ISO 32000 §12.8 / PAdES). That would be a separate feature.

---

## 4. Testing

- `tests/exporter.test.ts`: bidi ordering, bracket mirroring, overlays on all four rotations with an offset crop box, page reorder/delete/blank/rotate, form filling with no dangling objects, missing-glyph warnings.
- End-to-end runs (Playwright) drove the real UI: open → import a scanned signature → place → add Arabic text → fill form → edit existing text → highlight → rotate → save. The saved PDF was rendered with Poppler and compared with the screen.
- The Electron app was launched headless to check "Open with", the signature library on disk, renderer isolation (no Node.js in the page), and saving through the native dialog path.

---

## 5. Possible next steps (in order of value)

1. Password-protected PDFs: decrypt on open and save edits.
2. Arabic UI language.
3. Real-font text editing (reuse the original embedded font when it has the needed glyphs).
4. Secure redaction (remove the content underneath, not only cover it).
5. OCR for scanned documents (Tesseract with the Arabic model).
6. Cryptographic digital signatures (PAdES) with a certificate.
