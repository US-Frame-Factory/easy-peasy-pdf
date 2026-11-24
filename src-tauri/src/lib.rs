pub mod annotate;
pub mod bench;
pub mod pdfwrite;
pub mod pool;
pub mod protocol;
pub mod sheets;
pub mod textedit;
pub mod worker;

use pool::{JobError, Pool, Prio};
use protocol::Request;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use tauri::http::{header, Response, StatusCode};
use tauri::{Emitter, Manager};

/// Searchable text of one page: original + a 1:1 char-mapped lowercase copy.
struct PageText {
    orig: String,
    lower: String,
}

struct Doc {
    path: String,
    closed: Arc<AtomicBool>,
    pages: usize,
    text: RwLock<Vec<Option<PageText>>>,
    indexed: AtomicU64,
    /// Sheet name per page: bookmark title, else PDF page label, else the
    /// sheet number read from the title block.
    labels: RwLock<Vec<Option<String>>>,
    /// Title-block sheet number and title per page (for "Rename sheets").
    sheets: RwLock<Vec<(Option<String>, Option<String>)>>,
}

pub struct AppState {
    pool: Arc<Pool>,
    docs: RwLock<HashMap<u64, Arc<Doc>>>,
    next_id: AtomicU64,
    initial_files: Mutex<Vec<String>>,
    pdfium: PathBuf,
}

impl AppState {
    fn doc(&self, id: u64) -> Result<Arc<Doc>, String> {
        self.docs.read().unwrap().get(&id).cloned().ok_or_else(|| "document is not open".to_string())
    }
}

/// Where's pdfium? resource_dir/pdfium, next to the exe, then the dev path.
pub fn find_pdfium(resource_dir: Option<PathBuf>) -> PathBuf {
    let name = worker::pdfium_lib_name();
    let mut candidates = Vec::new();
    if let Some(r) = resource_dir {
        candidates.push(r.join("pdfium").join(name));
        candidates.push(r.join(name));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(name));
            candidates.push(dir.join("pdfium").join(name));
        }
    }
    candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("pdfium").join(name));
    candidates.iter().find(|p| p.is_file()).cloned().unwrap_or_else(|| candidates.last().unwrap().clone())
}

fn pdf_args(args: &[String]) -> Vec<String> {
    args.iter()
        .skip(1)
        .filter(|a| !a.starts_with("--") && a.to_lowercase().ends_with(".pdf"))
        .map(|a| std::fs::canonicalize(a).map(|p| clean_path(&p)).unwrap_or_else(|_| a.clone()))
        .collect()
}

/// Canonical path without Windows' `\\?\` prefix.
fn clean_path(p: &Path) -> String {
    let s = p.to_string_lossy().to_string();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}"); // network share: \\server\share\...
    }
    s.strip_prefix(r"\\?\").map(|s| s.to_string()).unwrap_or(s)
}

#[cfg(test)]
mod tests {
    #[test]
    fn clean_paths() {
        use std::path::Path;
        assert_eq!(super::clean_path(Path::new(r"\\?\C:\plans\a.pdf")), r"C:\plans\a.pdf");
        assert_eq!(super::clean_path(Path::new(r"\\?\UNC\srv\share\a.pdf")), r"\\srv\share\a.pdf");
        assert_eq!(super::clean_path(Path::new("/home/a.pdf")), "/home/a.pdf");
        assert_eq!(super::percent_decode("1%2F2%2F354%2F0%2F0"), "1/2/354/0/0");
    }
}

#[derive(Serialize)]
struct DocInfo {
    id: u64,
    path: String,
    name: String,
    pages: serde_json::Value,
}

#[derive(Serialize, Clone)]
struct IndexProgress {
    doc: u64,
    done: u64,
    total: usize,
}

