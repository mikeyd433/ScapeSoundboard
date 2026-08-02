import type { TransportState } from '../lib/audio';
import { formatDuration } from '../lib/format';
import { tileFor } from '../lib/sprite';
import type { Clip } from '../types';

type Props = {
  clip: Clip | null;
  state: TransportState;
  onToggle: () => void;
  onSeek: (seconds: number) => void;
  onPrev: () => void;
  onNext: () => void;
  onLoop: (v: boolean) => void;
  shuffle: boolean;
  onShuffle: (v: boolean) => void;
  musicVolume: number;
  onMusicVolume: (v: number) => void;
};

export function Transport({
  clip,
  state,
  onToggle,
  onSeek,
  onPrev,
  onNext,
  onLoop,
  shuffle,
  onShuffle,
  musicVolume,
  onMusicVolume,
}: Props) {
  if (!clip) return null;
  const tile = tileFor(clip);
  const duration = state.duration || clip.duration || 0;

  return (
    <div className="transport">
      <span className="tr-tile" style={{ background: tile.background, color: tile.color }}>
        {tile.label}
      </span>

      <span className="tr-meta">
        <span className="tr-title">{clip.title}</span>
        <span className="tr-sub">
          {state.error ?? clip.context ?? clip.kind}
        </span>
      </span>

      <button className="tr-btn" onClick={onPrev} title="Previous">
        ⏮
      </button>
      <button className="tr-btn play" onClick={onToggle} title="Play / pause (Space)">
        {state.playing ? '⏸' : '▶'}
      </button>
      <button className="tr-btn" onClick={onNext} title="Next">
        ⏭
      </button>

      <span className="tr-time">{formatDuration(state.currentTime)}</span>
      <input
        className="tr-seek"
        type="range"
        min={0}
        max={Math.max(duration, 0.1)}
        step={0.1}
        value={Math.min(state.currentTime, duration || state.currentTime)}
        onChange={(e) => onSeek(Number(e.target.value))}
        disabled={!duration}
      />
      <span className="tr-time">{formatDuration(duration || null)}</span>

      <button
        className={state.loop ? 'tr-btn on' : 'tr-btn'}
        onClick={() => onLoop(!state.loop)}
        title="Loop"
      >
        ⟲
      </button>
      <button
        className={shuffle ? 'tr-btn on' : 'tr-btn'}
        onClick={() => onShuffle(!shuffle)}
        title="Shuffle"
      >
        ⤨
      </button>

      <label className="vol" title="Music volume">
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={musicVolume}
          onChange={(e) => onMusicVolume(Number(e.target.value))}
        />
      </label>
    </div>
  );
}
