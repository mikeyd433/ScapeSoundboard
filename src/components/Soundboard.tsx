import { useRef, useState } from 'react';

import { useElementSize, useScrollReset, useWindowing } from '../lib/virtual';
import type { Clip } from '../types';
import { Pad } from './Pad';
import { PadMenu } from './PadMenu';
import type { PadEnv } from './PadEnv';

const GAP = 8;

type Props = {
  clips: Clip[];
  padSize: number;
  env: PadEnv;
  emptyHint: string;
};

export function Soundboard({ clips, padSize, env, emptyHint }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const { width } = useElementSize(scroller);
  const [menu, setMenu] = useState<{ clip: Clip; x: number; y: number } | null>(null);

  const cols = Math.max(1, Math.floor((width - GAP) / (padSize + GAP)) || 1);
  const rowHeight = padSize + GAP;
  const rowCount = Math.ceil(clips.length / cols);
  const slice = useWindowing(scroller, rowCount, rowHeight);
  useScrollReset(scroller, clips.length);

  if (!clips.length) return <div className="empty">{emptyHint}</div>;

  const rows = [];
  for (let r = slice.start; r < slice.end; r++) {
    const cells = clips.slice(r * cols, r * cols + cols);
    rows.push(
      <div className="pad-row" key={r} style={{ height: rowHeight, gap: GAP }}>
        {cells.map((listed) => {
          const clip = env.effective(listed);
          return (
            <Pad
              key={listed.id}
              clip={clip}
              size={padSize}
              setting={env.pads[clip.id] ?? { gain: 1, rate: 1 }}
              resolve={env.resolve}
              favorite={env.favorites.has(clip.id)}
              swapped={clip.id !== listed.id}
              spriteUrl={env.spriteUrlFor(clip)}
              selected={env.selection?.has(clip.id)}
              onSelect={env.onSelect ? (e) => env.onSelect!(clip.id, e) : undefined}
              onGrab={env.onGrab && env.canDrag?.(clip) ? (e) => env.onGrab!(clip, e) : undefined}
              onGrabHover={env.onGrabHover ? () => env.onGrabHover!(clip) : undefined}
              gestureDrag={env.gestureDrag}
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
          clip={env.effective(menu.clip)}
          x={menu.x}
          y={menu.y}
          setting={env.pads[env.effective(menu.clip).id] ?? { gain: 1, rate: 1 }}
          onPad={env.onPad}
          variants={env.variantsOf(menu.clip)}
          onVariant={(id) => env.onVariant(env.groupOf(menu.clip), id)}
          favorite={env.favorites.has(env.effective(menu.clip).id)}
          onFavorite={() => env.onFavorite(env.effective(menu.clip).id)}
          boards={env.boards}
          onAddToBoard={(boardId) => {
            env.onAddToBoard(boardId, env.effective(menu.clip).id);
            setMenu(null);
          }}
          onChangeIcon={
            env.onChangeIcon
              ? () => {
                  env.onChangeIcon!(env.effective(menu.clip));
                  setMenu(null);
                }
              : undefined
          }
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
