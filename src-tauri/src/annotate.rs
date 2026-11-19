//! `--save-markups`: writes the app's markups into a PDF as standard annotations.
//!
//! Runs in its own short-lived process (so a PDFium crash can't take the app
//! down) and talks to PDFium through the raw bindings, because we need an
//! *incremental* save: the original file's bytes stay untouched and the
//! annotations are appended, which keeps stamps, linearization and digital
//! signatures intact.
//!
//! Each markup becomes a Stamp annotation whose appearance is built from path
//! and text objects, so it looks the same in every viewer (Bluebeam, Acrobat,
//! browsers) and can be moved or deleted there.
//!
//! Input (stdin, JSON): { src, dest, author, markups: [Markup] }
//! Output (stdout, JSON): { ok, count } or { ok: false, error }

use pdfium_render::prelude::*;
use serde::Deserialize;
use serde_json::json;
use std::ffi::c_void;
use std::io::{Read, Write};
use std::os::raw::{c_int, c_ulong};
use std::path::PathBuf;

const FPDF_ANNOT_STAMP: c_int = 13;
const FPDF_ANNOT_FLAG_PRINT: c_int = 4;
const FPDF_INCREMENTAL: u32 = 1;
const FILL_NONE: c_int = 0;
const FILL_WINDING: c_int = 2;
const ROUND: c_int = 1;

#[derive(Deserialize)]
struct Job {
    src: String,
    dest: String,
    #[serde(default)]
    author: String,
    markups: Vec<Markup>,
}

#[derive(Deserialize, Clone)]
pub struct Style {
    #[serde(default = "red")]
    pub(crate) color: String,
    #[serde(default = "red", rename = "textColor")]
    pub(crate) text_color: String,
    #[serde(default = "two")]
    pub(crate) width: f32,
    #[serde(default = "twelve")]
    pub(crate) size: f32,
    #[serde(default = "one")]
    pub(crate) opacity: f32,
}
fn red() -> String {
    "#ff0000".into()
}
fn two() -> f32 {
    2.0
}
fn twelve() -> f32 {
    12.0
}
fn one() -> f32 {
    1.0
}

/// Geometry is in display points: top-left origin, page rotation applied
/// (exactly what the viewer draws in).
#[derive(Deserialize)]
pub struct Markup {
    #[serde(default)]
    pub(crate) id: String,
    pub(crate) page: u32,
    pub(crate) kind: String,
    #[serde(default)]
    pub(crate) pts: Vec<[f32; 2]>,
    /// Text box [x, y, w, h] for text / callout.
    #[serde(default)]
    pub(crate) r#box: Option<[f32; 4]>,
    #[serde(default)]
    pub(crate) text: String,
    pub(crate) style: Style,
}

fn hex(c: &str) -> (u32, u32, u32) {
    let c = c.trim_start_matches('#');
    let v = u32::from_str_radix(c, 16).unwrap_or(0xff0000);
    if c.len() == 3 {
        let (r, g, b) = ((v >> 8) & 0xf, (v >> 4) & 0xf, v & 0xf);
        (r * 17, g * 17, b * 17)
    } else {
        ((v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff)
    }
}

/// Display (top-left, rotated) ↔ PDF user space for one page.
#[derive(Clone, Copy)]
struct PageMap {
    bx0: f32,
    by1: f32,
    bw: f32,
    bh: f32,
    rot: i32, // 0..3 quarter turns clockwise
}

impl PageMap {
    fn to_user(&self, x: f32, y: f32) -> (f32, f32) {
        let (u, v) = match self.rot {
            1 => (y, self.bh - x),
            2 => (self.bw - x, self.bh - y),
            3 => (self.bw - y, x),
            _ => (x, y),
        };
        (self.bx0 + u, self.by1 - v)
    }
    /// Linear part of to_user (for directions).
    fn dir(&self, dx: f32, dy: f32) -> (f32, f32) {
        match self.rot {
            1 => (dy, dx),
            2 => (-dx, dy),
            3 => (-dy, -dx),
            _ => (dx, -dy),
        }
    }
}

struct Ctx<'a> {
    b: &'a dyn PdfiumLibraryBindings,
    doc: FPDF_DOCUMENT,
    map: PageMap,
    /// Bounding box in user space of everything added to the current annotation.
    bbox: [f32; 4],
    /// Objects are attached only after the annotation's Rect is set: PDFium sizes the
    /// appearance stream's BBox from the Rect when the first object is appended.
    objs: Vec<FPDF_PAGEOBJECT>,
}

