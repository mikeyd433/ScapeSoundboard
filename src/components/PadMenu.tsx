import { useEffect, useRef } from 'react';

import type { Board } from '../lib/boards';
import { DEFAULT_PAD, type Clip, type PadSetting } from '../types';

type Props = {
  /** The clip as it sits in the list; `clip` is the variant actually in use. */
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
  boards: Board[];
  onAddToBoard: (boardId: string) => void;
  onRemoveFromBoard?: () => void;
  onChangeIcon?: () => void;
  onClose: () => void;
};

export function PadMenu({
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
  boards,
  onAddToBoard,
  onRemoveFromBoard,
  onChangeIcon,
  onClose,
}: Props) {
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
    top: Math.min(y, Math.max(8, window.innerHeight - 380)),
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

      {boards.length > 0 && (
        <>
          <div className="menu-label">Add to board</div>
          <div className="variant-chips">
            {boards.map((b) => (
              <button key={b.id} className="chip" onClick={() => onAddToBoard(b.id)}>
                {b.name}
              </button>
            ))}
          </div>
        </>
      )}

      <div className="menu-row">
        <button className="ghost small" onClick={onFavorite}>
          {favorite ? '★ Favourited' : '☆ Favourite'}
        </button>
        {onChangeIcon && (
          <button className="ghost small" onClick={onChangeIcon}>
            Change icon
          </button>
        )}
      </div>

      <div className="menu-row">
        {onRemoveFromBoard && (
          <button className="ghost small" onClick={onRemoveFromBoard}>
            Remove from board
          </button>
        )}
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
