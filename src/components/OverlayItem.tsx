import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ImageOverlay, Overlay, ShapeOverlay, TextOverlay } from '../types';
import { overlayBounds, translateOverlay } from '../lib/geometry';
import { LINE_HEIGHT } from '../lib/exporter';
import { isRtlText } from '../lib/bidi';
import { deleteOverlay, getState, setState, updateOverlay } from '../store';

const FONT_CSS: Record<string, string> = {
  cairo: "'Cairo', sans-serif",
  amiri: "'Amiri', serif",
};

type DragMode = 'move' | 'se' | 'e' | 'p1' | 'p2';

interface Props {
  pageId: string;
  overlay: Overlay;
  zoom: number;
  selected: boolean;
  editing: boolean;
  interactive: boolean;
  pageW: number;
  pageH: number;
}

function applyDrag(o: Overlay, mode: DragMode, dx: number, dy: number, keepAspect: boolean): Overlay {
  if (mode === 'move') return translateOverlay(o, dx, dy);
  if ((o.type === 'line' || o.type === 'arrow') && (mode === 'p1' || mode === 'p2')) {
    return mode === 'p1' ? { ...o, x1: o.x1 + dx, y1: o.y1 + dy } : { ...o, x2: o.x2 + dx, y2: o.y2 + dy };
  }
  if (o.type === 'text') return { ...o, w: Math.max(30, o.w + dx) };
  if (o.type === 'image' || o.type === 'rect' || o.type === 'ellipse' || o.type === 'highlight' || o.type === 'whiteout') {
    let w = Math.max(6, o.w + dx);
    let h = Math.max(6, o.h + dy);
    if (keepAspect) {
      const ratio = o.w / o.h;
      if (Math.abs(dx) > Math.abs(dy)) h = w / ratio;
      else w = h * ratio;
    }
    return { ...o, w, h };
  }
  return o;
}

