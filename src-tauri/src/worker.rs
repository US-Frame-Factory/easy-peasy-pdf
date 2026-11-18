//! The `--render-worker` process: owns one PDFium instance and serves requests
//! from stdin one at a time. If PDFium crashes or hangs on a bad page, only
//! this process dies; the app's pool kills/respawns it.

use crate::sheets::{self, Run};
use crate::protocol::{bmp_from_bgra, tile_geometry, write_frame, Header, Request};
use pdfium_render::prelude::*;
use serde_json::json;
use std::io::{self, BufRead, BufWriter};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;

const MAX_DOCS: usize = 6;
const MAX_PAGES: usize = 6;

type Body = Vec<u8>;
type OpResult = Result<(serde_json::Value, Body), String>;

struct Cache {
    pdfium: &'static Pdfium,
    docs: Vec<(String, PdfDocument<'static>)>,
    pages: Vec<((String, u32), PdfPage<'static>)>,
}

impl Cache {
    fn doc(&mut self, path: &str) -> Result<&PdfDocument<'static>, String> {
        if let Some(i) = self.docs.iter().position(|(p, _)| p == path) {
            let d = self.docs.remove(i);
            self.docs.push(d);
        } else {
            let doc = self
                .pdfium
                .load_pdf_from_file(path, None)
                .map_err(|e| format!("cannot open PDF: {e}"))?;
            if self.docs.len() >= MAX_DOCS {
                let (old, _) = &self.docs[0];
                let old = old.clone();
                // Pages borrow their document's handle: drop them first.
                self.pages.retain(|((p, _), _)| *p != old);
                self.docs.remove(0);
            }
            self.docs.push((path.to_string(), doc));
        }
        Ok(&self.docs.last().unwrap().1)
    }

    fn page(&mut self, path: &str, index: u32) -> Result<&PdfPage<'static>, String> {
        let key = (path.to_string(), index);
        if let Some(i) = self.pages.iter().position(|(k, _)| *k == key) {
            let p = self.pages.remove(i);
            self.pages.push(p);
        } else {
            let doc = self.doc(path)?;
            let n = doc.pages().len() as u32;
            if index >= n {
                return Err(format!("page {} out of range (document has {n})", index + 1));
            }
            let page = doc
                .pages()
                .get(index as PdfPageIndex)
                .map_err(|e| format!("cannot load page {}: {e}", index + 1))?;
            if self.pages.len() >= MAX_PAGES {
                self.pages.remove(0);
            }
            self.pages.push((key, page));
        }
        Ok(&self.pages.last().unwrap().1)
    }
}

pub fn pdfium_lib_name() -> &'static str {
    if cfg!(windows) {
        "pdfium.dll"
    } else if cfg!(target_os = "macos") {
        "libpdfium.dylib"
    } else {
        "libpdfium.so"
    }
}

pub fn bind_pdfium(path: &PathBuf) -> Result<&'static Pdfium, String> {
    let bindings = Pdfium::bind_to_library(path)
        .map_err(|e| format!("cannot load PDFium from {}: {e}", path.display()))?;
    Ok(Box::leak(Box::new(Pdfium::new(bindings))))
}

pub fn run(args: &[String]) -> i32 {
    let lib = args
        .iter()
        .position(|a| a == "--pdfium")
        .and_then(|i| args.get(i + 1))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(pdfium_lib_name()));

    let stdout = io::stdout();
    let mut out = BufWriter::with_capacity(1 << 20, stdout.lock());

    let pdfium = match bind_pdfium(&lib) {
        Ok(p) => Some(p),
        Err(e) => {
            eprintln!("[worker] {e}");
            // Keep serving so each request fails cleanly with the reason.
            None
        }
    };
    let mut cache = pdfium.map(|p| Cache { pdfium: p, docs: Vec::new(), pages: Vec::new() });

    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let result: OpResult = match serde_json::from_str::<Request>(&line) {
            Err(e) => Err(format!("bad request: {e}")),
            Ok(Request::Crash) => std::process::abort(),
            Ok(req) => match cache.as_mut() {
                None => Err(format!("PDFium library not available ({})", lib.display())),
                Some(c) => catch_unwind(AssertUnwindSafe(|| handle(c, req)))
                    .unwrap_or_else(|_| Err("internal error (panic) in render worker".into())),
            },
        };
        let (header, body) = match result {
            Ok((data, body)) => (Header { ok: true, error: None, data }, body),
            Err(e) => (Header { ok: false, error: Some(e), data: json!(null) }, Vec::new()),
        };
        if write_frame(&mut out, &header, &body).is_err() {
            break; // parent went away
        }
    }
    0
}

/// Maps a rect in PDF user space to top-left-origin display points, applying /Rotate.
fn to_display(page: &PdfPage, r: &PdfRect) -> [f32; 4] {
    let bbox = page
        .boundaries()
        .crop()
        .or_else(|_| page.boundaries().media())
        .map(|b| b.bounds)
        .unwrap_or(PdfRect::new_from_values(0.0, 0.0, page.height().value, page.width().value));
    let (bx0, by1) = (bbox.left().value, bbox.top().value);
    let (bw, bh) = (bbox.width().value, bbox.height().value);
    // Unrotated, top-left origin.
    let (u0, u1) = (r.left().value - bx0, r.right().value - bx0);
    let (v0, v1) = (by1 - r.top().value, by1 - r.bottom().value);
    let (x0, y0, x1, y1) = match page.rotation().unwrap_or(PdfPageRenderRotation::None) {
        PdfPageRenderRotation::None => (u0, v0, u1, v1),
        PdfPageRenderRotation::Degrees90 => (bh - v1, u0, bh - v0, u1),
        PdfPageRenderRotation::Degrees180 => (bw - u1, bh - v1, bw - u0, bh - v0),
        PdfPageRenderRotation::Degrees270 => (v0, bw - u1, v1, bw - u0),
    };
    [x0, y0, x1 - x0, y1 - y0]
}

