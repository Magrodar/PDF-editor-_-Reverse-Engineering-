import { PDFDocument } from 'pdf-lib';
import cairoUrl from './assets/fonts/Cairo_400Regular.ttf?url';
import cairoBoldUrl from './assets/fonts/Cairo_700Bold.ttf?url';
import amiriUrl from './assets/fonts/Amiri_400Regular.ttf?url';
import amiriBoldUrl from './assets/fonts/Amiri_700Bold.ttf?url';
import { exportPdf, type FontBytes } from './lib/exporter';
import { loadPdfjs, releaseDoc } from './lib/pdfjs';
import { platform, type OpenedFile } from './platform';
import { commit, getState, setState, toast, uid } from './store';
import type { PageRef, Rotation, SourceDoc } from './types';

let fontsPromise: Promise<FontBytes> | null = null;
function loadFonts(): Promise<FontBytes> {
  if (!fontsPromise) {
    const get = async (u: string) => new Uint8Array(await (await fetch(u)).arrayBuffer());
    fontsPromise = Promise.all([get(cairoUrl), get(cairoBoldUrl), get(amiriUrl), get(amiriBoldUrl)]).then(
      ([cairo, cairoBold, amiri, amiriBold]) => ({ cairo, 'cairo-bold': cairoBold, amiri, 'amiri-bold': amiriBold }),
    );
    fontsPromise.catch(() => (fontsPromise = null));
  }
  return fontsPromise;
}

async function readPages(file: OpenedFile): Promise<{ doc: SourceDoc; pages: PageRef[]; editable: boolean }> {
  const doc: SourceDoc = { id: uid(), name: file.name, path: file.path, bytes: file.data };
  let proxy;
  try {
    proxy = await loadPdfjs(doc.id, doc.bytes);
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (name === 'PasswordException') throw new Error(`"${file.name}" needs a password to open. Password-protected files are not supported yet.`);
    throw new Error(`"${file.name}" could not be read as a PDF.`);
  }
  const pages: PageRef[] = [];
  for (let i = 0; i < proxy.numPages; i++) {
    const p = await proxy.getPage(i + 1);
    const [x0, y0, x1, y1] = p.view;
    pages.push({
      id: uid(),
      docId: doc.id,
      srcIndex: i,
      baseRotation: (((p.rotate % 360) + 360) % 360) as Rotation,
      userRotation: 0,
      width: x1 - x0,
      height: y1 - y0,
    });
  }
  // Can pdf-lib (our writer) handle this file? Encrypted files cannot be saved.
  let editable = true;
  try {
    await PDFDocument.load(doc.bytes, { updateMetadata: false });
  } catch {
    editable = false;
  }
  return { doc, pages, editable };
}

export async function openFiles(files: OpenedFile[]) {
  if (files.length === 0) return;
  const s = getState();
  if (s.dirty && !window.confirm('You have unsaved changes. Discard them and open another file?')) return;
  setState({ busy: 'Opening…' });
  try {
    const results: Awaited<ReturnType<typeof readPages>>[] = [];
    for (const f of files) results.push(await readPages(f));
    for (const id of Object.keys(s.docs)) releaseDoc(id);
    const docs: Record<string, SourceDoc> = {};
    results.forEach((r) => (docs[r.doc.id] = r.doc));
    setState({
      docs,
      doc: { pages: results.flatMap((r) => r.pages), overlays: {}, formValues: {} },
      past: [],
      future: [],
      selected: null,
      selectedPages: [],
      editingId: null,
      fileName: files[0].name,
      savePath: null,
      dirty: files.length > 1,
      formFields: {},
      currentPage: 0,
      tool: 'select',
    });
    if (results.some((r) => !r.editable))
      toast('This PDF is encrypted/protected. You can view it, but saving edits is not supported yet.', 'error');
    if (files.length > 1) toast(`Merged ${files.length} files.`);
  } catch (e) {
    toast((e as Error).message, 'error');
  } finally {
    setState({ busy: null });
  }
}

export async function appendFiles(files: OpenedFile[], afterIndex?: number) {
  if (files.length === 0) return;
  if (getState().doc.pages.length === 0) return openFiles(files);
  setState({ busy: 'Adding pages…' });
  try {
    const results: Awaited<ReturnType<typeof readPages>>[] = [];
    for (const f of files) results.push(await readPages(f));
    setState((s) => {
      const docs = { ...s.docs };
      results.forEach((r) => (docs[r.doc.id] = r.doc));
      return { docs };
    });
    const newPages = results.flatMap((r) => r.pages);
    commit((d) => {
      const pages = [...d.pages];
      pages.splice(afterIndex === undefined ? pages.length : afterIndex + 1, 0, ...newPages);
      return { ...d, pages };
    });
    toast(`Added ${newPages.length} page${newPages.length === 1 ? '' : 's'}.`);
  } catch (e) {
    toast((e as Error).message, 'error');
  } finally {
    setState({ busy: null });
  }
}

async function build(pageIds?: string[]): Promise<Uint8Array> {
  const s = getState();
  const fonts = await loadFonts();
  return exportPdf({
    docs: s.docs,
    state: s.doc,
    fonts,
    formFields: s.formFields,
    pageIds,
    onWarning: (m) => setTimeout(() => toast(m, 'error'), 600),
  });
}

function suggestedName(suffix: string) {
  const base = (getState().fileName ?? 'document.pdf').replace(/\.pdf$/i, '');
  return base.endsWith(suffix) ? `${base}.pdf` : `${base}${suffix}.pdf`;
}

export async function save() {
  const s = getState();
  if (!s.doc.pages.length) return;
  if (!s.savePath) return saveAs();
  setState({ busy: 'Saving…' });
  try {
    const data = await build();
    await platform.write(s.savePath, data);
    setState({ dirty: false });
    toast('Saved.');
  } catch (e) {
    toast(`Save failed: ${(e as Error).message}`, 'error');
  } finally {
    setState({ busy: null });
  }
}

export async function saveAs() {
  const s = getState();
  if (!s.doc.pages.length) return;
  setState({ busy: 'Preparing PDF…' });
  try {
    const data = await build();
    setState({ busy: null });
    const res = await platform.saveAs(suggestedName('_edited'), data);
    if (res) {
      setState({ savePath: res.path ?? null, fileName: res.name, dirty: false });
      toast(`Saved as ${res.name}`);
    }
  } catch (e) {
    toast(`Save failed: ${(e as Error).message}`, 'error');
  } finally {
    setState({ busy: null });
  }
}

export async function exportSelectedPages() {
  const s = getState();
  const ids = s.selectedPages.length ? s.selectedPages : [s.doc.pages[s.currentPage]?.id].filter(Boolean);
  if (!ids.length) return;
  setState({ busy: 'Preparing PDF…' });
  try {
    const ordered = s.doc.pages.filter((p) => ids.includes(p.id)).map((p) => p.id);
    const data = await build(ordered);
    setState({ busy: null });
    const res = await platform.saveAs(suggestedName(`_pages`), data);
    if (res) toast(`Exported ${ordered.length} page${ordered.length === 1 ? '' : 's'} to ${res.name}`);
  } catch (e) {
    toast(`Export failed: ${(e as Error).message}`, 'error');
  } finally {
    setState({ busy: null });
  }
}
