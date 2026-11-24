import { AlignCenter, AlignLeft, AlignRight, Bold, Copy, Files, Trash2, AArrowDown, AArrowUp } from 'lucide-react';
import type { Overlay, TextAlign, TextOverlay } from '../types';
import { addOverlay, commit, deleteOverlay, getState, setState, uid, updateOverlay, useStore, toast } from '../store';
import { translateOverlay, viewSize } from '../lib/geometry';

const COLORS = ['#1a1a1a', '#10226e', '#1e5fd8', '#c62828', '#2e7d32', '#ef6c00', '#6a1b9a', '#ffffff'];
const HIGHLIGHTS = ['#ffe500', '#7cf27c', '#7fd3ff', '#ff9ad5', '#ffb74d'];

function Swatches({ value, colors, onPick }: { value: string; colors: string[]; onPick: (c: string) => void }) {
  return (
    <div className="swatches">
      {colors.map((c) => (
        <button key={c} className={`sw${value.toLowerCase() === c ? ' on' : ''}`} style={{ background: c }} onClick={() => onPick(c)} title={c} />
      ))}
      <label className="sw custom" title="Custom colour">
        <input type="color" value={value} onChange={(e) => onPick(e.target.value)} />
      </label>
    </div>
  );
}

export function duplicateSelected() {
  const s = getState();
  if (!s.selected) return;
  const o = s.doc.overlays[s.selected.pageId]?.find((x) => x.id === s.selected!.id);
  if (!o) return;
  addOverlay(s.selected.pageId, { ...translateOverlay(o, 12, 12), id: uid() } as Overlay);
}

/** Copy an image (e.g. initials) to the same spot on every other page. */
function placeOnAllPages(pageId: string, o: Overlay) {
  if (o.type !== 'image') return;
  const pages = getState().doc.pages;
  const src = pages.find((p) => p.id === pageId)!;
  const sv = viewSize(src);
  commit((d) => {
    const overlays = { ...d.overlays };
    for (const p of pages) {
      if (p.id === pageId) continue;
      const v = viewSize(p);
      // keep the same distance from the nearest page edges
      let x = o.x > sv.w / 2 ? v.w - (sv.w - o.x) : o.x;
      let y = o.y > sv.h / 2 ? v.h - (sv.h - o.y) : o.y;
      x = Math.min(Math.max(0, x), Math.max(0, v.w - o.w));
      y = Math.min(Math.max(0, y), Math.max(0, v.h - o.h));
      overlays[p.id] = [...(overlays[p.id] ?? []), { ...o, id: uid(), x, y }];
    }
    return { ...d, overlays };
  });
  toast(`Placed on ${pages.length - 1} other page${pages.length === 2 ? '' : 's'}.`);
}