#[tauri::command]
async fn open_doc(app: tauri::AppHandle, state: tauri::State<'_, AppState>, path: String) -> Result<DocInfo, String> {
    let path = std::fs::canonicalize(&path).map(|p| clean_path(&p)).map_err(|e| format!("{path}: {e}"))?;
    let reply = state.pool.run(Request::Info { path: path.clone() }, Prio::Interactive).await.map_err(|e| e.to_string())?;
    let pages = reply.data["pages"].clone();
    let n = pages.as_array().map(|a| a.len()).unwrap_or(0);
    let mut labels: Vec<Option<String>> = vec![None; n];
    for m in reply.data["bookmarks"].as_array().into_iter().flatten() {
        if let (Some(p), Some(t)) = (m[0].as_u64(), m[1].as_str()) {
            if let Some(slot) = labels.get_mut(p as usize) {
                slot.get_or_insert_with(|| t.chars().take(80).collect());
            }
        }
    }
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let doc = Arc::new(Doc {
        path: path.clone(),
        closed: Arc::new(AtomicBool::new(false)),
        pages: n,
        text: RwLock::new((0..n).map(|_| None).collect()),
        indexed: AtomicU64::new(0),
        labels: RwLock::new(labels),
        sheets: RwLock::new(vec![(None, None); n]),
    });
    state.docs.write().unwrap().insert(id, doc.clone());

    // Background text indexing, streamed back page by page.
    for page in 0..n {
        let rx = state.pool.submit(
            Request::Text { path: path.clone(), page: page as u32 },
            Prio::Background,
            Some(doc.closed.clone()),
        );
        let doc = doc.clone();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let text = match rx.await {
                Ok(Ok(r)) => {
                    doc.sheets.write().unwrap()[page] =
                        (r.data["sheet"].as_str().map(String::from), r.data["title"].as_str().map(String::from));
                    let pdf_label = r.data["label"].as_str().filter(|l| l.parse::<u64>().is_err());
                    if let Some(l) = pdf_label.or(r.data["sheet"].as_str()) {
                        doc.labels.write().unwrap()[page].get_or_insert_with(|| l.to_string());
                    }
                    String::from_utf8_lossy(&r.body).replace(['\r', '\n', '\u{2}'], " ")
                }
                Ok(Err(JobError::Cancelled)) | Err(_) => return,
                Ok(Err(_)) => String::new(),
            };
            let lower: String = text
                .chars()
                .map(|c| {
                    let mut l = c.to_lowercase();
                    match (l.next(), l.next()) {
                        (Some(x), None) => x,
                        _ => c,
                    }
                })
                .collect();
            doc.text.write().unwrap()[page] = Some(PageText { orig: text, lower });
            let done = doc.indexed.fetch_add(1, Ordering::Relaxed) + 1;
            if done == doc.pages as u64 || done % 4 == 0 {
                let _ = app.emit("index-progress", IndexProgress { doc: id, done, total: doc.pages });
            }
        });
    }

    let name = Path::new(&path).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| path.clone());
    Ok(DocInfo { id, path, name, pages })
}

#[derive(Serialize)]
struct SheetInfo {
    numbers: Vec<Option<String>>,
    titles: Vec<Option<String>>,
    /// Current page labels from the PDF (or bookmarks / detected numbers).
    labels: Vec<Option<String>>,
    indexed: u64,
    total: usize,
}

#[tauri::command]
fn sheet_info(state: tauri::State<'_, AppState>, doc: u64) -> Result<SheetInfo, String> {
    let d = state.doc(doc)?;
    let (numbers, titles) = {
        let sh = d.sheets.read().unwrap();
        (sh.iter().map(|s| s.0.clone()).collect(), sh.iter().map(|s| s.1.clone()).collect())
    };
    let labels = d.labels.read().unwrap().clone();
    Ok(SheetInfo { numbers, titles, labels, indexed: d.indexed.load(Ordering::Relaxed), total: d.pages })
}

#[tauri::command]
fn labels(state: tauri::State<'_, AppState>, doc: u64) -> Result<Vec<Option<String>>, String> {
    Ok(state.doc(doc)?.labels.read().unwrap().clone())
}

#[tauri::command]
fn close_doc(state: tauri::State<'_, AppState>, id: u64) {
    if let Some(d) = state.docs.write().unwrap().remove(&id) {
        d.closed.store(true, Ordering::Relaxed);
    }
}

#[derive(Serialize)]
struct Hit {
    doc: u64,
    page: usize,
    before: String,
    hit: String,
    after: String,
}

#[derive(Serialize)]
struct SearchResult {
    hits: Vec<Hit>,
    truncated: bool,
    indexed: u64,
    total: usize,
}

