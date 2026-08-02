import { useEffect, useMemo, useRef } from 'react';

import { probeDuration } from '../lib/duration';
import { formatDuration } from '../lib/format';
import { groupKey, type UrlResolver } from '../lib/library';
import { tileFor } from '../lib/sprite';
import { useScrollReset, useWindowing } from '../lib/virtual';
import type { Clip } from '../types';

const ROW_HEIGHT = 44;

type Props = {
  clips: Clip[];
  resolve: UrlResolver;
  groups: Record<string, string[]>;
  byId: Map<string, Clip>;
  variantChoices: Record<string, string>;
  onVariant: (group: string, clipId: string) => void;
  favorites: Set<string>;
  onFavorite: (id: string) => void;
  nowPlaying: string | null;
  onPlay: (clip: Clip) => void;
  spriteUrlFor: (clip: Clip) => string | null;
  canDrag: (clip: Clip) => boolean;
  onGrab: (clip: Clip) => void;
  onGrabHover: (clip: Clip) => void;
  durationOf: (clip: Clip) => number | null;
  onDuration: (id: string, seconds: number) => void;
  emptyHint: string;
};

export function Library({
  clips,
  resolve,
  groups,
  byId,
  variantChoices,
  onVariant,
  favorites,
  onFavorite,
  nowPlaying,
  onPlay,
  spriteUrlFor,
  canDrag,
  onGrab,
  onGrabHover,
  durationOf,
  onDuration,
  emptyHint,
}: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const slice = useWindowing(scroller, clips.length, ROW_HEIGHT, 6);
  useScrollReset(scroller, clips.length);
  const probed = useRef(new Set<string>());

  const effective = useMemo(
    () =>
      (clip: Clip): Clip => {
        const chosen = variantChoices[groupKey(clip)];
        return chosen && chosen !== clip.id ? byId.get(chosen) ?? clip : clip;
      },
    [variantChoices, byId],
  );

  const visible = clips.slice(slice.start, slice.end);

  /**
   * Music durations are only measured when a row actually comes into view.
   * Probing 2,281 remote tracks up front would add minutes to setup for
   * information almost none of which gets looked at.
   */
  useEffect(() => {
    const pending = visible.filter((c) => durationOf(c) == null && !probed.current.has(c.id));
    if (!pending.length) return;

    let cancelled = false;
    void (async () => {
      for (const clip of pending) {
        if (cancelled) return;
        probed.current.add(clip.id);
        const d = await probeDuration(resolve(clip));
        if (!cancelled && d != null) onDuration(clip.id, d);
      }
    })();

    return () => {
      cancelled = true;
    };
    // Re-runs as the window moves; `probed` keeps it from repeating work.
  }, [slice.start, slice.end, clips, durationOf, onDuration, resolve]);

  if (!clips.length) return <div className="empty">{emptyHint}</div>;

  return (
    <div className="lib-scroller" ref={scroller}>
      <div style={{ height: slice.totalHeight, position: 'relative' }}>
        <div style={{ position: 'absolute', top: slice.offset, left: 0, right: 0 }}>
          {visible.map((listed) => {
            const clip = effective(listed);
            const tile = tileFor(clip);
            const sprite = spriteUrlFor(clip);
            const variants = (groups[groupKey(listed)] ?? [])
              .map((id) => byId.get(id))
              .filter((c): c is Clip => !!c);

            return (
              <div
                key={listed.id}
                className={`lib-row${nowPlaying === clip.id ? ' playing' : ''}`}
                style={{ height: ROW_HEIGHT }}
                onDoubleClick={() => onPlay(clip)}
              >
                <button className="lib-play" onClick={() => onPlay(clip)} title="Play">
                  <span className="lib-tile" style={{ background: tile.background, color: tile.color }}>
                    {nowPlaying === clip.id ? (
                      '▶'
                    ) : sprite ? (
                      <img src={sprite} alt="" draggable={false} />
                    ) : (
                      tile.label
                    )}
                  </span>
                </button>

                <span className="lib-title" title={clip.displayFile}>
                  {clip.title}
                </span>
                <span className="lib-context">{clip.context ?? clip.desc ?? ''}</span>

                <span className="lib-variants">
                  {variants.length > 1 &&
                    variants.map((v) => (
                      <button
                        key={v.id}
                        className={v.id === clip.id ? 'vchip on' : 'vchip'}
                        onClick={(e) => {
                          e.stopPropagation();
                          onVariant(groupKey(listed), v.id);
                        }}
                        title={v.displayFile}
                      >
                        {v.variant ?? '●'}
                      </button>
                    ))}
                </span>

                <span className="lib-kind">{clip.kind}</span>
                <span className="lib-dur">{formatDuration(durationOf(clip))}</span>

                {canDrag(clip) && (
                  <span
                    className="lib-grab"
                    title="Drag this file into another app"
                    onPointerEnter={() => onGrabHover(clip)}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      onGrab(clip);
                    }}
                  >
                    ⠿
                  </span>
                )}

                <button
                  className={favorites.has(clip.id) ? 'star on' : 'star'}
                  onClick={(e) => {
                    e.stopPropagation();
                    onFavorite(clip.id);
                  }}
                  title="Favourite"
                >
                  {favorites.has(clip.id) ? '★' : '☆'}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
