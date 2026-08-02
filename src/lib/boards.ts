import type { Clip } from '../types';

/**
 * Saved pad layouts (spec §4 / phase 4).
 *
 * A board is a fixed grid of slots, each either empty or pointing at a clip id.
 * Slots are addressed by index so reordering is a swap, and a clip that later
 * disappears from the manifest leaves a hole rather than corrupting the board.
 */

export type BoardSize = '4x4' | '8x8';

export type Board = {
  id: string;
  name: string;
  size: BoardSize;
  /** Length is always cols*rows for the size; null means an empty slot. */
  slots: (string | null)[];
};

export const BOARD_DIMS: Record<BoardSize, { cols: number; rows: number }> = {
  '4x4': { cols: 4, rows: 4 },
  '8x8': { cols: 8, rows: 8 },
};

export function slotCount(size: BoardSize): number {
  const { cols, rows } = BOARD_DIMS[size];
  return cols * rows;
}

/**
 * Number row then QWERTY row — 16 bindings, as the spec asks for. On an 8x8
 * board only the first 16 slots get a key; the rest are mouse-only.
 */
export const BOARD_KEYS = [
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  'q',
  'w',
  'e',
  'r',
  't',
  'y',
  'u',
  'i',
] as const;

export function keyForSlot(index: number): string | null {
  return index < BOARD_KEYS.length ? BOARD_KEYS[index].toUpperCase() : null;
}

export function slotForKey(key: string): number {
  return (BOARD_KEYS as readonly string[]).indexOf(key.toLowerCase());
}

let counter = 0;
function newId(): string {
  // Boards are created by hand, one at a time, so a counter plus the clock is
  // more than enough to keep ids distinct.
  counter += 1;
  return `b${Date.now().toString(36)}${counter.toString(36)}`;
}

export function makeBoard(name: string, size: BoardSize = '4x4'): Board {
  return { id: newId(), name, size, slots: Array(slotCount(size)).fill(null) };
}

/** Grow or shrink a board's slot array to match a new size, keeping what fits. */
export function resizeBoard(board: Board, size: BoardSize): Board {
  const next = Array<string | null>(slotCount(size)).fill(null);
  for (let i = 0; i < Math.min(board.slots.length, next.length); i++) next[i] = board.slots[i];
  return { ...board, size, slots: next };
}

export function firstEmptySlot(board: Board): number {
  return board.slots.findIndex((s) => s === null);
}

/** Put a clip in the first free slot. Returns null when the board is full. */
export function addToBoard(board: Board, clipId: string): Board | null {
  const i = firstEmptySlot(board);
  if (i < 0) return null;
  const slots = board.slots.slice();
  slots[i] = clipId;
  return { ...board, slots };
}

export function setSlot(board: Board, index: number, clipId: string | null): Board {
  const slots = board.slots.slice();
  slots[index] = clipId;
  return { ...board, slots };
}

/** Drag one slot onto another: swap them, which handles both move and reorder. */
export function swapSlots(board: Board, a: number, b: number): Board {
  if (a === b) return board;
  const slots = board.slots.slice();
  [slots[a], slots[b]] = [slots[b], slots[a]];
  return { ...board, slots };
}

export function boardClips(board: Board, byId: Map<string, Clip>): (Clip | null)[] {
  return board.slots.map((id) => (id ? byId.get(id) ?? null : null));
}

export const DEFAULT_BOARD_NAME = 'Board 1';