fn char_slice(s: &str, from: usize, to: usize) -> String {
    s.chars().skip(from).take(to.saturating_sub(from)).collect()
}

#[tauri::command]
fn search(state: tauri::State<'_, AppState>, query: String, docs: Vec<u64>) -> SearchResult {
    const LIMIT: usize = 5000;
    const CTX: usize = 40;
    let q: String = query.trim().chars().flat_map(|c| c.to_lowercase()).collect();
    let mut out = SearchResult { hits: Vec::new(), truncated: false, indexed: 0, total: 0 };
    for id in docs {
        let Ok(doc) = state.doc(id) else { continue };
        out.indexed += doc.indexed.load(Ordering::Relaxed);
        out.total += doc.pages;
        if q.is_empty() {
            continue;
        }
        let texts = doc.text.read().unwrap();
        for (page, t) in texts.iter().enumerate() {
            let Some(t) = t else { continue };
            let mut from = 0;
            while let Some(off) = t.lower[from..].find(&q) {
                if out.hits.len() >= LIMIT {
                    out.truncated = true;
                    break;
                }
                let b = from + off;
                let start = t.lower[..b].chars().count();
                let qlen = t.lower[b..b + q.len()].chars().count();
                let end = start + qlen;
                let mut before = char_slice(&t.orig, start.saturating_sub(CTX), start);
                if start > CTX {
                    before.insert(0, '…');
                }
                let mut after = char_slice(&t.orig, end, end + CTX);
                if t.orig.chars().count() > end + CTX {
                    after.push('…');
                }
                out.hits.push(Hit { doc: id, page, before, hit: char_slice(&t.orig, start, end), after });
                from = b + q.len().max(1);
            }
        }
    }
    out
}

#[tauri::command]
async fn find(state: tauri::State<'_, AppState>, doc: u64, page: u32, query: String) -> Result<serde_json::Value, String> {
    let d = state.doc(doc)?;
    let r = state
        .pool
        .run(Request::Find { path: d.path.clone(), page, query }, Prio::Interactive)
        .await
        .map_err(|e| e.to_string())?;
    Ok(r.data["matches"].clone())
}

#[tauri::command]
async fn extract(state: tauri::State<'_, AppState>, doc: u64, pages: Vec<u32>, dest: String) -> Result<usize, String> {
    let d = state.doc(doc)?;
    let same = std::fs::canonicalize(&dest).map(|p| clean_path(&p) == d.path).unwrap_or(false);
    if same {
        return Err("Choose a different file name than the open document.".into());
    }
    let n = pages.len();
    state
        .pool
        .run(Request::Extract { path: d.path.clone(), pages, dest }, Prio::Interactive)
        .await
        .map_err(|e| e.to_string())?;
    Ok(n)
}

#[tauri::command]
fn initial_files(state: tauri::State<'_, AppState>) -> Vec<String> {
    std::mem::take(&mut *state.initial_files.lock().unwrap())
}

#[tauri::command]
fn crash_a_worker(state: tauri::State<'_, AppState>) {
    // Debug aid: proves a dying worker doesn't take the app down.
    let _ = state.pool.submit(Request::Crash, Prio::Interactive, None);
}

