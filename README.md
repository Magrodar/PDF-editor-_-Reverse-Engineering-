# Nour PDF

A personal desktop PDF editor (Windows / macOS / Linux) with full Arabic support.
Built from the open PDF standard (ISO 32000) and open-source libraries, not by copying Adobe Acrobat.

## Main use case: sign a contract without printing

1. **Open** the PDF (or right-click the file → *Open with* → Nour PDF).
2. Click **Sign** → **From scan / photo** → choose your scanned signature.
   The white or grey paper is removed automatically, the image is cropped, and you can recolour the ink to black or blue.
   Leave *Save to "My signatures"* ticked, and next time it is one click away.
3. Click on the page where the signature goes. Drag to move it; drag the corner to resize.
   Use **Place on all pages** for initials on every page.
4. **Save**. The first save always asks for a new file name (`<name>_edited.pdf`), so the original is never overwritten by accident.

## Features

| Area | What you can do |
|---|---|
| Signature | Import a scanned or photographed signature with automatic background removal, draw one with the mouse, keep a reusable library, place it on all pages |
| Text | Add text anywhere in Arabic, English or both mixed (correct shaping and right-to-left order), choose Cairo (sans) or Amiri (serif), size, colour, bold, alignment |
| Edit existing text | *Edit text* outlines every text run in the PDF; click one to replace it (the old text is covered and the new text written on top) |
| Forms | Fill text fields, checkboxes, radio buttons and dropdowns, including Arabic values |
| Annotate | Highlight, freehand pen, rectangle, ellipse, line, arrow, whiteout, sticky-note comments (saved as real PDF comments) |
| Pages | Reorder (drag thumbnails), rotate, delete, insert blank page, merge other PDFs, export selected pages as a new PDF |
| General | Undo/redo, zoom (Ctrl + mouse wheel), drag and drop files, keyboard shortcuts, unsaved-changes protection |

### Keyboard shortcuts

`V` select · `E` edit text · `T` add text · `S` sign · `I` image · `H` highlight · `D` draw · `R` box · `O` ellipse · `L` line · `A` arrow · `W` whiteout · `N` comment
`Ctrl+O` open · `Ctrl+S` save · `Ctrl+Shift+S` save as · `Ctrl+Z` / `Ctrl+Y` undo / redo · `Ctrl+D` duplicate · `Del` delete selected · arrow keys nudge (Shift = 10 pt) · `Esc` cancel

## Install on Windows

Every push to GitHub builds the Windows app automatically (*Actions* tab → latest **Build desktop app** run → artifact **NourPDF-Windows**). It contains:

- `Nour PDF-<version>-setup.exe`: installer. It adds a Start-menu entry and the *Open with* association for PDFs.
- `Nour PDF-<version>-portable.exe`: runs without installing.

The app is not code-signed, so Windows SmartScreen shows *"Windows protected your PC"* the first time. Click **More info → Run anyway**.

## Build from source

Requires Node.js 20 or newer.

```bash
npm install
npm run dev        # run the app with live reload
npm test           # unit + export tests
npm run dist:win   # build Windows installer + portable into release/
npm run dist       # build for the current OS
```

## Known limitations

These are honest limits of version 0.1, not hidden bugs:

- **Edit existing text** covers the old text with a box in the sampled background colour and writes new text on top. It does not reflow paragraphs, and the font may differ from the original (the app uses Cairo or Amiri). It works best on plain backgrounds.
- **Whiteout** hides content visually; the text underneath is still in the file. It is not a secure redaction.
- **Filled form fields are flattened**: a field you change is written as text into the page and removed from the form. Fields you did not touch stay fillable.
- **Encrypted or password-protected PDFs** can be viewed, but saving edits is not supported yet.
- Characters missing from the fonts (some symbols and emoji) are left out; the app warns you which ones.
- No OCR for scanned documents, and no export to Word.

## Third-party components

| Component | Purpose | License |
|---|---|---|
| [pdf.js](https://github.com/mozilla/pdf.js) | Rendering and reading PDFs | Apache-2.0 |
| [pdf-lib](https://github.com/Hopding/pdf-lib) + fontkit | Writing PDFs, font embedding and Arabic shaping | MIT |
| [bidi-js](https://github.com/lojjic/bidi-js) | Unicode bidirectional algorithm | MIT |
| Electron, React, lucide icons | Desktop shell, UI, icons | MIT / ISC |
| Cairo, Amiri fonts | Arabic + Latin fonts embedded in saved PDFs | SIL Open Font License 1.1 |

See [`docs/HOW-IT-WORKS.md`](docs/HOW-IT-WORKS.md) for how PDFs and this editor work internally.