impl Ctx<'_> {
    fn grow(&mut self, x: f32, y: f32, pad: f32) {
        let b = &mut self.bbox;
        b[0] = b[0].min(x - pad);
        b[1] = b[1].min(y - pad);
        b[2] = b[2].max(x + pad);
        b[3] = b[3].max(y + pad);
    }

    /// A stroked (optionally filled) path through display points.
    unsafe fn path(
        &mut self,
        pts: &[[f32; 2]],
        close: bool,
        stroke: Option<(&str, f32, f32)>,
        fill: Option<(&str, f32)>,
    ) {
        if pts.is_empty() {
            return;
        }
        let b = self.b;
        let pad = stroke.map(|s| s.1).unwrap_or(0.0);
        let (x0, y0) = self.map.to_user(pts[0][0], pts[0][1]);
        let obj = b.FPDFPageObj_CreateNewPath(x0, y0);
        self.grow(x0, y0, pad);
        for p in &pts[1..] {
            let (x, y) = self.map.to_user(p[0], p[1]);
            b.FPDFPath_LineTo(obj, x, y);
            self.grow(x, y, pad);
        }
        if close {
            b.FPDFPath_Close(obj);
        }
        self.finish_path(obj, stroke, fill);
    }

    unsafe fn finish_path(
        &mut self,
        obj: FPDF_PAGEOBJECT,
        stroke: Option<(&str, f32, f32)>,
        fill: Option<(&str, f32)>,
    ) {
        let b = self.b;
        if let Some((c, w, a)) = stroke {
            let (r, g, bl) = hex(c);
            b.FPDFPageObj_SetStrokeColor(obj, r, g, bl, (a.clamp(0.0, 1.0) * 255.0).round() as u32);
            b.FPDFPageObj_SetStrokeWidth(obj, w);
            b.FPDFPageObj_SetLineCap(obj, ROUND);
            b.FPDFPageObj_SetLineJoin(obj, ROUND);
        }
        if let Some((c, a)) = fill {
            let (r, g, bl) = hex(c);
            b.FPDFPageObj_SetFillColor(obj, r, g, bl, (a.clamp(0.0, 1.0) * 255.0).round() as u32);
        }
        let mode = if fill.is_some() { FILL_WINDING } else { FILL_NONE };
        b.FPDFPath_SetDrawMode(obj, mode, stroke.is_some() as FPDF_BOOL);
        self.objs.push(obj);
    }

    /// Ellipse inscribed in the display rect (x0,y0)-(x1,y1).
    unsafe fn ellipse(&mut self, a: [f32; 2], c: [f32; 2], stroke: (&str, f32, f32)) {
        let (cx, cy) = ((a[0] + c[0]) / 2.0, (a[1] + c[1]) / 2.0);
        let (rx, ry) = (((c[0] - a[0]) / 2.0).abs(), ((c[1] - a[1]) / 2.0).abs());
        const K: f32 = 0.552_284_8;
        let map = self.map;
        let p = |x: f32, y: f32| map.to_user(cx + x * rx, cy + y * ry);
        let b = self.b;
        let (sx, sy) = p(1.0, 0.0);
        let obj = b.FPDFPageObj_CreateNewPath(sx, sy);
        let quads = [
            [(1.0, K), (K, 1.0), (0.0, 1.0)],
            [(-K, 1.0), (-1.0, K), (-1.0, 0.0)],
            [(-1.0, -K), (-K, -1.0), (0.0, -1.0)],
            [(K, -1.0), (1.0, -K), (1.0, 0.0)],
        ];
        for q in quads {
            let (x1, y1) = p(q[0].0, q[0].1);
            let (x2, y2) = p(q[1].0, q[1].1);
            let (x3, y3) = p(q[2].0, q[2].1);
            b.FPDFPath_BezierTo(obj, x1, y1, x2, y2, x3, y3);
        }
        b.FPDFPath_Close(obj);
        for (x, y) in [(-1.0, -1.0), (1.0, 1.0)] {
            let (ux, uy) = p(x, y);
            self.grow(ux, uy, stroke.1);
        }
        self.finish_path(obj, Some(stroke), None);
    }

    /// One line of text. (x, y) is the left end of the baseline in display points;
    /// `angle` is the display-space direction of the text (radians, y down).
    /// Returns the text width in points.
    unsafe fn text(&mut self, s: &str, x: f32, y: f32, angle: f32, size: f32, color: &str, opacity: f32, center: bool) -> f32 {
        let b = self.b;
        let obj = b.FPDFPageObj_NewTextObj(self.doc, "Helvetica", size);
        if obj.is_null() {
            return 0.0;
        }
        b.FPDFText_SetText_str(obj, s);
        let (r, g, bl) = hex(color);
        b.FPDFPageObj_SetFillColor(obj, r, g, bl, (opacity.clamp(0.0, 1.0) * 255.0).round() as u32);
        let (mut l, mut bo, mut ri, mut t) = (0f32, 0f32, 0f32, 0f32);
        b.FPDFPageObj_GetBounds(obj, &mut l, &mut bo, &mut ri, &mut t);
        let width = (ri - l).max(0.0);
        let (dx, dy) = (angle.cos(), angle.sin());
        let (mut ox, mut oy) = (x, y);
        if center {
            ox -= dx * width / 2.0;
            oy -= dy * width / 2.0;
        }
        // Text space: +x along the reading direction, +y "up" (display: rotate -90°).
        let (ax, ay) = self.map.dir(dx, dy);
        let (cx, cy) = self.map.dir(dy, -dx);
        let (ex, ey) = self.map.to_user(ox, oy);
        b.FPDFPageObj_Transform(obj, ax as f64, ay as f64, cx as f64, cy as f64, ex as f64, ey as f64);
        // Bounding box: the four corners of the text run.
        for (u, v) in [(0.0, -size * 0.25), (width, -size * 0.25), (0.0, size), (width, size)] {
            let (px, py) = (ox + dx * u + dy * v, oy + dy * u - dx * v);
            let (ux, uy) = self.map.to_user(px, py);
            self.grow(ux, uy, 1.0);
        }
        self.objs.push(obj);
        width
    }
}

