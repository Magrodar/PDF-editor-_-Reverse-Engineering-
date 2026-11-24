import {
  ArrowUpRight,
  Circle,
  Eraser,
  FolderOpen,
  Highlighter,
  ImagePlus,
  Minus,
  MousePointer2,
  PenLine,
  Pencil,
  Redo2,
  Save,
  Signature,
  Square,
  StickyNote,
  TextCursorInput,
  Type,
  Undo2,
  ZoomIn,
  ZoomOut,
  MoveHorizontal,
} from 'lucide-react';
import type { Tool } from '../types';
import { redo, setState, setTool, toast, undo, useStore } from '../store';
import { openFiles, save, saveAs } from '../actions';
import { platform } from '../platform';
import { normalizeImage } from '../lib/image';
import { fitWidth, stepZoom } from './Viewer';

const TOOLS: { tool: Tool; label: string; icon: React.ReactNode; hint: string; key?: string }[] = [
  { tool: 'select', label: 'Select', icon: <MousePointer2 size={18} />, hint: 'Select, move and resize (V)', key: 'v' },
  { tool: 'edittext', label: 'Edit text', icon: <TextCursorInput size={18} />, hint: 'Click existing text in the PDF to change it (E)', key: 'e' },
  { tool: 'text', label: 'Add text', icon: <Type size={18} />, hint: 'Click anywhere to type (T)', key: 't' },
  { tool: 'signature', label: 'Sign', icon: <Signature size={18} />, hint: 'Place your signature (S)', key: 's' },
  { tool: 'image', label: 'Image', icon: <ImagePlus size={18} />, hint: 'Insert a picture (I)', key: 'i' },
  { tool: 'highlight', label: 'Highlight', icon: <Highlighter size={18} />, hint: 'Drag over text to highlight (H)', key: 'h' },
  { tool: 'ink', label: 'Draw', icon: <Pencil size={18} />, hint: 'Free-hand pen (D)', key: 'd' },
  { tool: 'rect', label: 'Box', icon: <Square size={18} />, hint: 'Rectangle (R)', key: 'r' },
  { tool: 'ellipse', label: 'Circle', icon: <Circle size={18} />, hint: 'Ellipse (O)', key: 'o' },
  { tool: 'line', label: 'Line', icon: <Minus size={18} />, hint: 'Straight line (L)', key: 'l' },
  { tool: 'arrow', label: 'Arrow', icon: <ArrowUpRight size={18} />, hint: 'Arrow (A)', key: 'a' },
  { tool: 'whiteout', label: 'Whiteout', icon: <Eraser size={18} />, hint: 'Cover something with white (W)', key: 'w' },
  { tool: 'note', label: 'Comment', icon: <StickyNote size={18} />, hint: 'Sticky-note comment (N)', key: 'n' },
];

export const TOOL_KEYS = Object.fromEntries(TOOLS.filter((t) => t.key).map((t) => [t.key!, t.tool]));

export async function chooseTool(tool: Tool, openSignature: () => void) {
  if (tool === 'signature') {
    openSignature();
    return;
  }
  if (tool === 'image') {
    const d = await platform.openImage();
    if (!d) return;
    try {
      const img = await normalizeImage(d);
      setState({ pendingImage: { ...img, signature: false } });
      setTool('image');
      toast('Click on the page to place the image.');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
    return;
  }
  setTool(tool);
  if (tool === 'edittext') toast('Click on any text in the PDF to replace it.');
}

export function Toolbar({ openSignature }: { openSignature: () => void }) {
  const tool = useStore((s) => s.tool);
  const zoom = useStore((s) => s.zoom);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const hasDoc = useStore((s) => s.doc.pages.length > 0);
  const dirty = useStore((s) => s.dirty);
  const fileName = useStore((s) => s.fileName);

  return (
    <header className="toolbar">
      <div className="brand" title="Nour PDF">
        <PenLine size={18} />
        <span>Nour PDF</span>
      </div>
      <div className="group">
        <button className="tb" title="Open (Ctrl+O)" onClick={async () => openFiles(await platform.openPdfs(true))}>
          <FolderOpen size={18} />
          <span>Open</span>
        </button>
        <button className="tb" title="Save (Ctrl+S)" disabled={!hasDoc} onClick={() => save()}>
          <Save size={18} />
          <span>Save</span>
        </button>
        <button className="tb ghost" title="Save as a new file (Ctrl+Shift+S)" disabled={!hasDoc} onClick={() => saveAs()}>
          <span>Save as…</span>
        </button>
      </div>
      <div className="sep" />
      <div className="group tools">
        {TOOLS.map((t) => (
          <button
            key={t.tool}
            className={`tb tool${tool === t.tool ? ' on' : ''}`}
            title={t.hint}
            disabled={!hasDoc}
            onClick={() => chooseTool(t.tool, openSignature)}
          >
            {t.icon}
            <span>{t.label}</span>
          </button>
        ))}
      </div>
      <div className="sep" />
      <div className="group">
        <button className="tb icon" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={undo}>
          <Undo2 size={18} />
        </button>
        <button className="tb icon" title="Redo (Ctrl+Y)" disabled={!canRedo} onClick={redo}>
          <Redo2 size={18} />
        </button>
      </div>
      <div className="spacer" />
      <div className="group zoom">
        <button className="tb icon" title="Zoom out (Ctrl -)" disabled={!hasDoc} onClick={() => stepZoom(-1)}>
          <ZoomOut size={18} />
        </button>
        <span className="zoom-val">{Math.round(zoom * 100)}%</span>
        <button className="tb icon" title="Zoom in (Ctrl +)" disabled={!hasDoc} onClick={() => stepZoom(1)}>
          <ZoomIn size={18} />
        </button>
        <button className="tb icon" title="Fit width (Ctrl 0)" disabled={!hasDoc} onClick={fitWidth}>
          <MoveHorizontal size={18} />
        </button>
      </div>
      {fileName && (
        <div className="file-name" title={fileName}>
          {fileName}
          {dirty && <span className="dot" title="Unsaved changes" />}
        </div>
      )}
    </header>
  );
}