export function OverlayItem({ pageId, overlay, zoom, selected, editing, interactive, pageW, pageH }: Props) {
  const [draft, setDraft] = useState<Overlay | null>(null);
  const drag = useRef<{ mode: DragMode; sx: number; sy: number; moved: boolean; shift: boolean } | null>(null);
  const o = draft ?? overlay;
  const z = zoom;

  const onPointerDown = (e: React.PointerEvent, mode: DragMode) => {
    if (!interactive || editing) return;
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { mode, sx: e.clientX, sy: e.clientY, moved: false, shift: e.shiftKey };
    if (!selected) setState({ selected: { pageId, id: overlay.id }, editingId: null });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.sx) / z;
    const dy = (e.clientY - d.sy) / z;
    if (!d.moved && Math.hypot(dx * z, dy * z) < 3) return;
    d.moved = true;
    // images keep their proportions unless Shift is held; other boxes the opposite
    const keepAspect = overlay.type === 'image' ? !e.shiftKey : e.shiftKey;
    let next = applyDrag(overlay, d.mode, dx, dy, keepAspect);
    if (d.mode === 'move') {
      // keep at least part of the item on the page
      const b = overlayBounds(next);
      const cx = Math.min(Math.max(b.x, -b.w + 10), pageW - 10) - b.x;
      const cy = Math.min(Math.max(b.y, -b.h + 10), pageH - 10) - b.y;
      if (cx || cy) next = translateOverlay(next, cx, cy);
    }
    setDraft(next);
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.moved && draft) updateOverlay(pageId, overlay.id, () => draft);
    setDraft(null);
  };
  const handlers = { onPointerMove, onPointerUp, onPointerCancel: onPointerUp };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (!interactive) return;
    if (o.type === 'text' || o.type === 'note') {
      e.stopPropagation();
      setState({ selected: { pageId, id: o.id }, editingId: o.id });
    }
  };

  const cls = `ov ov-${o.type}${selected ? ' selected' : ''}${interactive ? ' interactive' : ''}`;

  if (o.type === 'line' || o.type === 'arrow' || o.type === 'ink') {
    const b = overlayBounds(o);
    const pad = 10 + o.strokeWidth;
    const left = b.x - pad;
    const top = b.y - pad;
    const w = b.w + pad * 2;
    const h = b.h + pad * 2;
    const tx = (x: number) => (x - left) * z;
    const ty = (y: number) => (y - top) * z;
    let d = '';
    if (o.type === 'ink') d = o.strokes.map((s) => s.map(([x, y], i) => `${i ? 'L' : 'M'}${tx(x)},${ty(y)}`).join(' ')).join(' ');
    else {
      d = `M${tx(o.x1)},${ty(o.y1)} L${tx(o.x2)},${ty(o.y2)}`;
      if (o.type === 'arrow') {
        const ang = Math.atan2(o.y2 - o.y1, o.x2 - o.x1);
        const len = Math.max(8, o.strokeWidth * 4);
        for (const s of [-1, 1]) {
          const a = ang + Math.PI + s * (Math.PI / 7);
          d += ` M${tx(o.x2)},${ty(o.y2)} L${tx(o.x2 + len * Math.cos(a))},${ty(o.y2 + len * Math.sin(a))}`;
        }
      }
    }
    return (
      <svg className={cls} style={{ left: left * z, top: top * z, width: w * z, height: h * z }} {...handlers}>
        <path d={d} className="hit" onPointerDown={(e) => onPointerDown(e, 'move')} strokeWidth={Math.max(12, o.strokeWidth * z + 8)} />
        <path d={d} fill="none" stroke={o.stroke} strokeWidth={o.strokeWidth * z} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />
        {selected && o.type !== 'ink' && (
          <>
            <circle className="handle-dot" cx={tx(o.x1)} cy={ty(o.y1)} r={6} onPointerDown={(e) => onPointerDown(e, 'p1')} />
            <circle className="handle-dot" cx={tx(o.x2)} cy={ty(o.y2)} r={6} onPointerDown={(e) => onPointerDown(e, 'p2')} />
          </>
        )}
        {selected && o.type === 'ink' && <rect className="sel-outline" x={pad * z - 4} y={pad * z - 4} width={b.w * z + 8} height={b.h * z + 8} />}
      </svg>
    );
  }

  if (o.type === 'note') {
    return (
      <div
        className={cls}
        style={{ left: o.x * z, top: o.y * z }}
        onPointerDown={(e) => onPointerDown(e, 'move')}
        onDoubleClick={onDoubleClick}
        {...handlers}
        title={o.text}
      >
        <div className="note-icon" style={{ width: 22 * z, height: 22 * z }}>
          <svg viewBox="0 0 24 24" width="70%" height="70%"><path d="M4 4h16v12H8l-4 4z" fill="#3b2f00" /></svg>
        </div>
        {(editing || selected) && <NoteEditor pageId={pageId} overlay={o} editing={editing} />}
      </div>
    );
  }

  if (o.type === 'text') {
    return (
      <TextBox
        pageW={pageW}
        o={o}
        z={z}
        cls={cls}
        pageId={pageId}
        editing={editing}
        selected={selected}
        onPointerDown={onPointerDown}
        onDoubleClick={onDoubleClick}
        handlers={handlers}
      />
    );
  }

  // boxes: image, rect, ellipse, highlight, whiteout
  const bo = o as ImageOverlay | ShapeOverlay;
  const style: React.CSSProperties = { left: bo.x * z, top: bo.y * z, width: bo.w * z, height: bo.h * z };
  let inner: React.ReactNode = null;
  if (o.type === 'image') inner = <img src={o.dataUrl} draggable={false} alt="" />;
  else if (o.type === 'ellipse')
    inner = (
      <svg width="100%" height="100%" style={{ overflow: 'visible' }}>
        <ellipse cx="50%" cy="50%" rx={(o.w * z) / 2} ry={(o.h * z) / 2} fill={o.fill ?? 'none'} stroke={o.stroke} strokeWidth={o.strokeWidth * z} />
      </svg>
    );
  else if (o.type === 'rect') {
    style.border = `${o.strokeWidth * z}px solid ${o.stroke}`;
    if (o.fill) style.background = o.fill;
  } else if (o.type === 'highlight') {
    style.background = o.fill ?? '#ffe500';
  } else if (o.type === 'whiteout') {
    style.background = o.fill ?? '#ffffff';
  }
  return (
    <div className={cls} style={style} onPointerDown={(e) => onPointerDown(e, 'move')} {...handlers}>
      {inner}
      {selected && <div className="handle se" onPointerDown={(e) => onPointerDown(e, 'se')} {...handlers} />}
    </div>
  );
}