fn pdf_text(s: &str) -> String {
    // Standard-14 Helvetica (WinAnsi) has ½ ¼ ¾ but not eighths: spell those out.
    s.replace('⅛', " 1/8").replace('⅜', " 3/8").replace('⅝', " 5/8").replace('⅞', " 7/8")
}

fn pdf_date() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let days = (secs / 86400) as i64;
    // Civil-from-days (Howard Hinnant), UTC.
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + (m <= 2) as i64;
    let t = secs % 86400;
    format!("D:{y:04}{m:02}{d:02}{:02}{:02}{:02}Z", t / 3600, (t / 60) % 60, t % 60)
}

unsafe fn add_markup(b: &dyn PdfiumLibraryBindings, doc: FPDF_DOCUMENT, page: FPDF_PAGE, map: PageMap, m: &Markup, author: &str, date: &str) -> Result<(), String> {
    let annot = b.FPDFPage_CreateAnnot(page, FPDF_ANNOT_STAMP);
    if annot.is_null() {
        return Err("could not create annotation".into());
    }
    let mut cx = Ctx { b, doc, map, bbox: [f32::MAX, f32::MAX, f32::MIN, f32::MIN], objs: Vec::new() };
    let s = &m.style;
    let stroke = (s.color.as_str(), s.width.max(0.1), s.opacity);
    let (subject, contents) = match m.kind.as_str() {
        "pen" | "highlight" => {
            cx.path(&m.pts, false, Some(stroke), None);
            (if m.kind == "pen" { "Pen" } else { "Highlight" }, String::new())
        }
        "rect" if m.pts.len() >= 2 => {
            let ([x0, y0], [x1, y1]) = (m.pts[0], m.pts[1]);
            cx.path(&[[x0, y0], [x1, y0], [x1, y1], [x0, y1]], true, Some(stroke), None);
            ("Rectangle", String::new())
        }
        "ellipse" if m.pts.len() >= 2 => {
            cx.ellipse(m.pts[0], m.pts[1], stroke);
            ("Ellipse", String::new())
        }
        "text" | "callout" => {
            let [x, y, w, h] = m.r#box.unwrap_or([0.0, 0.0, 100.0, 20.0]);
            if m.kind == "callout" && !m.pts.is_empty() {
                // Leader from the nearest point on the box edge to the tip, with an arrowhead.
                let tip = m.pts[0];
                let from = [tip[0].clamp(x, x + w), tip[1].clamp(y, y + h)];
                let (dx, dy) = (tip[0] - from[0], tip[1] - from[1]);
                let len = (dx * dx + dy * dy).sqrt().max(0.001);
                let (ux, uy) = (dx / len, dy / len);
                let ah = (s.width * 3.0 + 6.0).min(len * 0.8);
                let base = [tip[0] - ux * ah, tip[1] - uy * ah];
                cx.path(&[from, base], false, Some(stroke), None);
                let half = ah * 0.45;
                let tri = [tip, [base[0] - uy * half, base[1] + ux * half], [base[0] + uy * half, base[1] - ux * half]];
                cx.path(&tri, true, None, Some((s.color.as_str(), s.opacity)));
            }
            if s.width > 0.0 {
                cx.path(&[[x, y], [x + w, y], [x + w, y + h], [x, y + h]], true, Some(stroke), None);
            }
            let pad = s.size * 0.3;
            for (i, line) in m.text.lines().enumerate() {
                let by = y + pad + s.size * (0.9 + i as f32 * 1.2);
                cx.text(&pdf_text(line), x + pad, by, 0.0, s.size, &s.text_color, s.opacity, false);
            }
            (if m.kind == "text" { "Text Box" } else { "Callout" }, m.text.clone())
        }
        "measure" if m.pts.len() >= 2 => {
            let (a, c) = (m.pts[0], m.pts[1]);
            let (dx, dy) = (c[0] - a[0], c[1] - a[1]);
            let len = (dx * dx + dy * dy).sqrt().max(0.001);
            let (ux, uy) = (dx / len, dy / len);
            let (nx, ny) = (-uy, ux);
            let tick = (s.width * 2.5).max(5.0);
            cx.path(&[a, c], false, Some(stroke), None);
            for p in [a, c] {
                cx.path(&[[p[0] - nx * tick, p[1] - ny * tick], [p[0] + nx * tick, p[1] + ny * tick]], false, Some(stroke), None);
            }
            // Label above the middle of the line, kept upright.
            let mut ang = dy.atan2(dx);
            if ang > std::f32::consts::FRAC_PI_2 || ang < -std::f32::consts::FRAC_PI_2 {
                ang += std::f32::consts::PI;
            }
            let (lx, ly) = (ang.cos(), ang.sin());
            let up = (ly, -lx); // display "up" relative to the label
            let gap = tick.max(s.width) + s.size * 0.25;
            let (mx, my) = ((a[0] + c[0]) / 2.0 + up.0 * gap, (a[1] + c[1]) / 2.0 + up.1 * gap);
            let label = pdf_text(&m.text);
            cx.text(&label, mx, my, ang, s.size, &s.text_color, s.opacity, true);
            ("Length Measurement", label)
        }
        _ => {
            b.FPDFPage_CloseAnnot(annot);
            return Ok(());
        }
    };
    let r = cx.bbox;
    if r[0] <= r[2] {
        let rect = FS_RECTF { left: r[0], top: r[3], right: r[2], bottom: r[1] };
        b.FPDFAnnot_SetRect(annot, &rect);
    }
    for obj in std::mem::take(&mut cx.objs) {
        b.FPDFAnnot_AppendObject(annot, obj);
    }
    b.FPDFAnnot_SetFlags(annot, FPDF_ANNOT_FLAG_PRINT);
    b.FPDFAnnot_SetStringValue_str(annot, "Subj", subject);
    if !contents.is_empty() {
        b.FPDFAnnot_SetStringValue_str(annot, "Contents", &contents);
    }
    if !author.is_empty() {
        b.FPDFAnnot_SetStringValue_str(annot, "T", author);
    }
    if !m.id.is_empty() {
        b.FPDFAnnot_SetStringValue_str(annot, "NM", &m.id);
    }
    b.FPDFAnnot_SetStringValue_str(annot, "M", date);
    b.FPDFAnnot_SetStringValue_str(annot, "CreationDate", date);
    b.FPDFPage_CloseAnnot(annot);
    Ok(())
}

