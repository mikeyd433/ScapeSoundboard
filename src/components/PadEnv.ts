import type { Board } from '../lib/boards';
import type { UrlResolver } from '../lib/library';
import type { Clip, PadSetting } from '../types';

/**
 * Everything a pad needs that is the same wherever it is rendered. The browse
 * grid and the board grid draw the same component, and threading a dozen
 * individual props through both was getting silly.
 */
export type PadEnv = {
  resolve: UrlResolver;
  /** Clip by id, or null when a saved board points at something no longer present. */
  lookup: (id: string) => Clip | null;
  /** Resolves a listed clip to the variant actually selected for its group. */
  effective: (clip: Clip) => Clip;
  variantsOf: (clip: Clip) => Clip[];
  groupOf: (clip: Clip) => string;

  pads: Record<string, PadSetting>;
  onPad: (id: string, s: PadSetting) => void;
  onVariant: (group: string, clipId: string) => void;

  favorites: Set<string>;
  onFavorite: (id: string) => void;

  boards: Board[];
  onAddToBoard: (boardId: string, clipId: string) => void;

  spriteUrlFor: (clip: Clip) => string | null;
  onChangeIcon?: (clip: Clip) => void;

  /* Drag-out and multi-select (spec §8). Absent until that phase is wired. */
  selection?: Set<string>;
  onSelect?: (clipId: string, e: React.PointerEvent) => void;
  onGrab?: (clip: Clip, e: React.PointerEvent) => void;
  onGrabHover?: (clip: Clip) => void;
  gestureDrag?: boolean;
  /** False when the clip has no local file — streamed music cannot be dragged. */
  canDrag?: (clip: Clip) => boolean;
};
