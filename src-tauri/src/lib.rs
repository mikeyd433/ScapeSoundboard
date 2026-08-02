//! Native side of the OSRS Soundboard.
//!
//! The frontend owns the manifest (it talks to the MediaWiki API over
//! `plugin-http`), but bulk file acquisition lives here: shuttling ~80 MB of
//! audio through the IPC bridge just to write it back to disk is wasteful, and
//! Rust gives us bounded concurrency and a clean cancel path for free.

use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncWriteExt;

/// Weird Gloop 403s generic user agents. Identify the project and give them
/// somewhere to shout at us if we misbehave. See spec §2, "Etiquette".
const USER_AGENT: &str = concat!(
    "osrs-soundboard/",
    env!("CARGO_PKG_VERSION"),
    " (https://github.com/mikeyd433/ScapeSoundboard)"
);

/// Spec §2 asks for 2–3 concurrent downloads. Treat that as a hard ceiling
/// rather than a suggestion so a bad call from the frontend can't hammer them.
const MAX_CONCURRENCY: usize = 3;

#[derive(Debug, Clone, Deserialize)]
pub struct DownloadItem {
    pub id: String,
    pub url: String,
    /// Path relative to the app data dir, e.g. `audio/sfx/whip-attack.wav`.
    pub dest: String,
    /// Byte size from the wiki's `imageinfo`. Used to detect a complete file
    /// from a previous run; 0 means "unknown, always re-download".
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Progress {
    pub done: usize,
    pub total: usize,
    pub skipped: usize,
    pub failed: usize,
    pub bytes: u64,
    pub current: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FailedItem {
    pub id: String,
    pub url: String,
    pub error: String,
}

#[derive(Debug, Serialize)]
pub struct DownloadReport {
    pub done: usize,
    pub skipped: usize,
    pub failed: Vec<FailedItem>,
    pub bytes: u64,
    pub cancelled: bool,
}

#[derive(Default)]
pub struct CancelFlag(Arc<AtomicBool>);

/// Reject anything that could escape the app data dir. `dest` is built by our
/// own frontend from slugified titles, but wiki titles are attacker-adjacent
/// input and this check is one line.
fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() {
        return Err(format!("absolute destination rejected: {rel}"));
    }
    for c in rel_path.components() {
        match c {
            Component::Normal(_) => {}
            _ => return Err(format!("unsafe destination rejected: {rel}")),
        }
    }
    Ok(root.join(rel_path))
}

async fn fetch_one(
    client: &reqwest::Client,
    item: &DownloadItem,
    root: &Path,
) -> Result<Option<u64>, String> {
    let dest = safe_join(root, &item.dest)?;

    // Resume support: a file already on disk at the expected size is done.
    // Writing through a `.part` temp file below is what makes this trustworthy.
    if item.bytes > 0 {
        if let Ok(meta) = tokio::fs::metadata(&dest).await {
            if meta.len() == item.bytes {
                return Ok(None);
            }
        }
    }

    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| e.to_string())?;
    }

    let res = client
        .get(&item.url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }

    let part = dest.with_extension("part");
    let mut file = tokio::fs::File::create(&part)
        .await
        .map_err(|e| e.to_string())?;
    let mut written: u64 = 0;
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        written += chunk.len() as u64;
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);

    // Rename last, so an interrupted run leaves a `.part` we'll simply
    // overwrite rather than a truncated file we'd mistake for complete.
    tokio::fs::rename(&part, &dest)
        .await
        .map_err(|e| e.to_string())?;
    Ok(Some(written))
}

