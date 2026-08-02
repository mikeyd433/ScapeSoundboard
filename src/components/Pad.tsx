import { useRef, useState } from 'react';

import { engine } from '../lib/audio';
import { formatShortDuration } from '../lib/format';
import type { UrlResolver } from '../lib/library';
import { tileFor } from '../lib/sprite';
import type { Clip, PadSetting } from '../types';

export type PadProps = {
  clip: Clip;
  size: number;
  setting: PadSetting;
  resolve: UrlResolver;
  favorite: boolean;
  /** The listed clip is showing a different variant than the one stored. */
  swapped?: boolean;
  /** Keyboard binding shown in the corner on board slots. */
  keyHint?: string | null;
  selected?: boolean;
  /** Sprite thumbnail, when the wiki gave us one. Falls back to a tile. */
  spriteUrl?: string | null;
  /** Edit mode: the pad is being arranged, not played. */
  inert?: boolean;
  onMenu?: (x: number, y: number) => void;
  onSelect?: (e: React.PointerEvent) => void;
  /** Grab strip in the corner — starts a native file drag (spec §8). */
  onGrab?: (e: React.PointerEvent) => void;
  onGrabHover?: () => void;
  /** Opt-in: dragging from anywhere on the pad, not just the handle. */
  gestureDrag?: boolean;
};

/** Movement past this many pixels turns a press into a drag. */
const DRAG_THRESHOLD_PX = 6;

export function Pad({
  clip,
  size,
  setting,
  resolve,
  favorite,
  swapped,
  keyHint,
  selected,
  spriteUrl,
  inert,
  onMenu,
  onSelect,
  onGrab,
  onGrabHover,
  gestureDrag,
}: PadProps) {
  const [lit, setLit] = useState(false);
  // A sprite URL can point at the wiki before the local copy lands, so a broken
  // image has to fall back to the tile rather than leaving a hole in the pad.
  const [spriteFailed, setSpriteFailed] = useState(false);
  const tile = tileFor(clip);
  const showSprite = spriteUrl && !spriteFailed;

  const origin = useRef<{ x: number; y: number } | null>(null);
  const dragging = useRef(false);

  const fire = () => {
    // pointerdown, not click: hearing the sound the instant the mouse goes down
    // is the whole point, and it lets a pad be hammered.
    void engine.playSfx(clip.id, resolve(clip), { gain: setting.gain, rate: setting.rate });
    setLit(true);
    window.setTimeout(() => setLit(false), 140);
  };

  return (
    <div
      className={`pad${lit ? ' lit' : ''}${selected ? ' selected' : ''}${inert ? ' inert' : ''}`}
      style={{ width: size, height: size, background: tile.background }}
      // HTML5 drag would fight the native OS drag, so it is off everywhere.
      draggable={false}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        if (onSelect && (e.ctrlKey || e.metaKey || e.shiftKey)) {
          onSelect(e);
          return;
        }
        // Reset here rather than on pointerup: once the OS drag loop takes over
        // the webview stops receiving pointer events, so pointerup may never
        // arrive. Every fresh press is the reliable place to start clean.
        origin.current = { x: e.clientX, y: e.clientY };
        dragging.current = false;
        if (inert) return;
        fire();
        // Warm the staging directory while the sound is playing.
        if (gestureDrag) onGrabHover?.();
      }}
      onPointerMove={(e) => {
        if (!gestureDrag || !onGrab || !origin.current || dragging.current) return;
        const moved = Math.hypot(e.clientX - origin.current.x, e.clientY - origin.current.y);
        if (moved < DRAG_THRESHOLD_PX) return;
        dragging.current = true;
        onGrab(e);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu?.(e.clientX, e.clientY);
      }}
      title={`${clip.displayFile}${clip.context ? `\n${clip.context}` : ''}`}
    >
      {onGrab && (
        <span
          className="pad-grab"
          title="Drag this file into another app"
          onPointerEnter={onGrabHover}
          onPointerDown={(e) => {
            // Handle drags never fire the sound — unambiguous by design.
            e.stopPropagation();
            e.preventDefault();
            onGrab(e);
          }}
        >
          ⠿
        </span>
      )}

      {keyHint && <span className="pad-key">{keyHint}</span>}

      {showSprite ? (
        <img
          className="pad-sprite"
          src={spriteUrl}
          alt=""
          draggable={false}
          onError={() => setSpriteFailed(true)}
        />
      ) : (
        <span className="pad-tile" style={{ color: tile.color }}>
          {tile.label}
        </span>
      )}

      <span className="pad-title">{clip.title}</span>
      {clip.context && <span className="pad-context">{clip.context}</span>}

      <span className="pad-foot">
        {favorite && <span className="star on">★</span>}
        {swapped && clip.variant && <span className="pad-variant">{clip.variant}</span>}
        <span className="pad-dur">{formatShortDuration(clip.duration)}</span>
      </span>
    </div>
  );
}
