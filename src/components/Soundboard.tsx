import { useEffect, useMemo, useRef, useState } from 'react';

import { engine } from '../lib/audio';
import { formatShortDuration } from '../lib/format';
import { groupKey, type UrlResolver } from '../lib/library';
import { tileFor } from '../lib/sprite';
import { useElementSize, useScrollReset, useWindowing } from '../lib/virtual';
import { DEFAULT_PAD, type Clip, type PadSetting } from '../types';

const GAP = 8;

type Props = {
  clips: Clip[];
  resolve: UrlResolver;
  padSize: number;
  pads: Record<string, PadSetting>;
  onPad: (id: string, s: PadSetting) => void;
  groups: Record<string, string[]>;
  byId: Map<string, Clip>;
  variantChoices: Record<string, string>;
  onVariant: (group: string, clipId: string) => void;
  favorites: Set<string>;
  onFavorite: (id: string) => void;
  emptyHint: string;
};

export function Soundboard({
  clips,
  resolve,
  padSize,
  pads,
  onPad,
  groups,
  byId,
  variantChoices,
  onVariant,
  favorites,
  onFavorite,
  emptyHint,
}: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const { width } = useElementSize(scroller);
  const [menu, setMenu] = useState<{ clip: Clip; x: number; y: number } | null>(null);

  const cols = Math.max(1, Math.floor((width - GAP) / (padSize + GAP)) || 1);
  const rowHeight = padSize + GAP;
  const rowCount = Math.ceil(clips.length / cols);
  const slice = useWindowing(scroller, rowCount, rowHeight);
  useScrollReset(scroller, clips.length);

  /** A pad may be pointed at a different variant than the one in the list. */
  const effective = useMemo(() => {
    return (clip: Clip): Clip => {
      const chosen = variantChoices[groupKey(clip)];
      return chosen && chosen !== clip.id ? byId.get(chosen) ?? clip : clip;
    };
  }, [variantChoices, byId]);

  if (!clips.length) {
    return <div className="empty">{emptyHint}</div>;
  }

  const rows = [];
  for (let r = slice.start; r < slice.end; r++) {
    const cells = clips.slice(r * cols, r * cols + cols);
    rows.push(
      <div className="pad-row" key={r} style={{ height: rowHeight, gap: GAP }}>
        {cells.map((listed) => {
          const clip = effective(listed);
          return (
            <Pad
              key={listed.id}
              clip={clip}
              size={padSize}
              setting={pads[clip.id] ?? DEFAULT_PAD}
              resolve={resolve}
              favorite={favorites.has(clip.id)}
              swapped={clip.id !== listed.id}
              onMenu={(x, y) => setMenu({ clip: listed, x, y })}
            />
          );
        })}
      </div>,
    );
  }

  return (
    <div className="pad-scroller" ref={scroller}>
      <div style={{ height: slice.totalHeight, position: 'relative' }}>
        <div style={{ position: 'absolute', top: slice.offset, left: 0, right: 0 }}>{rows}</div>
      </div>

      {menu && (
        <PadMenu
          listed={menu.clip}
          clip={effective(menu.clip)}
          x={menu.x}
          y={menu.y}
          setting={pads[effective(menu.clip).id] ?? DEFAULT_PAD}
          onPad={onPad}
          variants={(groups[groupKey(menu.clip)] ?? [])
            .map((id) => byId.get(id))
            .filter((c): c is Clip => !!c)}
          onVariant={(id) => onVariant(groupKey(menu.clip), id)}
          favorite={favorites.has(effective(menu.clip).id)}
          onFavorite={() => onFavorite(effective(menu.clip).id)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function Pad({
  clip,
  size,
  setting,
  resolve,
  favorite,
  swapped,
  onMenu,
}: {
  clip: Clip;
  size: number;
  setting: PadSetting;
  resolve: UrlResolver;
  favorite: boolean;
  swapped: boolean;
  onMenu: (x: number, y: number) => void;
}) {
  const [lit, setLit] = useState(false);
  const tile = tileFor(clip);

  const fire = () => {
    // pointerdown, not click: hearing the sound the instant the mouse goes down
    // is the whole point, and it lets a pad be hammered.
    void engine.playSfx(clip.id, resolve(clip), { gain: setting.gain, rate: setting.rate });
    setLit(true);
    window.setTimeout(() => setLit(false), 140);
  };

  return (
    <button
      className={`pad${lit ? ' lit' : ''}`}
      style={{ width: size, height: size, background: tile.background }}
      onPointerDown={(e) => {
        if (e.button === 0) fire();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
      title={`${clip.displayFile}${clip.context ? `\n${clip.context}` : ''}`}
    >
      <span className="pad-tile" style={{ color: tile.color }}>
        {tile.label}
      </span>
      <span className="pad-title">{clip.title}</span>
      {clip.context && <span className="pad-context">{clip.context}</span>}
      <span className="pad-foot">
        {favorite && <span className="star on">★</span>}
        {swapped && clip.variant && <span className="pad-variant">{clip.variant}</span>}
        <span className="pad-dur">{formatShortDuration(clip.duration)}</span>
      </span>
    </button>
  );
}

function PadMenu({
  listed,
  clip,
  x,
  y,
  setting,
  onPad,
  variants,
  onVariant,
  favorite,
  onFavorite,
  onClose,
}: {
  listed: Clip;
  clip: Clip;
  x: number;
  y: number;
  setting: PadSetting;
  onPad: (id: string, s: PadSetting) => void;
  variants: Clip[];
  onVariant: (id: string) => void;
  favorite: boolean;
  onFavorite: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    // Capture phase, so Escape closes the menu instead of reaching the global
    // panic handler.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  // Keep the panel on screen when the pad is near an edge.
  const style = {
    left: Math.min(x, window.innerWidth - 268),
    top: Math.min(y, window.innerHeight - 300),
  };

  return (
    <div className="pad-menu" style={style} ref={ref}>
      <div className="menu-title">{clip.displayFile}</div>

      {variants.length > 1 && (
        <>
          <div className="menu-label">Variant</div>
          <div className="variant-chips">
            {variants.map((v) => (
              <button
                key={v.id}
                className={v.id === clip.id ? 'chip on' : 'chip'}
                onClick={() => onVariant(v.id)}
              >
                {v.variant ?? 'current'}
              </button>
            ))}
          </div>
        </>
      )}

      <div className="menu-label">Volume · {Math.round(setting.gain * 100)}%</div>
      <input
        type="range"
        min={0}
        max={2}
        step={0.05}
        value={setting.gain}
        onChange={(e) => onPad(clip.id, { ...setting, gain: Number(e.target.value) })}
      />

      <div className="menu-label">Pitch / speed · {setting.rate.toFixed(2)}×</div>
      <input
        type="range"
        min={0.25}
        max={2.5}
        step={0.01}
        value={setting.rate}
        onChange={(e) => onPad(clip.id, { ...setting, rate: Number(e.target.value) })}
      />

      <div className="menu-row">
        <button className="ghost small" onClick={onFavorite}>
          {favorite ? '★ Favourited' : '☆ Favourite'}
        </button>
        <button
          className="ghost small"
          onClick={() => {
            onPad(clip.id, { ...DEFAULT_PAD });
            onVariant(listed.id);
          }}
        >
          Reset
        </button>
      </div>
    </div>
  );
}
