import { memo, useEffect, useRef, useState } from 'react';
import { FilePlus2, FileOutput, RotateCcw, RotateCw, Trash2, SquarePlus } from 'lucide-react';
import type { PageRef } from '../types';
import { totalRotation, viewSize } from '../lib/geometry';
import { getPage, renderPage } from '../lib/pdfjs';
import { deletePages, getState, insertBlankPage, movePages, rotatePages, setState, useStore } from '../store';
import { appendFiles, exportSelectedPages } from '../actions';
import { platform } from '../platform';
import { scrollToPage } from './Viewer';

const THUMB_W = 132;

const Thumb = memo(function Thumb({ page, index, selected, current }: { page: PageRef; index: number; selected: boolean; current: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [show, setShow] = useState(false);
  const rot = totalRotation(page);
  const { w, h } = viewSize(page);
  const scale = THUMB_W / w;

  useEffect(() => {
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setShow(true), { rootMargin: '400px' });
    if (wrap.current) io.observe(wrap.current);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!show || !canvas.current) return;
    const c = canvas.current;
    if (page.blank) {
      c.width = THUMB_W;
      c.height = h * scale;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      return;
    }
    let cancel = () => {};
    let alive = true;
    getPage(page.docId, page.srcIndex).then((p) => {
      if (!alive) return;
      const t = renderPage(p, c, scale, rot);
      cancel = t.cancel;
    });
    return () => {
      alive = false;
      cancel();
    };
  }, [show, rot, page.docId, page.srcIndex, page.blank, scale, h]);

  const onClick = (e: React.MouseEvent) => {
    const s = getState();
    const ids = s.doc.pages.map((p) => p.id);
    if (e.ctrlKey || e.metaKey) {
      const sel = s.selectedPages.includes(page.id) ? s.selectedPages.filter((x) => x !== page.id) : [...s.selectedPages, page.id];
      setState({ selectedPages: sel });
    } else if (e.shiftKey && s.selectedPages.length) {
      const a = ids.indexOf(s.selectedPages[s.selectedPages.length - 1]);
      const [lo, hi] = a < index ? [a, index] : [index, a];
      setState({ selectedPages: ids.slice(lo, hi + 1) });
    } else {
      setState({ selectedPages: [page.id] });
      scrollToPage(index);
    }
  };

  return (
    <div
      ref={wrap}
      className={`thumb${selected ? ' selected' : ''}${current ? ' current' : ''}`}
      draggable
      onDragStart={(e) => {
        const s = getState();
        const ids = s.selectedPages.includes(page.id) ? s.selectedPages : [page.id];
        if (!s.selectedPages.includes(page.id)) setState({ selectedPages: [page.id] });
        e.dataTransfer.setData('application/x-pages', JSON.stringify(ids));
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={onClick}
    >
      <div className="thumb-img" style={{ width: THUMB_W, height: h * scale }}>
        <canvas ref={canvas} style={{ width: THUMB_W, height: h * scale }} />
        <div className="thumb-actions" onClick={(e) => e.stopPropagation()}>
          <button title="Rotate left" onClick={() => rotatePages([page.id], false)}>
            <RotateCcw size={14} />
          </button>
          <button title="Rotate right" onClick={() => rotatePages([page.id], true)}>
            <RotateCw size={14} />
          </button>
          <button title="Delete page" onClick={() => deletePages([page.id])}>
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      <div className="thumb-label">{index + 1}</div>
    </div>
  );
});

export function Sidebar() {
  const pages = useStore((s) => s.doc.pages);
  const selected = useStore((s) => s.selectedPages);
  const current = useStore((s) => s.currentPage);
  const [dropAt, setDropAt] = useState<number | null>(null);

  const targetIds = () => (selected.length ? selected : pages[current] ? [pages[current].id] : []);

  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('application/x-pages')) return;
    e.preventDefault();
    const thumbs = Array.from((e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('.thumb'));
    let at = thumbs.length;
    for (let i = 0; i < thumbs.length; i++) {
      const r = thumbs[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) {
        at = i;
        break;
      }
    }
    setDropAt(at);
  };
  const onDrop = (e: React.DragEvent) => {
    const raw = e.dataTransfer.getData('application/x-pages');
    if (!raw) return;
    e.preventDefault();
    e.stopPropagation();
    if (dropAt !== null) movePages(JSON.parse(raw), dropAt);
    setDropAt(null);
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span>Pages</span>
        <span className="muted">
          {selected.length > 1 ? `${selected.length} selected` : `${current + 1} / ${pages.length}`}
        </span>
      </div>
      <div className="thumbs" onDragOver={onDragOver} onDragLeave={() => setDropAt(null)} onDrop={onDrop}>
        {pages.map((p, i) => (
          <div key={p.id}>
            {dropAt === i && <div className="drop-line" />}
            <Thumb page={p} index={i} selected={selected.includes(p.id)} current={i === current} />
          </div>
        ))}
        {dropAt === pages.length && <div className="drop-line" />}
      </div>
      <div className="sidebar-foot">
        <button title="Rotate selected left" onClick={() => rotatePages(targetIds(), false)}>
          <RotateCcw size={16} />
        </button>
        <button title="Rotate selected right" onClick={() => rotatePages(targetIds(), true)}>
          <RotateCw size={16} />
        </button>
        <button title="Delete selected pages" onClick={() => deletePages(targetIds())}>
          <Trash2 size={16} />
        </button>
        <button title="Insert blank page after current" onClick={() => insertBlankPage(current)}>
          <SquarePlus size={16} />
        </button>
        <button title="Insert pages from another PDF after current" onClick={async () => appendFiles(await platform.openPdfs(true), current)}>
          <FilePlus2 size={16} />
        </button>
        <button title="Export selected pages as a new PDF" onClick={() => exportSelectedPages()}>
          <FileOutput size={16} />
        </button>
      </div>
    </aside>
  );
}
