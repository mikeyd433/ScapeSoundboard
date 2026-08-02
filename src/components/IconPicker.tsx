import { useEffect, useMemo, useRef, useState } from 'react';

import { guessSubjects } from '../lib/sprites';
import { api, slugify } from '../lib/wiki';
import type { Clip, SpriteInfo } from '../types';

/**
 * Manual sprite override (spec §7). Automated matching lands somewhere around
 * 60–75%; this closes the gap on the sounds you actually reach for.
 */

type Candidate = { title: string; url: string };

type Props = {
  clip: Clip;
  onPick: (sprite: SpriteInfo) => void;
  onClose: () => void;
};

export function IconPicker({ clip, onPick, onClose }: Props) {
  const [query, setQuery] = useState(clip.sprite?.subject ?? clip.title);
  const [results, setResults] = useState<Candidate[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * Every word of the filename that might name something, plus whatever else
   * the matcher already verified for this clip. A filename like
   * "100 rockcake burn fingers" has three plausible subjects in it and no way
   * to know which is meant — so offer all of them rather than guess.
   */
  const suggestions = useMemo(() => {
    const fromMatcher = clip.sprite?.alternates ?? [];
    const fromName = guessSubjects(clip.displayFile);
    const current = clip.sprite?.subject;
    return [...new Set([...fromMatcher, ...fromName])]
      .filter((s) => s.toLowerCase() !== current?.toLowerCase())
      .filter((s) => !s.includes('(') && !s.includes(')'))
      .slice(0, 12);
  }, [clip]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setBusy(true);
      setError(null);
      try {
        const j = await api<SearchResponse>({
          action: 'query',
          generator: 'search',
          gsrsearch: q,
          gsrnamespace: '6', // File:
          gsrlimit: '24',
          prop: 'imageinfo',
          iiprop: 'url',
          iiurlwidth: '64',
        });
        if (cancelled) return;
        const found = (j.query?.pages ?? [])
          .map((p) => ({ title: p.title, url: p.imageinfo?.[0]?.thumburl ?? p.imageinfo?.[0]?.url }))
          .filter((c): c is Candidate => !!c.url && /\.(png|gif|jpe?g)$/i.test(c.title));
        setResults(found);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, 300);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  const pick = (c: Candidate) => {
    const bare = c.title.replace(/^File:/, '');
    onPick({
      file: `sprites/${slugify(bare)}.png`,
      url: c.url,
      subject: bare.replace(/\.(png|gif|jpe?g)$/i, ''),
      alternates: [],
      source: 'manual',
      confidence: 'high',
    });
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">Icon for {clip.title}</span>
          <button className="ghost small" onClick={onClose}>
            Close
          </button>
        </div>

        <input
          ref={inputRef}
          className="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search the wiki for an image…"
          spellCheck={false}
        />

        {suggestions.length > 0 && (
          <>
            <div className="menu-label">From this sound&rsquo;s name</div>
            <div className="variant-chips">
              {suggestions.map((sug) => (
                <button
                  key={sug}
                  className={sug.toLowerCase() === query.trim().toLowerCase() ? 'chip on' : 'chip'}
                  onClick={() => setQuery(sug)}
                >
                  {sug}
                </button>
              ))}
            </div>
          </>
        )}

        {error && <p className="fine">Search failed: {error}</p>}
        {busy && <p className="fine dim">Searching…</p>}
        {!busy && !error && query.trim() && !results.length && (
          <p className="fine dim">No images found.</p>
        )}

        <div className="icon-grid">
          {results.map((c) => (
            <button key={c.title} className="icon-cell" onClick={() => pick(c)} title={c.title}>
              <img src={c.url} alt="" draggable={false} />
              <span>{c.title.replace(/^File:/, '').replace(/\.\w+$/, '')}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

type SearchResponse = {
  query?: {
    pages?: { title: string; imageinfo?: { url?: string; thumburl?: string }[] }[];
  };
};
