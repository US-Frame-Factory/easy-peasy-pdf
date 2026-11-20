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

/// (length, modified time): a document is reloaded when its file changes on disk
/// (e.g. after markups were saved into it).
type Stamp = (u64, Option<std::time::SystemTime>);

fn stamp(path: &str) -> Stamp {
    std::fs::metadata(path).map(|m| (m.len(), m.modified().ok())).unwrap_or((0, None))
}

struct Cache {
    pdfium: &'static Pdfium,
    docs: Vec<(String, Stamp, PdfDocument<'static>)>,
    pages: Vec<((String, u32), PdfPage<'static>)>,
}

impl Cache {
    fn doc(&mut self, path: &str) -> Result<&PdfDocument<'static>, String> {
        let st = stamp(path);
        if let Some(i) = self.docs.iter().position(|(p, s, _)| p == path && *s != st) {
            // Changed on disk: drop its pages, then the document.
            self.pages.retain(|((p, _), _)| p != path);
            self.docs.remove(i);
        }
        if let Some(i) = self.docs.iter().position(|(p, _, _)| p == path) {
            let d = self.docs.remove(i);
            self.docs.push(d);
        } else {
            let doc = self
                .pdfium
                .load_pdf_from_file(path, None)
                .map_err(|e| format!("cannot open PDF: {e}"))?;
            if self.docs.len() >= MAX_DOCS {
                let (old, _, _) = &self.docs[0];
                let old = old.clone();
                // Pages borrow their document's handle: drop them first.
                self.pages.retain(|((p, _), _)| *p != old);
                self.docs.remove(0);
            }
            self.docs.push((path.to_string(), st, doc));
        }
        Ok(&self.docs.last().unwrap().2)
    }

    fn page(&mut self, path: &str, index: u32) -> Result<&PdfPage<'static>, String> {
        self.doc(path)?; // reloads (and drops stale pages) if the file changed
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

/// Maps rects in PDF user space to top-left-origin display points, applying /Rotate.
/// Built once per page (crop box and rotation are FFI lookups).
struct Xform {
    bx0: f32,
    by1: f32,
    bw: f32,
    bh: f32,
    rot: PdfPageRenderRotation,
}

impl Xform {
    fn new(page: &PdfPage) -> Self {
        let bbox = page
            .boundaries()
            .crop()
            .or_else(|_| page.boundaries().media())
            .map(|b| b.bounds)
            .unwrap_or(PdfRect::new_from_values(0.0, 0.0, page.height().value, page.width().value));
        Xform {
            bx0: bbox.left().value,
            by1: bbox.top().value,
            bw: bbox.width().value,
            bh: bbox.height().value,
            rot: page.rotation().unwrap_or(PdfPageRenderRotation::None),
        }
    }

    /// Display point (top-left origin, rotated) -> PDF user space.
    fn to_user(&self, x: f32, y: f32) -> (f32, f32) {
        let (bw, bh) = (self.bw, self.bh);
        let (u, v) = match self.rot {
            PdfPageRenderRotation::None => (x, y),
            PdfPageRenderRotation::Degrees90 => (y, bh - x),
            PdfPageRenderRotation::Degrees180 => (bw - x, bh - y),
            PdfPageRenderRotation::Degrees270 => (bw - y, x),
        };
        (self.bx0 + u, self.by1 - v)
    }

    fn apply(&self, r: &PdfRect) -> [f32; 4] {
        let (bw, bh) = (self.bw, self.bh);
        // Unrotated, top-left origin.
        let (u0, u1) = (r.left().value - self.bx0, r.right().value - self.bx0);
        let (v0, v1) = (self.by1 - r.top().value, self.by1 - r.bottom().value);
        let (x0, y0, x1, y1) = match self.rot {
            PdfPageRenderRotation::None => (u0, v0, u1, v1),
            PdfPageRenderRotation::Degrees90 => (bh - v1, u0, bh - v0, u1),
            PdfPageRenderRotation::Degrees180 => (bw - u1, bh - v1, bw - u0, bh - v0),
            PdfPageRenderRotation::Degrees270 => (v0, bw - u1, v1, bw - u0),
        };
        [x0, y0, x1 - x0, y1 - y0]
    }
}

fn handle(cache: &mut Cache, req: Request) -> OpResult {
    match req {
        Request::Crash => unreachable!(),
        Request::SelectText { path, page, rect } => {
            let p = cache.page(&path, page)?;
            let text = p.text().map_err(|e| format!("text: {e}"))?;
            let xf = Xform::new(p);
            let (ax, ay) = xf.to_user(rect[0], rect[1]);
            let (bx, by) = xf.to_user(rect[2], rect[3]);
            let r = PdfRect::new_from_values(ay.min(by), ax.min(bx), ay.max(by), ax.max(bx));
            let selected = text.inside_rect(r);
            // Highlight rects: characters inside, merged into runs per line.
            let mut runs: Vec<[f32; 4]> = Vec::new();
            let mut last: Option<(usize, f32, f32)> = None; // (index, top, height)
            let (rx0, ry0) = (rect[0].min(rect[2]), rect[1].min(rect[3]));
            let (rx1, ry1) = (rect[0].max(rect[2]), rect[1].max(rect[3]));
            {
                let chars = text.chars();
                for ch in chars.iter().take(200_000) {
                    let Ok(b) = ch.loose_bounds() else { continue };
                    let d = xf.apply(&b);
                    let (cx, cy) = (d[0] + d[2] / 2.0, d[1] + d[3] / 2.0);
                    if cx < rx0 || cx > rx1 || cy < ry0 || cy > ry1 {
                        continue;
                    }
                    if d[2] <= 0.0 || d[3] <= 0.0 {
                        continue;
                    }
                    let i = ch.index() as usize;
                    let joins = last.is_some_and(|(li, t, h)| i == li + 1 && (d[1] - t).abs() < h * 0.4);
                    if joins {
                        let r = runs.last_mut().unwrap();
                        let (x0, y0) = (r[0].min(d[0]), r[1].min(d[1]));
                        let (x1, y1) = ((r[0] + r[2]).max(d[0] + d[2]), (r[1] + r[3]).max(d[1] + d[3]));
                        *r = [x0, y0, x1 - x0, y1 - y0];
                    } else {
                        runs.push(d);
                    }
                    last = Some((i, d[1], d[3]));
                }
            }
            Ok((json!({ "text": selected, "rects": runs }), Vec::new()))
        }
        Request::Region { path, page, scale, rect } => {
            if !(scale.is_finite() && scale > 0.0 && scale <= 64.0) {
                return Err("bad scale".into());
            }
            let p = cache.page(&path, page)?;
            let (pw, ph) = (p.width().value as f64, p.height().value as f64);
            let (w, h) = ((pw * scale).round() as i64, (ph * scale).round() as i64);
            let x0 = (rect[0] as f64 * scale).round().max(0.0) as i64;
            let y0 = (rect[1] as f64 * scale).round().max(0.0) as i64;
            let rw = ((rect[2] as f64 * scale).round() as i64).min(w - x0);
            let rh = ((rect[3] as f64 * scale).round() as i64).min(h - y0);
            if rw <= 0 || rh <= 0 || rw * rh > 64_000_000 || w > i32::MAX as i64 || h > i32::MAX as i64 {
                return Err("snapshot area is empty or too large".into());
            }
            let mut bitmap = PdfBitmap::empty(rw as i32, rh as i32, PdfBitmapFormat::BGRA)
                .map_err(|e| format!("bitmap: {e}"))?;
            let cfg = PdfRenderConfig::new()
                .set_fixed_size(w as i32, h as i32)
                .set_origin(-(x0 as i32), -(y0 as i32))
                .render_annotations(true)
                .render_form_data(true)
                .set_reverse_byte_order(false);
            p.render_into_bitmap_with_config(&mut bitmap, &cfg).map_err(|e| format!("render: {e}"))?;
            let raw = bitmap.as_raw_bytes();
            let stride = raw.len() / rh as usize;
            let row = rw as usize * 4;
            let mut out = Vec::with_capacity(row * rh as usize);
            for y in 0..rh as usize {
                out.extend_from_slice(&raw[y * stride..y * stride + row]);
            }
            Ok((json!({ "w": rw, "h": rh }), out))
        }
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
            // Sheet number: the largest sheet-number-shaped text in the title-block corner.
            // Fetching a run's text is a PDFium call each, so pick candidates by position
            // and size first and only read the text of the tallest few.
            let xf = Xform::new(p);
            let (pw, ph) = (p.width().value, p.height().value);
            let mut boxes: Vec<(usize, [f32; 4])> = Vec::new();
            let segs = text.segments();
            for (i, seg) in segs.iter().enumerate() {
                let r = xf.apply(&seg.bounds());
                let (cx, cy) = (r[0] + r[2] / 2.0, r[1] + r[3] / 2.0);
                if cx >= pw * 0.5 && cy >= ph * 0.5 {
                    boxes.push((i, r));
                }
            }
            // Text size = the box's smaller side, so vertical notes don't look huge.
            boxes.sort_by(|a, b| b.1[2].min(b.1[3]).total_cmp(&a.1[2].min(a.1[3])));
            boxes.truncate(40);
            let runs: Vec<Run> = boxes
                .into_iter()
                .filter_map(|(i, [x, y, w, h])| {
                    let seg = segs.get(i as PdfPageTextSegmentIndex).ok()?;
                    Some(Run { text: seg.text(), x, y, w, h })
                })
                .collect();
            let sheet = sheets::sheet_number(&runs, pw, ph);
            // Sheet title: find a "DWG TITLE" / "SHEET TITLE" label with PDFium's search,
            // then read only the runs just below it.
            let mut title: Option<String> = None;
            if let Ok(search) = text.search("title", &PdfSearchOptions::new()) {
                let boxes: Vec<[f32; 4]> = segs.iter().map(|sg| xf.apply(&sg.bounds())).collect();
                let mut tries = 0;
                while let Some(m) = search.find_next() {
                    tries += 1;
                    if tries > 25 || title.is_some() {
                        break;
                    }
                    let Some(mb) = m.iter().next().map(|sg| xf.apply(&sg.bounds())) else { continue };
                    let (mx, my) = (mb[0] + mb[2] / 2.0, mb[1] + mb[3] / 2.0);
                    let Some(li) = boxes
                        .iter()
                        .position(|r| mx >= r[0] - 1.0 && mx <= r[0] + r[2] + 1.0 && my >= r[1] - 1.0 && my <= r[1] + r[3] + 1.0)
                    else {
                        continue;
                    };
                    let lr = boxes[li];
                    let Ok(lseg) = segs.get(li as PdfPageTextSegmentIndex) else { continue };
                    let label = Run { text: lseg.text(), x: lr[0], y: lr[1], w: lr[2], h: lr[3] };
                    if sheets::title_label_rest(&label.text).is_none() {
                        continue;
                    }
                    let lh = lr[2].min(lr[3]);
                    let mut below: Vec<(usize, [f32; 4])> = boxes
                        .iter()
                        .enumerate()
                        .filter(|(i, r)| {
                            let right_edge = lr[0] + lr[2];
                            // Same row, right of the label (first line of a two-line title)…
                            let same_row = (r[1] + r[3] / 2.0 - (lr[1] + lr[3] / 2.0)).abs() < lh * 1.2
                                && r[0] >= right_edge - 2.0
                                && r[0] <= right_edge + lh * 10.0;
                            // …or below it, in the same column.
                            let below = r[1] >= lr[1] + lr[3] * 0.5
                                && r[1] <= lr[1] + lr[3] + lh * 16.0
                                && r[0] >= lr[0] - lh * 3.0
                                && r[0] <= right_edge + lh * 10.0;
                            *i != li && (same_row || below)
                        })
                        .map(|(i, r)| (i, *r))
                        .collect();
                    below.sort_by(|a, b| a.1[1].total_cmp(&b.1[1]));
                    below.truncate(30);
                    let runs: Vec<Run> = below
                        .into_iter()
                        .filter_map(|(i, [x, y, w, h])| Some(Run { text: segs.get(i as PdfPageTextSegmentIndex).ok()?.text(), x, y, w, h }))
                        .collect();
                    title = sheets::title_from(&label, &runs);
                }
            }
            let label = p.label().map(str::trim).filter(|l| !l.is_empty() && *l != (page + 1).to_string());
            Ok((json!({ "sheet": sheet, "title": title, "label": label }), all.into_bytes()))
        }
        Request::Find { path, page, query } => {
            let p = cache.page(&path, page)?;
            let text = p.text().map_err(|e| format!("text: {e}"))?;
            let xf = Xform::new(p);
            let mut rects = Vec::new();
            if !query.is_empty() {
                let search = text
                    .search(&query, &PdfSearchOptions::new())
                    .map_err(|e| format!("search: {e}"))?;
                while let Some(segments) = search.find_next() {
                    // One match can span several segments (line breaks): keep each.
                    let mut group = Vec::new();
                    for seg in segments.iter() {
                        group.push(xf.apply(&seg.bounds()));
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
