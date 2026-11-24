import { memo, useEffect, useRef, useState } from 'react';
import type { FormField, Overlay, PageRef, TextOverlay } from '../types';
import { totalRotation, viewSize } from '../lib/geometry';
import { getFormFields, getPage, getTextBoxes, renderPage, type TextItemBox } from '../lib/pdfjs';
import { sampleBackground } from '../lib/image';
import { addOverlay, getState, setFormValue, setState, setTool, uid, useStore } from '../store';
import { OverlayItem } from './OverlayItem';

interface Props {
  page: PageRef;
  index: number;
  visible: boolean;
}

const MIN_DRAG = 3;

function PageViewInner({ page, index, visible }: Props) {
  const zoom = useStore((s) => s.zoom);
  const tool = useStore((s) => s.tool);
  const overlays = useStore((s) => s.doc.overlays[page.id]) ?? EMPTY;
  const selected = useStore((s) => (s.selected?.pageId === page.id ? s.selected.id : null));
  const editingId = useStore((s) => s.editingId);
  const fields = useStore((s) => s.formFields[page.id]) ?? EMPTY_F;
  const formValues = useStore((s) => s.doc.formValues);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState(false);
  const [textBoxes, setTextBoxes] = useState<TextItemBox[] | null>(null);
  const [draft, setDraft] = useState<Overlay | null>(null);
  const draftRef = useRef<Overlay | null>(null);
  const start = useRef<[number, number] | null>(null);

  const rot = totalRotation(page);
  const { w: vw, h: vh } = viewSize(page);

  // ---- render the page bitmap when visible ----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!visible) {
      // free bitmap memory for pages far from the viewport
      canvas.width = 0;
      canvas.height = 0;
      setRendered(false);
      return;
    }
    if (page.blank) {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(vw * zoom * dpr);
      canvas.height = Math.floor(vh * zoom * dpr);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      setRendered(true);
      return;
    }
    let cancel = () => {};
    let alive = true;
    getPage(page.docId, page.srcIndex)
      .then((p) => {
        if (!alive) return;
        const t = renderPage(p, canvas, zoom, rot);
        cancel = t.cancel;
        return t.promise.then(() => alive && setRendered(true));
      })
      .catch((e) => console.error('render failed', e));
    return () => {
      alive = false;
      cancel();
    };
  }, [visible, zoom, rot, page.docId, page.srcIndex, page.blank, vw, vh]);

  // ---- form fields (once per page/rotation) ----
  useEffect(() => {
    if (!visible || page.blank) return;
    let alive = true;
    getPage(page.docId, page.srcIndex)
      .then((p) => getFormFields(p, rot, page.docId))
      .then((f) => {
        if (alive) setState((s) => ({ formFields: { ...s.formFields, [page.id]: f } }));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [visible, rot, page.id, page.docId, page.srcIndex, page.blank]);

  // ---- existing text boxes for "Edit text" ----
  useEffect(() => {
    if (tool !== 'edittext' || !visible || page.blank) {
      setTextBoxes(null);
      return;
    }
    let alive = true;
    getPage(page.docId, page.srcIndex)
      .then((p) => getTextBoxes(p, rot))
      .then((b) => alive && setTextBoxes(b))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [tool, visible, rot, page.docId, page.srcIndex, page.blank]);

  const toPage = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = layerRef.current!.getBoundingClientRect();
    return [(e.clientX - r.left) / zoom, (e.clientY - r.top) / zoom];
  };

  const setDraftBoth = (o: Overlay | null) => {
    draftRef.current = o;
    setDraft(o);
  };

  // ---- creating new things with the active tool ----
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    setState({ currentPage: index });
    const s = getState();
    const [x, y] = toPage(e);
    const st = s.style;
    if (tool === 'select' || tool === 'edittext') {
      if (s.selected || s.editingId) setState({ selected: null, editingId: null });
      return;
    }
    e.preventDefault();
    if (tool === 'text') {
      const o: TextOverlay = {
        id: uid(),
        type: 'text',
        x, // the click point; for Arabic the box grows to the left of it (see TextBox)
        y: y - st.fontSize * 0.75,
        w: 260,
        text: '',
        fontSize: st.fontSize,
        color: st.color,
        font: st.font,
        bold: st.bold,
        align: 'auto',
      };
      addOverlay(page.id, o);
      setState({ editingId: o.id, tool: 'select' });
      return;
    }
    if (tool === 'note') {
      const o: Overlay = { id: uid(), type: 'note', x: x - 11, y: y - 11, text: '' };
      addOverlay(page.id, o);
      setState({ editingId: o.id, tool: 'select' });
      return;
    }
    if (tool === 'signature' || tool === 'image') {
      const img = s.pendingImage;
      if (!img) return;
      const maxW = img.signature ? 150 : Math.min(260, vw * 0.6);
      const w = Math.min(maxW, img.w);
      const h = (w * img.h) / img.w;
      const ix = Math.min(Math.max(0, x - w / 2), Math.max(0, vw - w));
      const iy = Math.min(Math.max(0, y - h / 2), Math.max(0, vh - h));
      addOverlay(page.id, { id: uid(), type: 'image', x: ix, y: iy, w, h, dataUrl: img.dataUrl, signature: img.signature });
      setTool('select');
      setState({ selected: { pageId: page.id, id: getState().doc.overlays[page.id].slice(-1)[0].id } });
      return;
    }
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    start.current = [x, y];
    if (tool === 'ink') setDraftBoth({ id: uid(), type: 'ink', strokes: [[[x, y]]], stroke: st.color, strokeWidth: st.strokeWidth });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!start.current) return;
    const [x, y] = toPage(e);
    const [sx, sy] = start.current;
    const st = getState().style;
    const d = draftRef.current;
    if (tool === 'ink' && d?.type === 'ink') {
      setDraftBoth({ ...d, strokes: [[...d.strokes[0], [x, y]]] });
      return;
    }
    const box = { x: Math.min(sx, x), y: Math.min(sy, y), w: Math.abs(x - sx), h: Math.abs(y - sy) };
    const id = d?.id ?? uid();
    if (tool === 'line' || tool === 'arrow') {
      setDraftBoth({ id, type: tool, x1: sx, y1: sy, x2: x, y2: y, stroke: st.color, strokeWidth: st.strokeWidth });
    } else if (tool === 'rect' || tool === 'ellipse') {
      setDraftBoth({ id, type: tool, ...box, stroke: st.color, fill: null, strokeWidth: st.strokeWidth });
    } else if (tool === 'highlight') {
      setDraftBoth({ id, type: 'highlight', ...box, stroke: st.highlight, fill: st.highlight, strokeWidth: 0 });
    } else if (tool === 'whiteout') {
      setDraftBoth({ id, type: 'whiteout', ...box, stroke: '#ffffff', fill: '#ffffff', strokeWidth: 0 });
    }
  };

  const onPointerUp = () => {
    const d = draftRef.current;
    start.current = null;
    setDraftBoth(null);
    if (!d) return;
    let ok = true;
    if (d.type === 'line' || d.type === 'arrow') ok = Math.hypot(d.x2 - d.x1, d.y2 - d.y1) * zoom > MIN_DRAG;
    else if ('w' in d && 'h' in d) ok = d.w * zoom > MIN_DRAG && d.h * zoom > MIN_DRAG;
    if (ok) addOverlay(page.id, d, d.type !== 'ink' && d.type !== 'highlight');
  };

  // ---- click on existing text in "Edit text" mode ----
  const editExisting = (b: TextItemBox) => {
    const canvas = canvasRef.current;
    const k = canvas ? canvas.width / vw : 1;
    const bg = canvas ? sampleBackground(canvas, b.x * k, b.y * k, b.w * k, b.h * k) : '#ffffff';
    const st = getState().style;
    const fontSize = Math.max(5, Math.round(b.fontSize * 10) / 10);
    // the cover hides the old text; the new text box starts at the same place
    const o: TextOverlay = {
      id: uid(),
      type: 'text',
      x: b.x - 1,
      y: b.y + b.h / 2 - (fontSize * 1.5) / 2,
      w: Math.max(b.w + 40, 60),
      text: b.str,
      fontSize,
      color: st.color === '#1a1a1a' ? '#000000' : st.color,
      font: b.serif ? 'amiri' : 'cairo',
      bold: b.bold,
      align: 'auto',
      cover: { x: b.x - 1, y: b.y - 1, w: b.w + 2, h: b.h + 2, color: bg },
    };
    if (/[؀-ۿ]/.test(b.str)) {
      // keep right edge for Arabic so the text grows to the left
      o.x = b.x + b.w + 1 - o.w;
      o.align = 'right';
    }
    addOverlay(page.id, o);
    setState({ editingId: o.id, tool: 'select' });
  };

  const interactive = tool === 'select';
  const cursor =
    tool === 'select' ? 'default' : tool === 'text' ? 'text' : tool === 'edittext' ? 'default' : 'crosshair';

  return (
    <div className="page-wrap" data-page-index={index} style={{ width: vw * zoom, height: vh * zoom }}>
      <canvas ref={canvasRef} className="page-canvas" style={{ width: vw * zoom, height: vh * zoom, opacity: rendered ? 1 : 0 }} />
      {!rendered && <div className="page-loading">{index + 1}</div>}
      <div
        ref={layerRef}
        className={`overlay-layer tool-${tool}`}
        style={{ cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {overlays.map(
          (o) =>
            o.type === 'text' &&
            o.cover && (
              <div
                key={'c' + o.id}
                className="text-cover"
                style={{ left: o.cover.x * zoom, top: o.cover.y * zoom, width: o.cover.w * zoom, height: o.cover.h * zoom, background: o.cover.color }}
              />
            ),
        )}
        {fields.length > 0 && (
          <FormLayer fields={fields} values={formValues} zoom={zoom} active={tool === 'select'} />
        )}
        {overlays.map((o) => (
          <OverlayItem
            key={o.id}
            pageId={page.id}
            overlay={o}
            zoom={zoom}
            selected={selected === o.id}
            editing={editingId === o.id}
            interactive={interactive}
            pageW={vw}
            pageH={vh}
          />
        ))}
        {draft && <OverlayItem pageId={page.id} overlay={draft} zoom={zoom} selected={false} editing={false} interactive={false} pageW={vw} pageH={vh} />}
        {textBoxes?.map((b, i) => (
          <div
            key={i}
            className="existing-text"
            style={{ left: b.x * zoom, top: b.y * zoom, width: b.w * zoom, height: b.h * zoom }}
            title="Click to edit this text"
            onPointerDown={(e) => {
              e.stopPropagation();
              e.preventDefault(); // keep focus in the new text box
              editExisting(b);
            }}
          />
        ))}
      </div>
    </div>
  );
}

const EMPTY: Overlay[] = [];
const EMPTY_F: FormField[] = [];

function FormLayer({
  fields,
  values,
  zoom,
  active,
}: {
  fields: FormField[];
  values: Record<string, string | boolean>;
  zoom: number;
  active: boolean;
}) {
  return (
    <>
      {fields.map((f) => {
        const v = values[f.key] ?? f.initial;
        const style: React.CSSProperties = {
          left: f.rect.x * zoom,
          top: f.rect.y * zoom,
          width: f.rect.w * zoom,
          height: f.rect.h * zoom,
          pointerEvents: active ? 'auto' : 'none',
        };
        const stop = (e: React.SyntheticEvent) => e.stopPropagation();
        if (f.kind === 'checkbox' || f.kind === 'radio') {
          const on = f.kind === 'checkbox' ? v === true : v === f.exportValue;
          return (
            <button
              key={f.annotId}
              className={`form-field form-check ${f.kind}${on ? ' on' : ''}`}
              style={style}
              disabled={f.readOnly}
              onPointerDown={stop}
              onClick={() => setFormValue(f.key, f.kind === 'checkbox' ? !on : on ? '' : f.exportValue ?? 'On')}
            >
              {on ? (f.kind === 'radio' ? '●' : '✓') : ''}
            </button>
          );
        }
        if (f.kind === 'choice') {
          return (
            <select key={f.annotId} className="form-field" style={{ ...style, fontSize: Math.min(12, f.rect.h * 0.6) * zoom }} value={String(v)} disabled={f.readOnly} onPointerDown={stop} onChange={(e) => setFormValue(f.key, e.target.value)}>
              <option value="" />
              {f.options?.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          );
        }
        return <FormText key={f.annotId} f={f} value={String(v)} style={style} zoom={zoom} />;
      })}
    </>
  );
}

function FormText({ f, value, style, zoom }: { f: FormField; value: string; style: React.CSSProperties; zoom: number }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const fontSize = (f.multiline ? Math.min(11, f.rect.h * 0.6) : Math.max(6, Math.min(12, f.rect.h * 0.62))) * zoom;
  const props = {
    className: 'form-field form-text',
    style: { ...style, fontSize },
    value: v,
    dir: 'auto' as const,
    disabled: f.readOnly,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setV(e.target.value),
    onBlur: () => v !== value && setFormValue(f.key, v),
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
    onKeyDown: (e: React.KeyboardEvent) => e.stopPropagation(),
    title: f.fieldName,
  };
  return f.multiline ? <textarea {...props} /> : <input {...props} />;
}

export const PageView = memo(PageViewInner);