#[tauri::command]
async fn download_clips(
    app: AppHandle,
    cancel: State<'_, CancelFlag>,
    items: Vec<DownloadItem>,
    concurrency: usize,
) -> Result<DownloadReport, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    tokio::fs::create_dir_all(&root)
        .await
        .map_err(|e| e.to_string())?;

    let flag = cancel.0.clone();
    flag.store(false, Ordering::SeqCst);

    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| e.to_string())?;

    let total = items.len();
    let done = Arc::new(AtomicUsize::new(0));
    let skipped = Arc::new(AtomicUsize::new(0));
    let bytes = Arc::new(AtomicU64::new(0));
    let failed: Arc<Mutex<Vec<FailedItem>>> = Arc::new(Mutex::new(Vec::new()));

    let lanes = concurrency.clamp(1, MAX_CONCURRENCY);

    futures_util::stream::iter(items)
        .for_each_concurrent(lanes, |item| {
            let (client, root, app) = (client.clone(), root.clone(), app.clone());
            let (flag, done, skipped, bytes, failed) = (
                flag.clone(),
                done.clone(),
                skipped.clone(),
                bytes.clone(),
                failed.clone(),
            );
            async move {
                if flag.load(Ordering::SeqCst) {
                    return;
                }
                match fetch_one(&client, &item, &root).await {
                    Ok(Some(n)) => {
                        bytes.fetch_add(n, Ordering::Relaxed);
                    }
                    Ok(None) => {
                        skipped.fetch_add(1, Ordering::Relaxed);
                    }
                    Err(e) => failed.lock().unwrap().push(FailedItem {
                        id: item.id.clone(),
                        url: item.url.clone(),
                        error: e,
                    }),
                }
                let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                let _ = app.emit(
                    "download://progress",
                    Progress {
                        done: n,
                        total,
                        skipped: skipped.load(Ordering::Relaxed),
                        failed: failed.lock().unwrap().len(),
                        bytes: bytes.load(Ordering::Relaxed),
                        current: item.id,
                    },
                );
            }
        })
        .await;

    let failed = Arc::try_unwrap(failed)
        .map(|m| m.into_inner().unwrap())
        .unwrap_or_default();

    Ok(DownloadReport {
        done: done.load(Ordering::Relaxed),
        skipped: skipped.load(Ordering::Relaxed),
        failed,
        bytes: bytes.load(Ordering::Relaxed),
        cancelled: flag.load(Ordering::SeqCst),
    })
}

#[tauri::command]
fn cancel_download(cancel: State<'_, CancelFlag>) {
    cancel.0.store(true, Ordering::SeqCst);
}

/// Absolute path of the library root, so the UI can show the user where their
/// 7 GB went and so we can build `convertFileSrc` URLs on the frontend.
#[tauri::command]
fn library_root(app: AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Bytes currently on disk under the library root. Cheap enough to run on the
/// settings screen and it is the honest answer to "how much space is this using".
#[tauri::command]
fn library_size(app: AppHandle) -> Result<u64, String> {
    fn walk(dir: &Path) -> u64 {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return 0;
        };
        entries
            .flatten()
            .map(|e| match e.file_type() {
                Ok(t) if t.is_dir() => walk(&e.path()),
                Ok(_) => e.metadata().map(|m| m.len()).unwrap_or(0),
                Err(_) => 0,
            })
            .sum()
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    Ok(walk(&dir))
}

/* ------------------------------------------------------------- drag-out ---- */

/// Fallback drag preview, used whenever a clip has no sprite of its own.
const DEFAULT_DRAG_ICON: &[u8] = include_bytes!("../icons/32x32.png");

const DRAGCACHE: &str = "dragcache";

#[derive(Debug, Deserialize)]
pub struct StageItem {
    /// Library-relative path of the real file, e.g. `audio/sfx/ab12-whip.wav`.
    pub src: String,
    /// The pretty name to hand the receiving app, e.g. `Whip attack.wav`.
    pub name: String,
}

#[derive(Debug, Serialize)]
pub struct DragPayload {
    /// One entry per requested item, in order. `None` where the source file was
    /// missing — positional, so the caller can still line results up with input.
    pub files: Vec<Option<String>>,
    pub icon: String,
}

/// Windows rejects these outright and they would break the path elsewhere.
fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' => '-',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').to_string();
    if trimmed.is_empty() {
        "clip".to_string()
    } else {
        trimmed
    }
}

fn ensure_drag_icon(dir: &Path) -> Result<PathBuf, String> {
    let path = dir.join("_icon.png");
    if !path.exists() {
        std::fs::write(&path, DEFAULT_DRAG_ICON).map_err(|e| e.to_string())?;
    }
    Ok(path)
}