/// The app used to be called "Easy Peasy PDF". Its per-user install (and shortcuts)
/// is a separate program as far as Windows is concerned, so once Quick Fast PDF is
/// running, uninstall the old one quietly. Settings carry over (same app identifier).
#[cfg(windows)]
fn remove_old_install() {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::thread::sleep(std::time::Duration::from_secs(15));
    let Ok(out) = Command::new("reg")
        .args(["query", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Easy Peasy PDF", "/v", "UninstallString"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    else {
        return;
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let Some(cmd) = text.lines().find_map(|l| l.split_once("REG_SZ").map(|(_, v)| v.trim().trim_matches('"').to_string())) else {
        return; // not installed
    };
    let uninstaller = std::path::PathBuf::from(&cmd);
    if !uninstaller.is_file() {
        return;
    }
    // Never uninstall ourselves (in case this copy runs from the old folder).
    if let (Ok(me), Some(dir)) = (std::env::current_exe(), uninstaller.parent()) {
        if me.starts_with(dir) {
            return;
        }
    }
    eprintln!("[migrate] removing the old Easy Peasy PDF install: {cmd}");
    let _ = Command::new(&uninstaller).arg("/S").creation_flags(CREATE_NO_WINDOW).spawn();
}

#[tauri::command]
async fn text_at(state: tauri::State<'_, AppState>, doc: u64, page: u32, x: f32, y: f32) -> Result<serde_json::Value, String> {
    let d = state.doc(doc)?;
    let r = state
        .pool
        .run(Request::TextAt { path: d.path.clone(), page, x, y }, Prio::Interactive)
        .await
        .map_err(|e| e.to_string())?;
    Ok(r.data)
}

#[tauri::command]
async fn select_text(state: tauri::State<'_, AppState>, doc: u64, page: u32, rect: [f32; 4]) -> Result<serde_json::Value, String> {
    let d = state.doc(doc)?;
    let r = state
        .pool
        .run(Request::SelectText { path: d.path.clone(), page, rect }, Prio::Interactive)
        .await
        .map_err(|e| e.to_string())?;
    Ok(r.data)
}

/// Renders part of a page. Response body: u32 LE width, u32 LE height, then RGBA pixels.
#[tauri::command]
async fn render_region(state: tauri::State<'_, AppState>, doc: u64, page: u32, scale: f64, rect: [f32; 4]) -> Result<tauri::ipc::Response, String> {
    let d = state.doc(doc)?;
    let r = state
        .pool
        .run(Request::Region { path: d.path.clone(), page, scale, rect }, Prio::Interactive)
        .await
        .map_err(|e| e.to_string())?;
    let (w, h) = (r.data["w"].as_u64().unwrap_or(0) as u32, r.data["h"].as_u64().unwrap_or(0) as u32);
    let mut out = Vec::with_capacity(8 + r.body.len());
    out.extend_from_slice(&w.to_le_bytes());
    out.extend_from_slice(&h.to_le_bytes());
    for px in r.body.chunks_exact(4) {
        out.extend_from_slice(&[px[2], px[1], px[0], 255]); // BGRA -> RGBA, opaque
    }
    Ok(tauri::ipc::Response::new(out))
}

#[tauri::command]
fn copy_text(app: tauri::AppHandle, text: String) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}

/// Raw body: RGBA pixels; headers x-width / x-height.
#[tauri::command]
fn copy_image(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let num = |k: &str| -> Result<u32, String> {
        request.headers().get(k).and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok()).ok_or(format!("missing {k}"))
    };
    let (w, h) = (num("x-width")?, num("x-height")?);
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("expected raw image bytes".into()) };
    if bytes.len() != (w as usize) * (h as usize) * 4 {
        return Err("image size mismatch".into());
    }
    let img = tauri::image::Image::new_owned(bytes.clone(), w, h);
    app.clipboard().write_image(&img).map_err(|e| e.to_string())
}

fn author_name() -> String {
    std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_default()
}

/// Writes markups into the PDF as annotations, in a separate process.
/// `dest` = None saves into the open file itself (written to a temp file, then swapped in).
#[tauri::command]
async fn save_markups(
    state: tauri::State<'_, AppState>,
    doc: u64,
    markups: serde_json::Value,
    dest: Option<String>,
    labels: Option<Vec<String>>,
    rotate: Option<Vec<[i64; 2]>>,
    edits: Option<serde_json::Value>,
) -> Result<String, String> {
    let d = state.doc(doc)?;
    let src = d.path.clone();
    let target = match dest {
        Some(p) if !p.trim().is_empty() => p,
        _ => src.clone(),
    };
    let tmp = format!("{target}.saving-{}.tmp", std::process::id());
    let job = serde_json::json!({
        "src": src, "dest": tmp, "author": author_name(), "markups": markups,
        "labels": labels, "rotate": rotate, "edits": edits.unwrap_or(serde_json::json!([])),
    });
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let pdfium = state.pdfium.clone();
    let out = tauri::async_runtime::spawn_blocking(move || -> Result<serde_json::Value, String> {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let mut cmd = Command::new(exe);
        cmd.arg("--save-markups").arg("--pdfium").arg(&pdfium).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = cmd.spawn().map_err(|e| format!("cannot start saver: {e}"))?;
        child.stdin.take().unwrap().write_all(job.to_string().as_bytes()).map_err(|e| e.to_string())?;
        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&out.stdout);
        serde_json::from_str(text.trim()).map_err(|_| format!("saver crashed ({})", out.status))
    })
    .await
    .map_err(|e| e.to_string())??;
    if out["ok"].as_bool() != Some(true) {
        let _ = std::fs::remove_file(&tmp);
        return Err(out["error"].as_str().unwrap_or("save failed").to_string());
    }
    if let Err(e) = std::fs::rename(&tmp, &target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(if target == src {
            format!("Couldn't replace the file (is it open in another program?): {e}. Use Save As instead.")
        } else {
            format!("Couldn't write {target}: {e}")
        });
    }
    Ok(target)
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn tile_response(status: StatusCode, ctype: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    let mut b = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, ctype)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    if status == StatusCode::OK {
        b = b.header(header::CACHE_CONTROL, "max-age=31536000, immutable");
    }
    b.body(body).unwrap()
}