function TextBox({
  pageW,
  o,
  z,
  cls,
  pageId,
  editing,
  selected,
  onPointerDown,
  onDoubleClick,
  handlers,
}: {
  pageW: number;
  o: TextOverlay;
  z: number;
  cls: string;
  pageId: string;
  editing: boolean;
  selected: boolean;
  onPointerDown: (e: React.PointerEvent, m: DragMode) => void;
  onDoubleClick: (e: React.MouseEvent) => void;
  handlers: Record<string, (e: React.PointerEvent) => void>;
}) {
  const [text, setText] = useState(o.text);
  const textRef = useRef(o.text);
  textRef.current = text;
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setText(o.text), [o.text]);
  useLayoutEffect(() => {
    if (editing && ta.current) {
      ta.current.focus();
      ta.current.setSelectionRange(ta.current.value.length, ta.current.value.length);
    }
  }, [editing]);
  useLayoutEffect(() => {
    const el = ta.current;
    if (el) {
      el.style.height = '0px';
      el.style.height = el.scrollHeight + 'px';
    }
  }, [text, editing, z, o.fontSize, o.w]);

  // Commit when editing ends, however it ends (blur, Esc, clicking elsewhere).
  // Note: clicking elsewhere unmounts the textarea, and browsers do not fire
  // "blur" for removed elements, so we cannot rely on onBlur alone.
  // A brand-new box is anchored at the click point. Arabic starts on the right,
  // so while the first text is typed an RTL box extends to the LEFT of the click.
  const fresh = useRef(editing && o.text === '' && !o.cover);
  const rtlNow = fresh.current && isRtlText(text);
  const placed = (x: number, w: number) => {
    if (!fresh.current) return { x, w };
    if (rtlNow) return { x: Math.max(0, x - w), w: Math.min(w, x) < 40 ? w : Math.min(w, x) };
    return { x, w: x + w > pageW ? Math.max(40, pageW - x) : w };
  };
  const pos = placed(o.x, o.w);
  const wasEditing = useRef(editing);
  useEffect(() => {
    if (wasEditing.current && !editing) {
      const t = textRef.current;
      const cur = getState().doc.overlays[pageId]?.find((x) => x.id === o.id) as TextOverlay | undefined;
      if (cur) {
        const p = placed(cur.x, cur.w);
        fresh.current = false;
        if (!t.trim() && !cur.cover) deleteOverlay(pageId, o.id);
        else if (t !== cur.text || p.x !== cur.x || p.w !== cur.w)
          updateOverlay(pageId, o.id, (x) => ({ ...(x as TextOverlay), text: t, x: p.x, w: p.w }));
      }
    }
    wasEditing.current = editing;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, pageId, o.id]);
  const finish = () => {
    if (getState().editingId === o.id) setState({ editingId: null });
  };

  const textStyle: React.CSSProperties = {
    fontFamily: FONT_CSS[o.font],
    fontWeight: o.bold ? 700 : 400,
    fontSize: o.fontSize * z,
    lineHeight: LINE_HEIGHT,
    color: o.color,
    textAlign: o.align === 'auto' ? 'start' : o.align,
  };
  return (
    <div
      className={cls}
      style={{ left: pos.x * z, top: o.y * z, width: pos.w * z }}
      onPointerDown={(e) => onPointerDown(e, 'move')}
      onDoubleClick={onDoubleClick}
      {...handlers}
    >
      {editing ? (
        <textarea
          ref={ta}
          dir="auto"
          className="text-edit"
          style={textStyle}
          value={text}
          placeholder="Type here…"
          onChange={(e) => setText(e.target.value)}
          onBlur={finish}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              (e.target as HTMLTextAreaElement).blur();
            }
            e.stopPropagation();
          }}
        />
      ) : (
        <div className="text-view" style={textStyle}>
          {(o.text || ' ').split('\n').map((line, i) => (
            <div key={i} dir="auto">
              {line || ' '}
            </div>
          ))}
        </div>
      )}
      {selected && !editing && <div className="handle e" onPointerDown={(e) => onPointerDown(e, 'e')} {...handlers} />}
    </div>
  );
}

function NoteEditor({ pageId, overlay, editing }: { pageId: string; overlay: Extract<Overlay, { type: 'note' }>; editing: boolean }) {
  const [text, setText] = useState(overlay.text);
  const textRef = useRef(text);
  textRef.current = text;
  const wasEditing = useRef(editing);
  const commitNote = () => {
    const cur = getState().doc.overlays[pageId]?.find((x) => x.id === overlay.id);
    if (!cur || cur.type !== 'note') return;
    const t = textRef.current;
    if (!t.trim()) deleteOverlay(pageId, overlay.id);
    else if (t !== cur.text) updateOverlay(pageId, overlay.id, (x) => ({ ...x, text: t } as Overlay));
  };
  useEffect(() => {
    if (wasEditing.current && !editing) commitNote();
    wasEditing.current = editing;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);
  // the popup disappears entirely when the note is deselected while editing
  useEffect(
    () => () => {
      if (wasEditing.current) commitNote();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const finish = () => {
    if (getState().editingId === overlay.id) setState({ editingId: null });
  };
  return (
    <div className="note-pop" onPointerDown={(e) => e.stopPropagation()}>
      {editing ? (
        <textarea
          autoFocus
          dir="auto"
          value={text}
          placeholder="Comment…"
          onChange={(e) => setText(e.target.value)}
          onBlur={finish}
          onKeyDown={(e) => {
            if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur();
            e.stopPropagation();
          }}
        />
      ) : (
        <div dir="auto" className="note-text" onDoubleClick={() => setState({ editingId: overlay.id })}>
          {overlay.text || <em>Double-click to write a comment</em>}
        </div>
      )}
    </div>
  );
}
