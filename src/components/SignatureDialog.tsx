import { useEffect, useRef, useState } from 'react';
import { ImageUp, PenLine, Trash2, X, Library } from 'lucide-react';
import { cleanSignature, loadImage, type InkColor } from '../lib/image';
import { platform, type SavedSignature } from '../platform';
import { setState, toast } from '../store';

type Tab = 'library' | 'import' | 'draw';

export function SignatureDialog({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('library');
  const [sigs, setSigs] = useState<SavedSignature[] | null>(null);

  const refresh = () => platform.listSignatures().then(setSigs);
  useEffect(() => {
    refresh().then(() => {});
  }, []);
  useEffect(() => {
    if (sigs && sigs.length === 0 && tab === 'library') setTab('import');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sigs]);

  const use = async (dataUrl: string) => {
    const img = await loadImage(dataUrl);
    setState({ pendingImage: { dataUrl, w: img.naturalWidth, h: img.naturalHeight, signature: true }, tool: 'signature', selected: null });
    toast('Click on the page where the signature should go.');
    onClose();
  };

  return (
    <div className="modal-back" onPointerDown={onClose}>
      <div className="modal sig-modal" onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Signature</h2>
          <button className="icon-btn" onClick={onClose} title="Close">
            <X size={18} />
          </button>
        </div>
        <div className="tabs">
          <button className={tab === 'library' ? 'on' : ''} onClick={() => setTab('library')}>
            <Library size={15} /> My signatures
          </button>
          <button className={tab === 'import' ? 'on' : ''} onClick={() => setTab('import')}>
            <ImageUp size={15} /> From scan / photo
          </button>
          <button className={tab === 'draw' ? 'on' : ''} onClick={() => setTab('draw')}>
            <PenLine size={15} /> Draw
          </button>
        </div>
        {tab === 'library' && (
          <div className="sig-grid">
            {sigs === null && <p className="muted">Loading…</p>}
            {sigs?.length === 0 && <p className="muted">No saved signatures yet. Import your scanned signature once and it will be kept here.</p>}
            {sigs?.map((s) => (
              <div key={s.id} className="sig-card" onClick={() => use(s.dataUrl)} title="Use this signature">
                <img src={s.dataUrl} alt="signature" />
                <button
                  className="icon-btn del"
                  title="Delete"
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (!window.confirm('Delete this saved signature?')) return;
                    await platform.deleteSignature(s.id);
                    refresh();
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
        {tab === 'import' && <ImportTab onUse={use} onSaved={refresh} />}
        {tab === 'draw' && <DrawTab onUse={use} onSaved={refresh} />}
      </div>
    </div>
  );
}

function ImportTab({ onUse, onSaved }: { onUse: (d: string) => void; onSaved: () => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [threshold, setThreshold] = useState(185);
  const [ink, setInk] = useState<InkColor>('original');
  const [result, setResult] = useState<string | null>(null);
  const [save, setSave] = useState(true);

  useEffect(() => {
    if (!src) return;
    let alive = true;
    const t = setTimeout(() => {
      cleanSignature(src, threshold, ink).then((r) => alive && setResult(r?.dataUrl ?? null));
    }, 60);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [src, threshold, ink]);

  const pick = async () => {
    const d = await platform.openImage();
    if (d) setSrc(d);
  };

  const confirm = async () => {
    if (!result) return;
    if (save) {
      await platform.saveSignature(result);
      onSaved();
    }
    onUse(result);
  };

  if (!src)
    return (
      <div className="sig-empty">
        <p>Choose the scanned image or phone photo of your signature (PNG / JPG).</p>
        <p className="muted">The white paper is removed automatically and the signature is cropped, so it sits naturally on the document.</p>
        <button className="btn primary" onClick={pick}>
          <ImageUp size={16} /> Choose image…
        </button>
      </div>
    );
  return (
    <div className="sig-import">
      <div className="checker">{result ? <img src={result} alt="cleaned signature" /> : <p className="muted">Nothing left — move the slider right.</p>}</div>
      <label className="row">
        <span>Background removal</span>
        <input type="range" min={90} max={250} value={threshold} onChange={(e) => setThreshold(+e.target.value)} />
      </label>
      <div className="row">
        <span>Ink colour</span>
        <div className="seg">
          {(['original', 'black', 'blue'] as InkColor[]).map((c) => (
            <button key={c} className={ink === c ? 'on' : ''} onClick={() => setInk(c)}>
              {c}
            </button>
          ))}
        </div>
      </div>
      <label className="row check">
        <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} /> Save to “My signatures” for next time
      </label>
      <div className="modal-foot">
        <button className="btn" onClick={pick}>
          Choose another…
        </button>
        <button className="btn primary" disabled={!result} onClick={confirm}>
          Use signature
        </button>
      </div>
    </div>
  );
}

function DrawTab({ onUse, onSaved }: { onUse: (d: string) => void; onSaved: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [empty, setEmpty] = useState(true);
  const [save, setSave] = useState(true);
  const W = 560;
  const H = 200;

  useEffect(() => {
    const c = canvas.current!;
    c.width = W * 2;
    c.height = H * 2;
    const ctx = c.getContext('2d')!;
    ctx.scale(2, 2);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#10226e';
    ctx.lineWidth = 2.6;
  }, []);

  const pos = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const down = (e: React.PointerEvent) => {
    drawing.current = true;
    (e.target as Element).setPointerCapture(e.pointerId);
    const ctx = canvas.current!.getContext('2d')!;
    const [x, y] = pos(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 0.1, y);
    ctx.stroke();
    setEmpty(false);
  };
  const move = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    const ctx = canvas.current!.getContext('2d')!;
    const [x, y] = pos(e);
    ctx.lineTo(x, y);
    ctx.stroke();
  };
  const clear = () => {
    const ctx = canvas.current!.getContext('2d')!;
    ctx.clearRect(0, 0, W, H);
    setEmpty(true);
  };
  const confirm = async () => {
    // reuse the cleaner just to crop to the ink
    const r = await cleanSignature(canvas.current!.toDataURL('image/png'), 250, 'original');
    if (!r) return;
    if (save) {
      await platform.saveSignature(r.dataUrl);
      onSaved();
    }
    onUse(r.dataUrl);
  };

  return (
    <div className="sig-draw">
      <canvas
        ref={canvas}
        style={{ width: W, height: H }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={() => (drawing.current = false)}
      />
      <label className="row check">
        <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} /> Save to “My signatures”
      </label>
      <div className="modal-foot">
        <button className="btn" onClick={clear}>
          Clear
        </button>
        <button className="btn primary" disabled={empty} onClick={confirm}>
          Use signature
        </button>
      </div>
    </div>
  );
}
