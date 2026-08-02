/**
 * Duration probing.
 *
 * The spec reaches for an ffprobe sidecar, but we only ever need durations for
 * files that are already on disk, and the webview will read metadata off a
 * local asset URL in a millisecond or two without shipping a second binary.
 * Music keeps whatever duration the wiki gave us and is measured lazily when a
 * row scrolls into view.
 */

const PROBE_TIMEOUT_MS = 8000;

export function probeDuration(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const el = new Audio();
    let settled = false;

    const done = (v: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      el.removeAttribute('src');
      el.load();
      resolve(v);
    };

    const timer = setTimeout(() => done(null), PROBE_TIMEOUT_MS);
    el.addEventListener('loadedmetadata', () =>
      done(Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null),
    );
    el.addEventListener('error', () => done(null));

    el.preload = 'metadata';
    el.src = url;
  });
}

export type ProbeProgress = (done: number, total: number) => void;

/** Probe a batch with bounded concurrency. Local reads, so 8 lanes is polite. */
export async function probeAll(
  entries: { id: string; url: string }[],
  onProgress?: ProbeProgress,
  signal?: AbortSignal,
  concurrency = 8,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  let cursor = 0;
  let finished = 0;

  const worker = async () => {
    for (;;) {
      if (signal?.aborted) return;
      const i = cursor++;
      if (i >= entries.length) return;
      const d = await probeDuration(entries[i].url);
      if (d != null) out.set(entries[i].id, d);
      finished += 1;
      if (finished % 25 === 0 || finished === entries.length) onProgress?.(finished, entries.length);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
  return out;
}
