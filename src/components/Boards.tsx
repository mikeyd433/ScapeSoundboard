import { useState } from 'react';

import { BOARD_DIMS, keyForSlot, type Board, type BoardSize } from '../lib/boards';
import type { Clip } from '../types';
import { Pad } from './Pad';
import { PadMenu } from './PadMenu';
import type { PadEnv } from './PadEnv';

const GAP = 8;

type BarProps = {
  boards: Board[];
  /** null is the browse-everything grid rather than a saved board. */
  view: string | null;
  onView: (v: string | null) => void;
  onCreate: () => void;
  onUpdate: (board: Board) => void;
  onDelete: (id: string) => void;
  editing: boolean;
  onEditing: (v: boolean) => void;
};

export function BoardBar({
  boards,
  view,
  onView,
  onCreate,
  onUpdate,
  onDelete,
  editing,
  onEditing,
}: BarProps) {
  const active = boards.find((b) => b.id === view) ?? null;

  return (
    <div className="board-bar">
      <div className="board-tabs">
        <button
          className={view === null ? 'board-tab active' : 'board-tab'}
          onClick={() => onView(null)}
        >
          All sounds
        </button>
        {boards.map((b, i) => (
          <button
            key={b.id}
            className={b.id === view ? 'board-tab active' : 'board-tab'}
            onClick={() => onView(b.id)}
            title={i < 9 ? `Alt+${i + 1}` : undefined}
          >
            {b.name}
            {i < 9 && <span className="board-alt">{i + 1}</span>}
          </button>
        ))}
        <button className="board-tab add" onClick={onCreate} title="New board">
          +
        </button>
      </div>

      {active && (
        <div className="board-tools">
          <button
            className={editing ? 'chip on' : 'chip'}
            onClick={() => onEditing(!editing)}
            title="Rearrange pads instead of playing them"
          >
            {editing ? 'Done' : 'Edit layout'}
          </button>

          {editing && (
            <>
              <input
                className="board-name"
                value={active.name}
                onChange={(e) => onUpdate({ ...active, name: e.target.value })}
                aria-label="Board name"
              />
              <select
                className="select"
                value={active.size}
                onChange={(e) => onUpdate(resize(active, e.target.value as BoardSize))}
              >
                <option value="4x4">4 × 4</option>
                <option value="8x8">8 × 8</option>
              </select>
              <button
                className="ghost small danger"
                onClick={() => {
                  if (confirm(`Delete the board "${active.name}"?`)) onDelete(active.id);
                }}
              >
                Delete
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Kept here rather than imported so the bar owns the whole resize interaction.
function resize(board: Board, size: BoardSize): Board {
  const { cols, rows } = BOARD_DIMS[size];
  const next = Array<string | null>(cols * rows).fill(null);
  for (let i = 0; i < Math.min(board.slots.length, next.length); i++) next[i] = board.slots[i];
  return { ...board, size, slots: next };
}

export function BoardGrid({
  board,
  padSize,
  env,
  editing,
  onUpdate,
}: {
  board: Board;
  padSize: number;
  env: PadEnv;
  editing: boolean;
  onUpdate: (b: Board) => void;
}) {
  const { cols } = BOARD_DIMS[board.size];
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);
  const [menu, setMenu] = useState<{ clip: Clip; slot: number; x: number; y: number } | null>(null);

  const swap = (a: number, b: number) => {
    if (a === b) return;
    const slots = board.slots.slice();
    [slots[a], slots[b]] = [slots[b], slots[a]];
    onUpdate({ ...board, slots });
  };

  return (
    <div className="board-scroller">
      <div
        className="board-grid"
        style={{ gridTemplateColumns: `repeat(${cols}, ${padSize}px)`, gap: GAP }}
        onPointerUp={() => {
          if (drag) {
            swap(drag.from, drag.over);
            setDrag(null);
          }
        }}
        onPointerLeave={() => setDrag(null)}
      >
        {board.slots.map((clipId, i) => {
          // A board stores a specific clip id, variant and all, so there is no
          // variant resolution to do here — a missing id just leaves a hole.
          const clip = clipId ? env.lookup(clipId) : null;
          const isDragSource = drag?.from === i;
          const isDragTarget = drag != null && drag.over === i && drag.from !== i;

          return (
            <div
              key={i}
              className={`board-slot${isDragTarget ? ' drop' : ''}${isDragSource ? ' dragging' : ''}`}
              style={{ width: padSize, height: padSize }}
              onPointerEnter={() => drag && setDrag({ ...drag, over: i })}
              onPointerDown={(e) => {
                if (editing && e.button === 0 && clip) setDrag({ from: i, over: i });
              }}
            >
              {clip ? (
                <Pad
                  clip={clip}
                  size={padSize}
                  setting={env.pads[clip.id] ?? { gain: 1, rate: 1 }}
                  resolve={env.resolve}
                  favorite={env.favorites.has(clip.id)}
                  keyHint={keyForSlot(i)}
                  spriteUrl={env.spriteUrlFor(clip)}
                  inert={editing}
                  selected={env.selection?.has(clip.id)}
                  onSelect={env.onSelect ? (e) => env.onSelect!(clip.id, e) : undefined}
                  onGrab={env.onGrab && env.canDrag?.(clip) ? (e) => env.onGrab!(clip, e) : undefined}
                  onGrabHover={env.onGrabHover ? () => env.onGrabHover!(clip) : undefined}
                  gestureDrag={env.gestureDrag}
                  onMenu={(x, y) => setMenu({ clip, slot: i, x, y })}
                />
              ) : (
                <div className="board-empty">
                  <span className="board-empty-key">{keyForSlot(i) ?? ''}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {!board.slots.some(Boolean) && (
        <p className="board-hint">
          Empty board. Right-click any pad on the <strong>All sounds</strong> view and choose
          “Add to board”. Slots 1–16 are bound to the number and QWERTY rows.
        </p>
      )}

      {menu && (
        <PadMenu
          listed={menu.clip}
          clip={menu.clip}
          x={menu.x}
          y={menu.y}
          setting={env.pads[menu.clip.id] ?? { gain: 1, rate: 1 }}
          onPad={env.onPad}
          variants={env.variantsOf(menu.clip)}
          onVariant={(id) => env.onVariant(env.groupOf(menu.clip), id)}
          favorite={env.favorites.has(menu.clip.id)}
          onFavorite={() => env.onFavorite(menu.clip.id)}
          boards={env.boards}
          onAddToBoard={(boardId) => {
            env.onAddToBoard(boardId, menu.clip.id);
            setMenu(null);
          }}
          onRemoveFromBoard={() => {
            const slots = board.slots.slice();
            slots[menu.slot] = null;
            onUpdate({ ...board, slots });
            setMenu(null);
          }}
          onChangeIcon={
            env.onChangeIcon
              ? () => {
                  env.onChangeIcon!(menu.clip);
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
