// Copies the pdf.js runtime data (CMaps, standard fonts, wasm decoders) into public/
// so they ship with the app and work offline.
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'pdfjs-dist');
const dest = join(root, 'public', 'pdfjs');
mkdirSync(dest, { recursive: true });
for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
  cpSync(join(src, dir), join(dest, dir), { recursive: true });
}
console.log('pdf.js assets copied to public/pdfjs');
