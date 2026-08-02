import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * Just enough windowing for a 4,700-row list and an 800-pad grid. A dependency
 * would do the same job; this is forty lines and we control the scroll maths.
 */

export function useElementSize<T extends HTMLElement>(ref: RefObject<T>) {
  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);

  return size;
}

export type Slice = { start: number; end: number; totalHeight: number; offset: number };

export function useWindowing<T extends HTMLElement>(
  ref: RefObject<T>,
  rowCount: number,
  rowHeight: number,
  overscan = 4,
): Slice {
  const [scrollTop, setScrollTop] = useState(0);
  const { height } = useElementSize(ref);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const onScroll = () => {
      // Coalesce to one update per frame; scroll events fire far faster than
      // React can usefully re-render a grid this size.
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setScrollTop(el.scrollTop);
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [ref]);

  const visible = Math.ceil((height || 600) / rowHeight);
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(rowCount, start + visible + overscan * 2);

  return { start, end, totalHeight: rowCount * rowHeight, offset: start * rowHeight };
}

/** Reset scroll to the top when the filtered result set changes out from under it. */
export function useScrollReset<T extends HTMLElement>(ref: RefObject<T>, key: unknown) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (ref.current) ref.current.scrollTop = 0;
  }, [ref, key]);
}
