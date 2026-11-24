import { useEffect, useRef, useState } from 'react';
import { setState, useStore, getState } from '../store';
import { viewSize } from '../lib/geometry';
import { PageView } from './PageView';

export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

export function clampZoom(z: number) {
  return Math.min(4, Math.max(0.25, z));
}

export function stepZoom(dir: 1 | -1) {
  const z = getState().zoom;
  const next = dir > 0 ? ZOOM_STEPS.find((s) => s > z + 0.001) ?? 4 : [...ZOOM_STEPS].reverse().find((s) => s < z - 0.001) ?? 0.25;
  setState({ zoom: next });
}

export function scrollToPage(index: number) {
  document.querySelector(`.page-wrap[data-page-index="${index}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  setState({ currentPage: index });
}

export function fitWidth() {
  const el = document.querySelector('.viewer');
  const pages = getState().doc.pages;
  if (!el || !pages.length) return;
  const maxW = Math.max(...pages.map((p) => viewSize(p).w));
  // fit the widest page, but do not blow small pages up beyond 150%
  setState({ zoom: clampZoom(Math.min(1.5, Math.floor(((el.clientWidth - 64) / maxW) * 100) / 100)) });
}

export function Viewer() {
  const pages = useStore((s) => s.doc.pages);
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState<Set<number>>(new Set([0, 1, 2]));

  // Which pages are near the viewport -> only those get rendered.
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const io = new IntersectionObserver(
      (entries) => {
        setVisible((prev) => {
          const next = new Set(prev);
          for (const e of entries) {
            const i = Number((e.target as HTMLElement).dataset.pageIndex);
            if (e.isIntersecting) next.add(i);
            else next.delete(i);
          }
          return next;
        });
      },
      { root, rootMargin: '1200px 0px' },
    );
    root.querySelectorAll('.page-wrap').forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [pages]);

  // Track the current page (the one crossing the middle of the viewport).
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const mid = root.getBoundingClientRect().top + root.clientHeight / 3;
        const els = Array.from(root.querySelectorAll<HTMLElement>('.page-wrap'));
        const hit = els.find((el) => el.getBoundingClientRect().bottom > mid);
        if (hit) {
          const i = Number(hit.dataset.pageIndex);
          if (i !== getState().currentPage) setState({ currentPage: i });
        }
      });
    };
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => root.removeEventListener('scroll', onScroll);
  }, []);

  // Ctrl + mouse wheel zoom, keeping the point under the cursor in place.
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const old = getState().zoom;
      const z = clampZoom(old * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
      const r = root.getBoundingClientRect();
      const px = e.clientX - r.left + root.scrollLeft;
      const py = e.clientY - r.top + root.scrollTop;
      setState({ zoom: Math.round(z * 100) / 100 });
      requestAnimationFrame(() => {
        root.scrollLeft = (px * z) / old - (e.clientX - r.left);
        root.scrollTop = (py * z) / old - (e.clientY - r.top);
      });
    };
    root.addEventListener('wheel', onWheel, { passive: false });
    return () => root.removeEventListener('wheel', onWheel);
  }, []);

  // Fit width when a new document is opened.
  const firstId = pages[0]?.docId;
  useEffect(() => {
    if (firstId) requestAnimationFrame(() => fitWidth());
  }, [firstId]);

  return (
    <div className="viewer" ref={ref}>
      <div className="pages">
        {pages.map((p, i) => (
          <PageView key={p.id} page={p} index={i} visible={visible.has(i)} />
        ))}
      </div>
    </div>
  );
}
