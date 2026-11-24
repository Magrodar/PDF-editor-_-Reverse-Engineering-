// Small global store with undo/redo. The document model (pages, overlays, form
// values) is immutable; every edit produces a new DocState and the previous one
// goes on the undo stack. The original PDF bytes are never changed.
import { useSyncExternalStore } from 'react';
import type { DocState, FontFamily, FormField, Overlay, PageRef, SourceDoc, Tool } from './types';
import { rotateOverlayCW, viewSize } from './lib/geometry';

export interface ToolStyle {
  color: string;
  strokeWidth: number;
  fontSize: number;
  font: FontFamily;
  bold: boolean;
  highlight: string;
}

export interface AppState {
  docs: Record<string, SourceDoc>;
  doc: DocState;
  past: DocState[];
  future: DocState[];
  tool: Tool;
  style: ToolStyle;
  zoom: number;
  selectedPages: string[];
  selected: { pageId: string; id: string } | null;
  editingId: string | null; // text overlay currently being typed into
  pendingImage: { dataUrl: string; w: number; h: number; signature: boolean } | null;
  fileName: string | null;
  savePath: string | null; // where "Save" writes (never the original unless chosen)
  dirty: boolean;
  formFields: Record<string, FormField[]>;
  currentPage: number;
  toast: { text: string; kind: 'info' | 'error' } | null;
  busy: string | null;
}

const emptyDoc: DocState = { pages: [], overlays: {}, formValues: {} };

let state: AppState = {
  docs: {},
  doc: emptyDoc,
  past: [],
  future: [],
  tool: 'select',
  style: { color: '#1a1a1a', strokeWidth: 2, fontSize: 14, font: 'cairo', bold: false, highlight: '#ffe500' },
  zoom: 1,
  selectedPages: [],
  selected: null,
  editingId: null,
  pendingImage: null,
  fileName: null,
  savePath: null,
  dirty: false,
  formFields: {},
  currentPage: 0,
  toast: null,
  busy: null,
};

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const getState = () => state;
export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  emit();
}

export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => selector(state),
  );
}

const MAX_HISTORY = 200;

/** Apply an undoable change to the document. */
export function commit(fn: (d: DocState) => DocState) {
  const next = fn(state.doc);
  if (next === state.doc) return;
  setState({
    doc: next,
    past: [...state.past.slice(-MAX_HISTORY + 1), state.doc],
    future: [],
    dirty: true,
  });
}

export function undo() {
  const prev = state.past[state.past.length - 1];
  if (!prev) return;
  setState({ doc: prev, past: state.past.slice(0, -1), future: [state.doc, ...state.future], selected: null, editingId: null, dirty: true });
}

export function redo() {
  const next = state.future[0];
  if (!next) return;
  setState({ doc: next, past: [...state.past, state.doc], future: state.future.slice(1), selected: null, editingId: null, dirty: true });
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

// ---------- overlay helpers ----------
export function addOverlay(pageId: string, o: Overlay, select = true) {
  commit((d) => ({ ...d, overlays: { ...d.overlays, [pageId]: [...(d.overlays[pageId] ?? []), o] } }));
  if (select) setState({ selected: { pageId, id: o.id } });
}

export function updateOverlay(pageId: string, id: string, fn: (o: Overlay) => Overlay) {
  commit((d) => {
    const list = d.overlays[pageId] ?? [];
    let changed = false;
    const next = list.map((o) => {
      if (o.id !== id) return o;
      const n = fn(o);
      if (n !== o) changed = true;
      return n;
    });
    return changed ? { ...d, overlays: { ...d.overlays, [pageId]: next } } : d;
  });
}

export function deleteOverlay(pageId: string, id: string) {
  commit((d) => ({ ...d, overlays: { ...d.overlays, [pageId]: (d.overlays[pageId] ?? []).filter((o) => o.id !== id) } }));
  setState((s) => ({ selected: s.selected?.id === id ? null : s.selected, editingId: s.editingId === id ? null : s.editingId }));
}

export function findOverlay(pageId: string, id: string): Overlay | undefined {
  return state.doc.overlays[pageId]?.find((o) => o.id === id);
}

// ---------- page operations ----------
export function rotatePages(ids: string[], clockwise: boolean) {
  commit((d) => {
    const overlays = { ...d.overlays };
    const pages = d.pages.map((p) => {
      if (!ids.includes(p.id)) return p;
      const turns = clockwise ? 1 : 3;
      let cur: PageRef = p;
      for (let t = 0; t < turns; t++) {
        const { w, h } = viewSize(cur);
        overlays[p.id] = (overlays[p.id] ?? []).map((o) => rotateOverlayCW(o, w, h));
        cur = { ...cur, userRotation: ((cur.userRotation + 90) % 360) as PageRef['userRotation'] };
      }
      return cur;
    });
    return { ...d, pages, overlays };
  });
}

export function deletePages(ids: string[]) {
  if (ids.length >= state.doc.pages.length) {
    toast('A PDF needs at least one page.', 'error');
    return;
  }
  commit((d) => {
    const overlays = { ...d.overlays };
    ids.forEach((id) => delete overlays[id]);
    return { ...d, pages: d.pages.filter((p) => !ids.includes(p.id)), overlays };
  });
  setState({ selectedPages: [], selected: null });
}

export function movePages(ids: string[], beforeIndex: number) {
  commit((d) => {
    const moving = d.pages.filter((p) => ids.includes(p.id));
    const before = d.pages.slice(0, beforeIndex).filter((p) => !ids.includes(p.id));
    const after = d.pages.slice(beforeIndex).filter((p) => !ids.includes(p.id));
    const pages = [...before, ...moving, ...after];
    return pages.every((p, i) => p === d.pages[i]) ? d : { ...d, pages };
  });
}

export function insertBlankPage(afterIndex: number) {
  const ref = state.doc.pages[afterIndex] ?? state.doc.pages[0];
  const size = ref ? viewSize(ref) : { w: 595, h: 842 };
  const page: PageRef = {
    id: uid(),
    docId: '',
    srcIndex: 0,
    baseRotation: 0,
    userRotation: 0,
    width: size.w,
    height: size.h,
    blank: true,
  };
  commit((d) => {
    const pages = [...d.pages];
    pages.splice(afterIndex + 1, 0, page);
    return { ...d, pages };
  });
  return page.id;
}

export function setFormValue(key: string, value: string | boolean) {
  commit((d) => (d.formValues[key] === value ? d : { ...d, formValues: { ...d.formValues, [key]: value } }));
}

// ---------- misc ----------
let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(text: string, kind: 'info' | 'error' = 'info') {
  setState({ toast: { text, kind } });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => setState({ toast: null }), kind === 'error' ? 7000 : 3500);
}

export function setTool(tool: Tool) {
  setState({ tool, selected: null, editingId: null, pendingImage: tool === 'signature' || tool === 'image' ? state.pendingImage : null });
}