fn handle(cache: &mut Cache, req: Request) -> OpResult {
    match req {
        Request::Crash => unreachable!(),
        Request::Info { path } => {
            let doc = cache.doc(&path)?;
            let pages = doc.pages();
            let mut sizes = Vec::with_capacity(pages.len() as usize);
            for i in 0..pages.len() {
                let r = pages.page_size(i).map_err(|e| format!("page size {}: {e}", i + 1))?;
                sizes.push([r.width().value, r.height().value]);
            }
            // Bookmarks that point at pages often name the sheets.
            let mut marks: Vec<(u32, String)> = Vec::new();
            // (Capped: a malformed outline can loop forever.)
            for b in doc.bookmarks().iter().take(20000) {
                let (Some(t), Some(d)) = (b.title(), b.destination()) else { continue };
                if let Ok(i) = d.page_index() {
                    if !marks.iter().any(|(p, _)| *p == i as u32) && !t.trim().is_empty() {
                        marks.push((i as u32, t.trim().to_string()));
                    }
                }
            }
            Ok((json!({ "pages": sizes, "bookmarks": marks }), Vec::new()))
        }
        Request::Tile { path, page, scale, tx, ty } => {
            if !(scale.is_finite() && scale > 0.0 && scale <= 64.0) {
                return Err("bad scale".into());
            }
            let p = cache.page(&path, page)?;
            let (w, h, tw, th) =
                tile_geometry(p.width().value as f64, p.height().value as f64, scale, tx, ty)
                    .ok_or("tile out of range")?;
            let mut bitmap = PdfBitmap::empty(tw, th, PdfBitmapFormat::BGRA)
                .map_err(|e| format!("bitmap: {e}"))?;
            let cfg = PdfRenderConfig::new()
                .set_fixed_size(w, h)
                .set_origin(-((tx * crate::protocol::TILE) as i32), -((ty * crate::protocol::TILE) as i32))
                .render_annotations(true)
                .render_form_data(true)
                .set_reverse_byte_order(false);
            p.render_into_bitmap_with_config(&mut bitmap, &cfg)
                .map_err(|e| format!("render: {e}"))?;
            let raw = bitmap.as_raw_bytes();
            let stride = raw.len() / th.max(1) as usize;
            let bmp = bmp_from_bgra(tw as u32, th as u32, stride, &raw);
            Ok((json!({ "w": tw, "h": th }), bmp))
        }
        Request::Text { path, page } => {
            let p = cache.page(&path, page)?;
            let text = p.text().map_err(|e| format!("text: {e}"))?;
            let all = text.all();
            // Sheet number/title from the title block, plus the PDF page label if it's
            // more than just the page number.
            let runs: Vec<Run> = text
                .segments()
                .iter()
                .map(|seg| {
                    let [x, y, w, h] = to_display(p, &seg.bounds());
                    Run { text: seg.text(), x, y, w, h }
                })
                .collect();
            let (sheet, title) = sheets::detect(&runs, p.width().value, p.height().value);
            let label = p.label().map(str::trim).filter(|l| !l.is_empty() && *l != (page + 1).to_string());
            Ok((json!({ "sheet": sheet, "title": title, "label": label }), all.into_bytes()))
        }
        Request::Find { path, page, query } => {
            let p = cache.page(&path, page)?;
            let text = p.text().map_err(|e| format!("text: {e}"))?;
            let mut rects = Vec::new();
            if !query.is_empty() {
                let search = text
                    .search(&query, &PdfSearchOptions::new())
                    .map_err(|e| format!("search: {e}"))?;
                while let Some(segments) = search.find_next() {
                    // One match can span several segments (line breaks): keep each.
                    let mut group = Vec::new();
                    for seg in segments.iter() {
                        group.push(to_display(p, &seg.bounds()));
                    }
                    rects.push(group);
                    if rects.len() >= 2000 {
                        break;
                    }
                }
            }
            Ok((json!({ "matches": rects }), Vec::new()))
        }
        Request::Extract { path, pages, dest } => {
            if pages.is_empty() {
                return Err("no pages selected".into());
            }
            let pdfium = cache.pdfium;
            let src = cache.doc(&path)?;
            let n = src.pages().len() as u32;
            if let Some(bad) = pages.iter().find(|&&p| p >= n) {
                return Err(format!("page {} out of range (document has {n})", bad + 1));
            }
            let range = pages.iter().map(|p| (p + 1).to_string()).collect::<Vec<_>>().join(",");
            let mut out = pdfium.create_new_pdf().map_err(|e| format!("new pdf: {e}"))?;
            out.pages_mut()
                .copy_pages_from_document(src, &range, 0)
                .map_err(|e| format!("copy pages: {e}"))?;
            // Write to a temp file then rename, so a failure never leaves a half-written PDF.
            let tmp = format!("{dest}.part");
            out.save_to_file(&tmp).map_err(|e| format!("save: {e}"))?;
            drop(out);
            std::fs::rename(&tmp, &dest)
                .or_else(|_| {
                    let _ = std::fs::remove_file(&dest);
                    std::fs::rename(&tmp, &dest)
                })
                .map_err(|e| format!("save: {e}"))?;
            Ok((json!({ "pages": pages.len() }), Vec::new()))
        }
    }
}