/// Materialise nicely-named copies of clips for a native drag.
///
/// On disk the library uses slugs, but nobody wants `a7f3c2-abyssal-whip.ogg`
/// landing on their timeline. Hard links make this effectively free — same
/// volume, zero bytes — with a copy as the fallback.
#[tauri::command]
fn stage_drag_files(
    app: AppHandle,
    items: Vec<StageItem>,
    icon: Option<String>,
) -> Result<DragPayload, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    let cache = root.join(DRAGCACHE);
    std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;

    let mut files = Vec::with_capacity(items.len());
    for item in &items {
        let src = safe_join(&root, &item.src)?;
        if !src.exists() {
            files.push(None);
            continue;
        }
        let dest = cache.join(sanitize_filename(&item.name));

        // Reuse an identical staging file from earlier in this session.
        let reusable = match (std::fs::metadata(&dest), std::fs::metadata(&src)) {
            (Ok(d), Ok(s)) => d.len() == s.len(),
            _ => false,
        };
        if !reusable {
            let _ = std::fs::remove_file(&dest);
            if std::fs::hard_link(&src, &dest).is_err() {
                std::fs::copy(&src, &dest).map_err(|e| e.to_string())?;
            }
        }

        // The OS needs a real, absolute filesystem path — an asset:// URL is no use.
        let canonical = dunce_canonicalize(&dest);
        files.push(Some(canonical.to_string_lossy().into_owned()));
    }

    let icon_path = icon
        .and_then(|rel| safe_join(&root, &rel).ok())
        .filter(|p| p.exists())
        .unwrap_or(ensure_drag_icon(&cache)?);

    Ok(DragPayload {
        files,
        icon: dunce_canonicalize(&icon_path).to_string_lossy().into_owned(),
    })
}

/// `canonicalize` on Windows yields a `\\?\` extended path that some apps choke
/// on, so strip that prefix when it is safe to do so.
fn dunce_canonicalize(path: &Path) -> PathBuf {
    match std::fs::canonicalize(path) {
        Ok(p) => {
            let s = p.to_string_lossy();
            match s.strip_prefix(r"\\?\") {
                Some(stripped) if !stripped.starts_with("UNC\\") => PathBuf::from(stripped),
                _ => p,
            }
        }
        Err(_) => path.to_path_buf(),
    }
}

/// Swept at startup rather than after a drop: there is no reliable way to know
/// when the receiving application has finished reading the file.
#[tauri::command]
fn sweep_dragcache(app: AppHandle) -> Result<u32, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    let cache = root.join(DRAGCACHE);
    if !cache.exists() {
        return Ok(0);
    }
    let mut removed = 0;
    if let Ok(entries) = std::fs::read_dir(&cache) {
        for entry in entries.flatten() {
            if entry.file_type().map(|t| t.is_file()).unwrap_or(false)
                && std::fs::remove_file(entry.path()).is_ok()
            {
                removed += 1;
            }
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_join_accepts_ordinary_relative_paths() {
        let root = Path::new("/lib");
        assert_eq!(
            safe_join(root, "audio/sfx/ab12-whip.wav").unwrap(),
            PathBuf::from("/lib/audio/sfx/ab12-whip.wav")
        );
    }

    #[test]
    fn safe_join_rejects_traversal_and_absolute_paths() {
        let root = Path::new("/lib");
        assert!(safe_join(root, "../../etc/passwd").is_err());
        assert!(safe_join(root, "audio/../../secret").is_err());
        assert!(safe_join(root, "/etc/passwd").is_err());
    }

    #[test]
    fn sanitize_filename_strips_characters_windows_rejects() {
        assert_eq!(sanitize_filename("Whip attack.wav"), "Whip attack.wav");
        assert_eq!(sanitize_filename("a/b\\c:d*e?f\"g<h>i|j"), "a-b-c-d-e-f-g-h-i-j");
    }

    #[test]
    fn sanitize_filename_keeps_the_punctuation_osrs_actually_uses() {
        // Apostrophes, bangs, commas and ellipses are all legal in a filename
        // and are exactly what these files are full of.
        assert_eq!(
            sanitize_filename("A New Champion! (Champion's Challenge).ogg"),
            "A New Champion! (Champion's Challenge).ogg"
        );
        assert_eq!(
            sanitize_filename("Bell (Prifddinas, Ithell).wav"),
            "Bell (Prifddinas, Ithell).wav"
        );
    }

    #[test]
    fn sanitize_filename_never_returns_something_unusable() {
        assert_eq!(sanitize_filename(""), "clip");
        assert_eq!(sanitize_filename("   "), "clip");
        assert_eq!(sanitize_filename("..."), "clip");
        // A name that is only separators must not collapse into a traversal.
        assert_eq!(sanitize_filename("/"), "-");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_drag::init())
        .manage(CancelFlag::default())
        .invoke_handler(tauri::generate_handler![
            download_clips,
            cancel_download,
            library_root,
            library_size,
            stage_drag_files,
            sweep_dragcache
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