#[repr(C)]
struct FileWriter {
    fw: FPDF_FILEWRITE,
    out: std::fs::File,
    failed: bool,
}

unsafe extern "C" fn write_block(this: *mut FPDF_FILEWRITE, data: *const c_void, size: c_ulong) -> c_int {
    let w = &mut *(this as *mut FileWriter);
    let buf = std::slice::from_raw_parts(data as *const u8, size as usize);
    if w.out.write_all(buf).is_err() {
        w.failed = true;
        return 0;
    }
    1
}

/// PDFium's incremental save writes the new cross-reference stream without the
/// required `/Type /XRef` entry, which strict readers reject. The appended
/// section is ours, so insert it there (inside the dictionary, before `stream`,
/// so no offsets or lengths change).
fn fix_xref_stream_type(path: &str, original_len: usize) -> std::io::Result<()> {
    let mut data = std::fs::read(path)?;
    let tail_start = data.len().saturating_sub(64);
    let tail = String::from_utf8_lossy(&data[tail_start..]).to_string();
    let Some(sx) = tail.rfind("startxref") else { return Ok(()) };
    let off: usize = match tail[sx + 9..].split_whitespace().next().and_then(|n| n.parse().ok()) {
        Some(o) => o,
        None => return Ok(()),
    };
    if off < original_len || off >= data.len() {
        return Ok(()); // not in the appended part: leave it alone
    }
    let end = (off + 4096).min(data.len());
    let head = &data[off..end];
    let Some(dict) = head.windows(2).position(|w| w == b"<<") else { return Ok(()) };
    let stream_at = head.windows(6).position(|w| w == b"stream").unwrap_or(head.len());
    let dict_text = String::from_utf8_lossy(&head[dict..stream_at]);
    if dict_text.contains("/W") && !dict_text.contains("/Type") {
        let at = off + dict + 2;
        data.splice(at..at, b"/Type/XRef".iter().copied());
        std::fs::write(path, &data)?;
    }
    Ok(())
}

