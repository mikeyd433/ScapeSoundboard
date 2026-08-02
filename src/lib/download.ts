import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { DownloadItem } from './library';

export type DownloadProgress = {
  done: number;
  total: number;
  skipped: number;
  failed: number;
  bytes: number;
  current: string;
};

export type DownloadReport = {
  done: number;
  skipped: number;
  failed: { id: string; url: string; error: string }[];
  bytes: number;
  cancelled: boolean;
};

/**
 * Hands the whole work list to Rust, which downloads it three at a time and
 * skips anything already on disk at the right size — that is what makes a
 * half-finished first run resumable.
 */
export async function runDownload(
  items: DownloadItem[],
  onProgress: (p: DownloadProgress) => void,
): Promise<DownloadReport> {
  const unlisten = await listen<DownloadProgress>('download://progress', (e) => onProgress(e.payload));
  try {
    return await invoke<DownloadReport>('download_clips', { items, concurrency: 3 });
  } finally {
    unlisten();
  }
}

export async function cancelDownload(): Promise<void> {
  await invoke('cancel_download');
}

export async function librarySize(): Promise<number> {
  return invoke<number>('library_size');
}