export function PropsBar() {
  const tool = useStore((s) => s.tool);
  const style = useStore((s) => s.style);
  const sel = useStore((s) => s.selected);
  const overlay = useStore((s) => (s.selected ? s.doc.overlays[s.selected.pageId]?.find((o) => o.id === s.selected!.id) : undefined));

  const setStyle = (p: Partial<typeof style>) => setState({ style: { ...style, ...p } });
  const upd = (fn: (o: Overlay) => Overlay) => sel && updateOverlay(sel.pageId, sel.id, fn);

  // ---- an item is selected: edit that item ----
  if (overlay && sel) {
    const parts: React.ReactNode[] = [];
    if (overlay.type === 'text') {
      const t = overlay as TextOverlay;
      const updT = (p: Partial<TextOverlay>) => upd((o) => ({ ...(o as TextOverlay), ...p }));
      parts.push(
        <Swatches key="c" value={t.color} colors={COLORS} onPick={(c) => updT({ color: c })} />,
        <select key="f" value={t.font} onChange={(e) => updT({ font: e.target.value as TextOverlay['font'] })} title="Font">
          <option value="cairo">Cairo (sans)</option>
          <option value="amiri">Amiri (serif)</option>
        </select>,
        <div key="sz" className="num">
          <button className="icon-btn" title="Smaller" onClick={() => updT({ fontSize: Math.max(5, +(t.fontSize - 1).toFixed(1)) })}>
            <AArrowDown size={16} />
          </button>
          <input type="number" min={4} max={144} step={0.5} value={t.fontSize} onChange={(e) => +e.target.value > 0 && updT({ fontSize: +e.target.value })} />
          <button className="icon-btn" title="Bigger" onClick={() => updT({ fontSize: Math.min(144, +(t.fontSize + 1).toFixed(1)) })}>
            <AArrowUp size={16} />
          </button>
        </div>,
        <button key="b" className={`icon-btn${t.bold ? ' on' : ''}`} title="Bold" onClick={() => updT({ bold: !t.bold })}>
          <Bold size={16} />
        </button>,
        <div key="al" className="seg">
          {(
            [
              ['auto', 'Auto'],
              ['left', <AlignLeft size={15} key="l" />],
              ['center', <AlignCenter size={15} key="c" />],
              ['right', <AlignRight size={15} key="r" />],
            ] as [TextAlign, React.ReactNode][]
          ).map(([a, label]) => (
            <button key={a} className={t.align === a ? 'on' : ''} title={a === 'auto' ? 'Automatic (right for Arabic)' : `Align ${a}`} onClick={() => updT({ align: a })}>
              {label}
            </button>
          ))}
        </div>,
      );
      if (t.cover)
        parts.push(
          <label key="cv" className="mini" title="Colour of the box that hides the old text">
            Cover
            <input type="color" value={t.cover.color} onChange={(e) => updT({ cover: { ...t.cover!, color: e.target.value } })} />
          </label>,
        );
    } else if (overlay.type === 'highlight') {
      parts.push(<Swatches key="c" value={overlay.fill ?? '#ffe500'} colors={HIGHLIGHTS} onPick={(c) => upd((o) => ({ ...o, fill: c, stroke: c } as Overlay))} />);
    } else if (overlay.type === 'whiteout') {
      parts.push(
        <label key="c" className="mini">
          Fill
          <input type="color" value={overlay.fill ?? '#ffffff'} onChange={(e) => upd((o) => ({ ...o, fill: e.target.value } as Overlay))} />
        </label>,
      );
    } else if ('stroke' in overlay) {
      parts.push(
        <Swatches key="c" value={overlay.stroke} colors={COLORS} onPick={(c) => upd((o) => ({ ...o, stroke: c } as Overlay))} />,
        <label key="w" className="mini">
          Width
          <input type="range" min={0.5} max={12} step={0.5} value={overlay.strokeWidth} onChange={(e) => upd((o) => ({ ...o, strokeWidth: +e.target.value } as Overlay))} />
        </label>,
      );
      if (overlay.type === 'rect' || overlay.type === 'ellipse')
        parts.push(
          <label key="fill" className="mini check">
            <input type="checkbox" checked={!!overlay.fill} onChange={(e) => upd((o) => ({ ...o, fill: e.target.checked ? '#ffffff' : null } as Overlay))} />
            Filled
            {overlay.fill && <input type="color" value={overlay.fill} onChange={(e) => upd((o) => ({ ...o, fill: e.target.value } as Overlay))} />}
          </label>,
        );
    } else if (overlay.type === 'image') {
      parts.push(
        <span key="hint" className="muted small">
          Drag the corner to resize (hold Shift to stretch).
        </span>,
        <button key="all" className="btn small" title="Put a copy at the same place on every other page (handy for initials)" onClick={() => placeOnAllPages(sel.pageId, overlay)}>
          <Files size={15} /> Place on all pages
        </button>,
      );
    }
    return (
      <div className="propsbar">
        <span className="label">{labelFor(overlay)}</span>
        {parts}
        <div className="spacer" />
        <button className="icon-btn" title="Duplicate (Ctrl+D)" onClick={duplicateSelected}>
          <Copy size={16} />
        </button>
        <button className="icon-btn danger" title="Delete (Del)" onClick={() => deleteOverlay(sel.pageId, sel.id)}>
          <Trash2 size={16} />
        </button>
      </div>
    );
  }

  // ---- no selection: defaults for the active tool ----
  if (tool === 'text') {
    return (
      <div className="propsbar">
        <span className="label">New text</span>
        <Swatches value={style.color} colors={COLORS} onPick={(c) => setStyle({ color: c })} />
        <select value={style.font} onChange={(e) => setStyle({ font: e.target.value as TextOverlay['font'] })}>
          <option value="cairo">Cairo (sans)</option>
          <option value="amiri">Amiri (serif)</option>
        </select>
        <div className="num">
          <input type="number" min={4} max={144} value={style.fontSize} onChange={(e) => +e.target.value > 0 && setStyle({ fontSize: +e.target.value })} />
          <span className="muted small">pt</span>
        </div>
        <button className={`icon-btn${style.bold ? ' on' : ''}`} onClick={() => setStyle({ bold: !style.bold })} title="Bold">
          <Bold size={16} />
        </button>
        <span className="muted small">Click on the page to start typing. Arabic and English both work.</span>
      </div>
    );
  }
  if (tool === 'highlight')
    return (
      <div className="propsbar">
        <span className="label">Highlight</span>
        <Swatches value={style.highlight} colors={HIGHLIGHTS} onPick={(c) => setStyle({ highlight: c })} />
        <span className="muted small">Drag over the text.</span>
      </div>
    );
  if (['ink', 'rect', 'ellipse', 'line', 'arrow'].includes(tool))
    return (
      <div className="propsbar">
        <span className="label">Pen</span>
        <Swatches value={style.color} colors={COLORS} onPick={(c) => setStyle({ color: c })} />
        <label className="mini">
          Width
          <input type="range" min={0.5} max={12} step={0.5} value={style.strokeWidth} onChange={(e) => setStyle({ strokeWidth: +e.target.value })} />
        </label>
      </div>
    );
  if (tool === 'signature' || tool === 'image')
    return (
      <div className="propsbar">
        <span className="label">{tool === 'signature' ? 'Signature' : 'Image'}</span>
        <span className="muted small">Click on the page where it should go. Press Esc to cancel.</span>
      </div>
    );
  if (tool === 'edittext')
    return (
      <div className="propsbar">
        <span className="label">Edit text</span>
        <span className="muted small">
          Existing text is outlined in blue — click it to replace. The old text is covered and new text is written on top (works best on simple, single-colour backgrounds).
        </span>
      </div>
    );
  if (tool === 'whiteout')
    return (
      <div className="propsbar">
        <span className="label">Whiteout</span>
        <span className="muted small">Drag a box over anything you want to hide. Note: the content underneath is covered, not erased.</span>
      </div>
    );
  return (
    <div className="propsbar">
      <span className="muted small">Tip: double-click text to edit it · Del removes the selected item · Ctrl+Z undo · Ctrl+wheel zoom</span>
    </div>
  );
}

function labelFor(o: Overlay) {
  switch (o.type) {
    case 'image':
      return o.signature ? 'Signature' : 'Image';
    case 'text':
      return 'Text';
    case 'note':
      return 'Comment';
    case 'ink':
      return 'Drawing';
    default:
      return o.type[0].toUpperCase() + o.type.slice(1);
  }
}