unsafe fn page_map(b: &dyn PdfiumLibraryBindings, page: FPDF_PAGE) -> PageMap {
    let (mut l, mut bo, mut r, mut t) = (0f32, 0f32, 0f32, 0f32);
    if !b.is_true(b.FPDFPage_GetCropBox(page, &mut l, &mut bo, &mut r, &mut t)) {
        b.FPDFPage_GetMediaBox(page, &mut l, &mut bo, &mut r, &mut t);
    }
    let (x0, x1) = (l.min(r), l.max(r));
    let (y0, y1) = (bo.min(t), bo.max(t));
    PageMap { bx0: x0, by1: y1, bw: x1 - x0, bh: y1 - y0, rot: b.FPDFPage_GetRotation(page).rem_euclid(4) }
}

fn save(lib: &PathBuf, job: Job) -> Result<usize, String> {
    // Preferred: a minimal incremental update (only the new annotations and their pages).
    let date = pdf_date();
    let src = std::fs::read(&job.src).map_err(|e| format!("cannot read {}: {e}", job.src))?;
    match crate::pdfwrite::save(src, &job.dest, &job.author, &date, &job.markups) {
        Ok(n) => return Ok(n),
        Err(e) => eprintln!("[save] minimal update failed ({e}); falling back to PDFium"),
    }
    let b = Pdfium::bind_to_library(lib).map_err(|e| format!("cannot load PDFium: {e}"))?;
    let b: &dyn PdfiumLibraryBindings = &*b;
    // Read into memory so the source file isn't held open (it may be replaced).
    let bytes = std::fs::read(&job.src).map_err(|e| format!("cannot read {}: {e}", job.src))?;
    let date = pdf_date();
    unsafe {
        b.FPDF_InitLibrary();
        let doc = b.FPDF_LoadMemDocument64(&bytes, None);
        if doc.is_null() {
            return Err(format!("cannot open PDF (error {})", b.FPDF_GetLastError()));
        }
        let n = b.FPDF_GetPageCount(doc).max(0) as u32;
        let mut pages: Vec<u32> = job.markups.iter().map(|m| m.page).filter(|p| *p < n).collect();
        pages.sort_unstable();
        pages.dedup();
        let mut count = 0;
        let mut err = None;
        for p in pages {
            let page = b.FPDF_LoadPage(doc, p as c_int);
            if page.is_null() {
                err = Some(format!("cannot load page {}", p + 1));
                break;
            }
            for m in job.markups.iter().filter(|m| m.page == p) {
                match add_markup(b, doc, page, page_map(b, page), m, &job.author, &date) {
                    Ok(()) => count += 1,
                    Err(e) => err = Some(e),
                }
            }
            b.FPDF_ClosePage(page);
        }
        if let Some(e) = err {
            b.FPDF_CloseDocument(doc);
            return Err(e);
        }
        let out = std::fs::File::create(&job.dest).map_err(|e| format!("cannot write {}: {e}", job.dest))?;
        let mut w = FileWriter { fw: FPDF_FILEWRITE { version: 1, WriteBlock: Some(write_block) }, out, failed: false };
        let ok = b.is_true(b.FPDF_SaveAsCopy(doc, &mut w.fw, FPDF_INCREMENTAL as FPDF_DWORD));
        b.FPDF_CloseDocument(doc);
        if !ok || w.failed || w.out.sync_all().is_err() {
            return Err("saving failed".into());
        }
        drop(w);
        fix_xref_stream_type(&job.dest, bytes.len()).map_err(|e| format!("saving failed: {e}"))?;
        Ok(count)
    }
}

pub fn run(args: &[String]) -> i32 {
    let lib = args
        .iter()
        .position(|a| a == "--pdfium")
        .and_then(|i| args.get(i + 1))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(crate::worker::pdfium_lib_name()));
    let mut input = String::new();
    let result = std::io::stdin()
        .read_to_string(&mut input)
        .map_err(|e| e.to_string())
        .and_then(|_| serde_json::from_str::<Job>(&input).map_err(|e| format!("bad request: {e}")))
        .and_then(|job| save(&lib, job));
    let out = match result {
        Ok(count) => json!({ "ok": true, "count": count }),
        Err(e) => json!({ "ok": false, "error": e }),
    };
    println!("{out}");
    0
}
