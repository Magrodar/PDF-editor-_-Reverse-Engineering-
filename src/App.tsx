import { useEffect, useState } from 'react';
import { FileText, FolderOpen, Signature, Loader2 } from 'lucide-react';
import { Toolbar, TOOL_KEYS, chooseTool } from './components/Toolbar';
import { PropsBar, duplicateSelected } from './components/PropsBar';
import { Sidebar } from './components/Sidebar';
import { Viewer, fitWidth, stepZoom } from './components/Viewer';
import { SignatureDialog } from './components/SignatureDialog';
import { appendFiles, exportSelectedPages, openFiles, save, saveAs } from './actions';
import { platform, type OpenedFile } from './platform';
import { deleteOverlay, getState, redo, setState, setTool, undo, updateOverlay, useStore } from './store';
import { translateOverlay } from './lib/geometry';

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

export function App() {
  const hasDoc = useStore((s) => s.doc.pages.length > 0);
  const toast = useStore((s) => s.toast);
  const busy = useStore((s) => s.busy);
  const [sigOpen, setSigOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const runCommand = async (cmd: string) => {
    switch (cmd) {
      case 'open':
        return openFiles(await platform.openPdfs(true));
      case 'append':
        return appendFiles(await platform.openPdfs(true));
      case 'save':
        return save();
      case 'saveAs':
        return saveAs();
      case 'exportSelected':
        return exportSelectedPages();
      case 'undo':
      case 'redo': {
        // inside a text box, undo/redo the typing instead of the document
        const el = document.activeElement as HTMLElement | null;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
          document.execCommand(cmd);
          return;
        }
        return cmd === 'undo' ? undo() : redo();
      }
      case 'zoomIn':
        return stepZoom(1);
      case 'zoomOut':
        return stepZoom(-1);
      case 'fitWidth':
        return fitWidth();
    }
  };

  // Desktop integration: menu commands, "Open with", close confirmation.
  useEffect(() => {
    const d = window.desktop;
    if (!d) return;
    d.initialFile().then((f) => f && openFiles([f]));
    const offs = [
      d.onMenu((cmd) => runCommand(cmd)),
      d.onOpenFile((f: OpenedFile) => openFiles([f])),
      d.onCloseRequested(() => {
        if (!getState().dirty || window.confirm('You have unsaved changes. Close without saving?')) d.confirmClose();
      }),
    ];
    return () => offs.forEach((o) => o());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (window.desktop) return;
    const h = (e: BeforeUnloadEvent) => {
      if (getState().dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, []);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const s = getState();
      if (mod && !e.altKey) {
        const k = e.key.toLowerCase();
        // in the desktop app the menu handles these accelerators
        const menuHandles = !!window.desktop;
        if (k === 's') {
          e.preventDefault();
          if (!menuHandles) e.shiftKey ? saveAs() : save();
          return;
        }
        if (k === 'o') {
          e.preventDefault();
          if (!menuHandles) runCommand('open');
          return;
        }
        if (isTyping(e)) return;
        if (k === 'z' && !e.shiftKey) {
          e.preventDefault();
          if (!menuHandles) undo();
        } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
          e.preventDefault();
          if (!menuHandles || k === 'z') redo();
        } else if (k === 'd') {
          e.preventDefault();
          duplicateSelected();
        } else if (k === '=' || k === '+') {
          e.preventDefault();
          if (!menuHandles) stepZoom(1);
        } else if (k === '-') {
          e.preventDefault();
          if (!menuHandles) stepZoom(-1);
        } else if (k === '0') {
          e.preventDefault();
          if (!menuHandles) fitWidth();
        }
        return;
      }
      if (isTyping(e)) return;
      if (e.key === 'Escape') {
        if (s.selected || s.editingId) setState({ selected: null, editingId: null });
        else setTool('select');
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && s.selected) {
        e.preventDefault();
        deleteOverlay(s.selected.pageId, s.selected.id);
        return;
      }
      if (e.key === 'Enter' && s.selected) {
        const o = s.doc.overlays[s.selected.pageId]?.find((x) => x.id === s.selected!.id);
        if (o?.type === 'text' || o?.type === 'note') {
          e.preventDefault();
          setState({ editingId: o.id });
        }
        return;
      }
      if (e.key.startsWith('Arrow') && s.selected) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        updateOverlay(s.selected.pageId, s.selected.id, (o) => translateOverlay(o, dx, dy));
        return;
      }
      if (!e.altKey && s.doc.pages.length && TOOL_KEYS[e.key.toLowerCase()]) {
        chooseTool(TOOL_KEYS[e.key.toLowerCase()], () => setSigOpen(true));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drag & drop PDFs from the file explorer.
  const onDrop = async (e: React.DragEvent) => {
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
    if (!files.length) return;
    e.preventDefault();
    const opened = await Promise.all(files.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })));
    if (getState().doc.pages.length) appendFiles(opened);
    else openFiles(opened);
  };

  return (
    <div
      className="app"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={onDrop}
    >
      <Toolbar openSignature={() => setSigOpen(true)} />
      {hasDoc && <PropsBar />}
      <main className="main">
        {hasDoc ? (
          <>
            <Sidebar />
            <Viewer />
          </>
        ) : (
          <div className="welcome">
            <FileText size={56} strokeWidth={1.2} />
            <h1>Nour PDF</h1>
            <p>Open a PDF to sign it, fill it, add or change text, annotate, and rearrange pages.</p>
            <button className="btn primary big" onClick={() => runCommand('open')}>
              <FolderOpen size={18} /> Open PDF…
            </button>
            <p className="muted">or drop PDF files here</p>
            <div className="welcome-tips">
              <div>
                <Signature size={18} /> <b>Sign a contract:</b> Open → Sign → import your scanned signature once → click where it goes → Save.
              </div>
            </div>
          </div>
        )}
      </main>
      {dragOver && <div className="drop-hint">{hasDoc ? 'Drop to add these pages to the end' : 'Drop to open'}</div>}
      {sigOpen && <SignatureDialog onClose={() => setSigOpen(false)} />}
      {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
      {busy && (
        <div className="busy">
          <Loader2 className="spin" size={18} /> {busy}
        </div>
      )}
    </div>
  );
}