/// URL path: {doc}/{page}/{scale_milli}/{tx}/{ty}
async fn serve_tile(app: tauri::AppHandle, path: String) -> Response<Vec<u8>> {
    let p = percent_decode(path.trim_start_matches('/'));
    let parts: Vec<&str> = p.split(['/', '?']).filter(|s| !s.is_empty()).collect();
    let nums: Vec<u64> = parts.iter().take(5).filter_map(|s| s.parse().ok()).collect();
    if nums.len() != 5 {
        return tile_response(StatusCode::BAD_REQUEST, "text/plain", b"bad tile url".to_vec());
    }
    let state = app.state::<AppState>();
    let Ok(doc) = state.doc(nums[0]) else {
        return tile_response(StatusCode::NOT_FOUND, "text/plain", b"document closed".to_vec());
    };
    let req = Request::Tile {
        path: doc.path.clone(),
        page: nums[1] as u32,
        scale: nums[2] as f64 / 1000.0,
        tx: nums[3] as u32,
        ty: nums[4] as u32,
    };
    let rx = state.pool.submit(req, Prio::Tile, Some(doc.closed.clone()));
    match rx.await {
        Ok(Ok(r)) => tile_response(StatusCode::OK, "image/bmp", r.body),
        Ok(Err(JobError::Stale)) | Ok(Err(JobError::Cancelled)) => {
            tile_response(StatusCode::SERVICE_UNAVAILABLE, "text/plain", b"stale".to_vec())
        }
        Ok(Err(JobError::Failed(e))) => tile_response(StatusCode::INTERNAL_SERVER_ERROR, "text/plain", e.into_bytes()),
        Err(_) => tile_response(StatusCode::INTERNAL_SERVER_ERROR, "text/plain", b"dropped".to_vec()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    let files = pdf_args(&args);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // "Open with" while already running: open the files as tabs here.
            let files = pdf_args(&argv);
            if !files.is_empty() {
                let _ = app.emit("open-files", files);
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .register_asynchronous_uri_scheme_protocol("tile", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let path = request.uri().path().to_string();
            tauri::async_runtime::spawn(async move {
                responder.respond(serve_tile(app, path).await);
            });
        })
        .setup(move |app| {
            let pdfium = find_pdfium(app.path().resource_dir().ok());
            let exe = std::env::current_exe()?;
            let workers = std::env::var("EPP_WORKERS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or_else(pool::default_worker_count);
            let pool = Pool::start(exe, pdfium.clone(), workers);
            #[cfg(windows)]
            std::thread::spawn(remove_old_install);
            app.manage(AppState {
                pool,
                docs: RwLock::new(HashMap::new()),
                next_id: AtomicU64::new(1),
                initial_files: Mutex::new(files.clone()),
                pdfium,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_doc,
            close_doc,
            labels,
            sheet_info,
            search,
            find,
            extract,
            initial_files,
            crash_a_worker,
            text_at,
            select_text,
            render_region,
            copy_text,
            copy_image,
            save_markups
        ])
        .run(tauri::generate_context!())
        .expect("error while running Quick Fast PDF");
}
