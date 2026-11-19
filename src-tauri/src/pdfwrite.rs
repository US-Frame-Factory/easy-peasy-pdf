//! Minimal incremental update that adds annotations to a PDF.
//!
//! The appended section contains only: the new annotation objects and their
//! appearance streams, the pages they're on (with the new /Annots entries),
//! and the cross-reference data. Nothing else is rewritten, so the change reads
//! as "annotations added" — the kind of change digital signatures on sealed
//! plans allow — and the original bytes stay untouched.
//!
//! Annotations use standard types (Square, Circle, Ink, FreeText, Line) with
//! their own appearance streams, so every viewer draws them exactly as the app
//! did and Bluebeam / Acrobat treat them as normal markups.

use crate::annotate::{Markup, Style};
use lopdf::{dictionary, Dictionary, Document, IncrementalDocument, Object, ObjectId, Stream, StringFormat};
use std::collections::BTreeMap;

type Pt = [f32; 2];

/// Display (top-left origin, rotated) -> PDF user space for one page.
#[derive(Clone, Copy)]
struct PageMap {
    bx0: f32,
    by1: f32,
    bw: f32,
    bh: f32,
    rot: i64,
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
    fn dir(&self, dx: f32, dy: f32) -> (f32, f32) {
        match self.rot {
            1 => (dy, dx),
            2 => (-dx, dy),
            3 => (-dy, -dx),
            _ => (dx, -dy),
        }
    }
}

// ---------- helpers ----------

fn num(v: &Object) -> Option<f32> {
    match v {
        Object::Integer(i) => Some(*i as f32),
        Object::Real(r) => Some(*r),
        _ => None,
    }
}

/// Page attribute, following /Parent for inherited ones (MediaBox, CropBox, Rotate).
fn inherited<'a>(doc: &'a Document, mut page: &'a Dictionary, key: &[u8]) -> Option<&'a Object> {
    for _ in 0..64 {
        if let Ok(v) = page.get(key) {
            return Some(v);
        }
        let parent = page.get(b"Parent").ok()?.as_reference().ok()?;
        page = doc.get_dictionary(parent).ok()?;
    }
    None
}

fn rect_of(doc: &Document, obj: Option<&Object>) -> Option<[f32; 4]> {
    let obj = obj?;
    let arr = match obj {
        Object::Reference(r) => doc.get_object(*r).ok()?.as_array().ok()?,
        o => o.as_array().ok()?,
    };
    let v: Vec<f32> = arr.iter().filter_map(num).collect();
    (v.len() == 4).then(|| [v[0].min(v[2]), v[1].min(v[3]), v[0].max(v[2]), v[1].max(v[3])])
}

fn page_map(doc: &Document, page: &Dictionary) -> PageMap {
    let media = rect_of(doc, inherited(doc, page, b"MediaBox")).unwrap_or([0.0, 0.0, 612.0, 792.0]);
    let crop = rect_of(doc, inherited(doc, page, b"CropBox")).unwrap_or(media);
    // Effective box = CropBox clipped to MediaBox (as PDFium does).
    let b = [crop[0].max(media[0]), crop[1].max(media[1]), crop[2].min(media[2]), crop[3].min(media[3])];
    let b = if b[2] > b[0] && b[3] > b[1] { b } else { media };
    let rot = inherited(doc, page, b"Rotate").and_then(num).unwrap_or(0.0) as i64;
    PageMap { bx0: b[0], by1: b[3], bw: b[2] - b[0], bh: b[3] - b[1], rot: (rot / 90).rem_euclid(4) }
}

fn rgb(c: &str) -> [f32; 3] {
    let c = c.trim_start_matches('#');
    let v = u32::from_str_radix(c, 16).unwrap_or(0xff0000);
    let (r, g, b) = if c.len() == 3 {
        (((v >> 8) & 0xf) * 17, ((v >> 4) & 0xf) * 17, (v & 0xf) * 17)
    } else {
        ((v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff)
    };
    [r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0]
}

fn f(v: f32) -> String {
    let s = format!("{:.3}", v);
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s == "-0" { "0".into() } else { s.into() }
}

/// PDF text string: plain bytes if ASCII, else UTF-16BE with BOM.
fn text_string(s: &str) -> Object {
    if s.is_ascii() {
        Object::String(s.as_bytes().to_vec(), StringFormat::Literal)
    } else {
        let mut b = vec![0xfe, 0xff];
        for u in s.encode_utf16() {
            b.extend_from_slice(&u.to_be_bytes());
        }
        Object::String(b, StringFormat::Hexadecimal)
    }
}

/// Text for the standard-14 Helvetica (WinAnsi): eighths spelled out, others mapped or '?'.
fn win_ansi(s: &str) -> Vec<u8> {
    let s = s.replace('⅛', " 1/8").replace('⅜', " 3/8").replace('⅝', " 5/8").replace('⅞', " 7/8");
    s.chars()
        .map(|c| match c {
            ' '..='~' => c as u8,
            '½' => 0xBD,
            '¼' => 0xBC,
            '¾' => 0xBE,
            '°' => 0xB0,
            '±' => 0xB1,
            'Ø' => 0xD8,
            'ø' => 0xF8,
            '×' => 0xD7,
            '’' => b'\'',
            '“' | '”' | '″' => b'"',
            '–' | '—' => b'-',
            c if (c as u32) >= 0xA0 && (c as u32) <= 0xFF => c as u32 as u8,
            _ => b'?',
        })
        .collect()
}

/// Helvetica advance widths (1/1000 em) for WinAnsi bytes.
fn helv_width(b: u8) -> f32 {
    const W: [u16; 95] = [
        278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, // space../
        556, 556, 556, 556, 556, 556, 556, 556, 556, 556, // 0-9
        278, 278, 584, 584, 584, 556, 1015, // :..@
        667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667,
        944, 667, 667, 611, // A-Z
        278, 278, 278, 469, 556, 333, // [ \ ] ^ _ `
        556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500,
        722, 500, 500, 500, // a-z
        334, 260, 334, 584, // { | } ~
    ];
    match b {
        32..=126 => W[(b - 32) as usize] as f32,
        0xBC | 0xBD | 0xBE => 834.0,
        _ => 556.0,
    }
}

fn text_width(bytes: &[u8], size: f32) -> f32 {
    bytes.iter().map(|b| helv_width(*b)).sum::<f32>() * size / 1000.0
}

fn pdf_bytes_literal(bytes: &[u8]) -> String {
    let mut s = String::from("(");
    for &b in bytes {
        match b {
            b'(' | b')' | b'\\' => {
                s.push('\\');
                s.push(b as char);
            }
            32..=126 => s.push(b as char),
            _ => s.push_str(&format!("\\{:03o}", b)),
        }
    }
    s.push(')');
    s
}

// ---------- appearance builder ----------

struct Ap {
    map: PageMap,
    ops: String,
    bbox: [f32; 4],
    text: bool,
}

impl Ap {
    fn new(map: PageMap) -> Self {
        Ap { map, ops: String::from("/GS0 gs\n"), bbox: [f32::MAX, f32::MAX, f32::MIN, f32::MIN], text: false }
    }
    fn grow(&mut self, x: f32, y: f32, pad: f32) {
        self.bbox = [self.bbox[0].min(x - pad), self.bbox[1].min(y - pad), self.bbox[2].max(x + pad), self.bbox[3].max(y + pad)];
    }
    fn pt(&mut self, p: Pt, pad: f32) -> (f32, f32) {
        let (x, y) = self.map.to_user(p[0], p[1]);
        self.grow(x, y, pad);
        (x, y)
    }
    fn stroke_setup(&mut self, s: &Style, width: f32, butt: bool) {
        let [r, g, b] = rgb(&s.color);
        self.ops += &format!("{} {} {} RG {} w {} J 1 j\n", f(r), f(g), f(b), f(width), if butt { 0 } else { 1 });
    }
    fn polyline(&mut self, pts: &[Pt], close: bool, s: &Style, width: f32, butt: bool) {
        if pts.is_empty() {
            return;
        }
        self.ops += "q\n";
        self.stroke_setup(s, width, butt);
        for (i, p) in pts.iter().enumerate() {
            let (x, y) = self.pt(*p, width);
            self.ops += &format!("{} {} {}\n", f(x), f(y), if i == 0 { "m" } else { "l" });
        }
        self.ops += if close { "s\nQ\n" } else { "S\nQ\n" };
    }
    fn filled(&mut self, pts: &[Pt], color: &str) {
        let [r, g, b] = rgb(color);
        self.ops += &format!("q {} {} {} rg\n", f(r), f(g), f(b));
        for (i, p) in pts.iter().enumerate() {
            let (x, y) = self.pt(*p, 0.5);
            self.ops += &format!("{} {} {}\n", f(x), f(y), if i == 0 { "m" } else { "l" });
        }
        self.ops += "f\nQ\n";
    }
    fn ellipse(&mut self, a: Pt, c: Pt, s: &Style) {
        let (cx, cy) = ((a[0] + c[0]) / 2.0, (a[1] + c[1]) / 2.0);
        let (rx, ry) = (((c[0] - a[0]) / 2.0).abs(), ((c[1] - a[1]) / 2.0).abs());
        const K: f32 = 0.552_284_8;
        let p = |x: f32, y: f32| -> Pt { [cx + x * rx, cy + y * ry] };
        self.ops += "q\n";
        self.stroke_setup(s, s.width, false);
        let (x0, y0) = self.pt(p(1.0, 0.0), s.width);
        self.ops += &format!("{} {} m\n", f(x0), f(y0));
        let quads = [
            [(1.0, K), (K, 1.0), (0.0, 1.0)],
            [(-K, 1.0), (-1.0, K), (-1.0, 0.0)],
            [(-1.0, -K), (-K, -1.0), (0.0, -1.0)],
            [(K, -1.0), (1.0, -K), (1.0, 0.0)],
        ];
        for q in quads {
            let (x1, y1) = self.pt(p(q[0].0, q[0].1), s.width);
            let (x2, y2) = self.pt(p(q[1].0, q[1].1), s.width);
            let (x3, y3) = self.pt(p(q[2].0, q[2].1), s.width);
            self.ops += &format!("{} {} {} {} {} {} c\n", f(x1), f(y1), f(x2), f(y2), f(x3), f(y3));
        }
        self.ops += "h S\nQ\n";
    }
    /// One line of text; (x, y) = baseline start (or middle if `center`) in display points.
    fn text(&mut self, s: &str, x: f32, y: f32, angle: f32, size: f32, color: &str, center: bool) {
        let bytes = win_ansi(s);
        let width = text_width(&bytes, size);
        let (dx, dy) = (angle.cos(), angle.sin());
        let (mut ox, mut oy) = (x, y);
        if center {
            ox -= dx * width / 2.0;
            oy -= dy * width / 2.0;
        }
        let (a, b) = self.map.dir(dx, dy);
        let (c, d) = self.map.dir(dy, -dx);
        let (e, fy) = self.map.to_user(ox, oy);
        for (u, v) in [(0.0, -size * 0.25), (width, -size * 0.25), (0.0, size), (width, size)] {
            let p = [ox + dx * u + dy * v, oy + dy * u - dx * v];
            self.pt(p, 1.0);
        }
        let [r, g, bl] = rgb(color);
        self.ops += &format!(
            "BT /Helv {} Tf {} {} {} rg {} {} {} {} {} {} Tm {} Tj ET\n",
            f(size), f(r), f(g), f(bl), f(a), f(b), f(c), f(d), f(e), f(fy), pdf_bytes_literal(&bytes)
        );
        self.text = true;
    }
}

fn text_box(ap: &mut Ap, m: &Markup) {
    let s = &m.style;
    let [x, y, w, h] = m.r#box.unwrap_or([0.0, 0.0, 100.0, 20.0]);
    if s.width > 0.0 {
        ap.polyline(&[[x, y], [x + w, y], [x + w, y + h], [x, y + h]], true, s, s.width, false);
    }
    let pad = s.size * 0.3;
    for (i, line) in m.text.lines().enumerate() {
        let by = y + pad + s.size * (0.9 + i as f32 * 1.2);
        ap.text(line, x + pad, by, 0.0, s.size, &s.text_color, false);
    }
}

/// Builds one annotation: (annotation dictionary without /AP /P, appearance content, uses text?).
fn build(m: &Markup, map: PageMap) -> Option<(Dictionary, Ap)> {
    let s = &m.style;
    let mut ap = Ap::new(map);
    let user = |p: Pt| -> (f32, f32) { map.to_user(p[0], p[1]) };
    let [r, g, b] = rgb(&s.color);
    let color = Object::Array(vec![r.into(), g.into(), b.into()]);
    let bs = dictionary! { "W" => s.width, "S" => "S" };
    let mut d = dictionary! { "Type" => "Annot", "F" => 4 };
    match m.kind.as_str() {
        "pen" | "highlight" => {
            ap.polyline(&m.pts, false, s, s.width, false);
            let mut ink = Vec::new();
            for p in &m.pts {
                let (x, y) = user(*p);
                ink.push(Object::Real(x));
                ink.push(Object::Real(y));
            }
            d.set("Subtype", "Ink");
            d.set("InkList", vec![Object::Array(ink)]);
            d.set("C", color);
            d.set("BS", bs);
            d.set("Subj", if m.kind == "pen" { "Pen" } else { "Highlight" });
        }
        "rect" if m.pts.len() >= 2 => {
            let ([x0, y0], [x1, y1]) = (m.pts[0], m.pts[1]);
            ap.polyline(&[[x0, y0], [x1, y0], [x1, y1], [x0, y1]], true, s, s.width, false);
            d.set("Subtype", "Square");
            d.set("C", color);
            d.set("BS", bs);
            d.set("Subj", "Rectangle");
        }
        "ellipse" if m.pts.len() >= 2 => {
            ap.ellipse(m.pts[0], m.pts[1], s);
            d.set("Subtype", "Circle");
            d.set("C", color);
            d.set("BS", bs);
            d.set("Subj", "Ellipse");
        }
        "text" | "callout" => {
            let [tr, tg, tb] = rgb(&s.text_color);
            d.set("Subtype", "FreeText");
            d.set("DA", Object::string_literal(format!("/Helv {} Tf {} {} {} rg", f(s.size), f(tr), f(tg), f(tb))));
            d.set("Contents", text_string(&m.text));
            d.set("BS", bs);
            if m.kind == "callout" && !m.pts.is_empty() {
                let [x, y, w, h] = m.r#box.unwrap_or([0.0, 0.0, 100.0, 20.0]);
                let tip = m.pts[0];
                let from = [tip[0].clamp(x, x + w), tip[1].clamp(y, y + h)];
                let (dx, dy) = (tip[0] - from[0], tip[1] - from[1]);
                let len = (dx * dx + dy * dy).sqrt().max(0.001);
                let (ux, uy) = (dx / len, dy / len);
                let ah = (s.width * 3.0 + 6.0).min(len * 0.8);
                let base = [tip[0] - ux * ah, tip[1] - uy * ah];
                ap.polyline(&[from, base], false, s, s.width, false);
                let half = ah * 0.45;
                ap.filled(&[tip, [base[0] - uy * half, base[1] + ux * half], [base[0] + uy * half, base[1] - ux * half]], &s.color);
                let (t0, t1) = user(tip);
                let (f0, f1) = user(from);
                d.set("IT", "FreeTextCallout");
                d.set("CL", vec![t0.into(), t1.into(), f0.into(), f1.into()]);
                d.set("LE", "ClosedArrow");
                d.set("Subj", "Callout");
            } else {
                d.set("Subj", "Text Box");
            }
            text_box(&mut ap, m);
        }
        "measure" if m.pts.len() >= 2 => {
            let (a, c) = (m.pts[0], m.pts[1]);
            let (dx, dy) = (c[0] - a[0], c[1] - a[1]);
            let len = (dx * dx + dy * dy).sqrt().max(0.001);
            let (nx, ny) = (-dy / len, dx / len);
            let tick = (s.width * 2.5).max(5.0);
            ap.polyline(&[a, c], false, s, s.width, true);
            for p in [a, c] {
                ap.polyline(&[[p[0] - nx * tick, p[1] - ny * tick], [p[0] + nx * tick, p[1] + ny * tick]], false, s, s.width, true);
            }
            let mut ang = dy.atan2(dx);
            if !(-std::f32::consts::FRAC_PI_2..=std::f32::consts::FRAC_PI_2).contains(&ang) {
                ang += std::f32::consts::PI;
            }
            let up = (ang.sin(), -ang.cos());
            let gap = tick.max(s.width) + s.size * 0.25;
            let (mx, my) = ((a[0] + c[0]) / 2.0 + up.0 * gap, (a[1] + c[1]) / 2.0 + up.1 * gap);
            ap.text(&m.text, mx, my, ang, s.size, &s.text_color, true);
            let (x0, y0) = user(a);
            let (x1, y1) = user(c);
            d.set("Subtype", "Line");
            d.set("L", vec![x0.into(), y0.into(), x1.into(), y1.into()]);
            d.set("LE", vec![Object::Name(b"Butt".to_vec()), Object::Name(b"Butt".to_vec())]);
            d.set("IT", "LineDimension");
            d.set("Cap", true);
            d.set("C", color);
            d.set("BS", bs);
            d.set("Contents", text_string(&m.text));
            d.set("Subj", "Length Measurement");
        }
        _ => return None,
    }
    if ap.bbox[0] > ap.bbox[2] {
        return None;
    }
    if s.opacity < 1.0 {
        d.set("CA", s.opacity.clamp(0.0, 1.0));
    }
    Some((d, ap))
}

pub fn save(src: Vec<u8>, dest: &str, author: &str, date: &str, markups: &[Markup]) -> Result<usize, String> {
    let prev = Document::load_mem(&src).map_err(|e| format!("lopdf could not read the PDF: {e}"))?;
    if prev.is_encrypted() {
        return Err("encrypted PDF".into());
    }
    let pages: BTreeMap<u32, ObjectId> = prev.get_pages();
    let mut inc = IncrementalDocument::create_from(src, prev);
    let font = dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica", "Encoding" => "WinAnsiEncoding" };
    let mut font_id: Option<ObjectId> = None;
    let mut count = 0;

    let mut by_page: BTreeMap<u32, Vec<&Markup>> = BTreeMap::new();
    for m in markups {
        by_page.entry(m.page).or_default().push(m);
    }
    for (page, list) in by_page {
        let Some(&pid) = pages.get(&(page + 1)) else { continue };
        let map = {
            let prev = inc.get_prev_documents();
            let pd = prev.get_dictionary(pid).map_err(|e| format!("page {}: {e}", page + 1))?;
            page_map(prev, pd)
        };
        let mut refs: Vec<Object> = Vec::new();
        for m in list {
            let Some((mut d, ap)) = build(m, map) else { continue };
            let b = ap.bbox;
            let rect: Vec<Object> = b.iter().map(|v| Object::Real(*v)).collect();
            let mut res = dictionary! {
                "ExtGState" => dictionary! { "GS0" => dictionary! { "Type" => "ExtGState", "CA" => m.style.opacity.clamp(0.0, 1.0), "ca" => m.style.opacity.clamp(0.0, 1.0) } },
            };
            if ap.text {
                let fid = *font_id.get_or_insert_with(|| inc.new_document.add_object(font.clone()));
                res.set("Font", dictionary! { "Helv" => fid });
            }
            let mut stream = Stream::new(
                dictionary! {
                    "Type" => "XObject", "Subtype" => "Form", "FormType" => 1,
                    "BBox" => rect.clone(), "Matrix" => vec![1.into(), 0.into(), 0.into(), 1.into(), 0.into(), 0.into()],
                    "Resources" => res,
                },
                ap.ops.into_bytes(),
            );
            let _ = stream.compress();
            let ap_id = inc.new_document.add_object(stream);
            d.set("Rect", rect);
            d.set("AP", dictionary! { "N" => ap_id });
            d.set("P", pid);
            if !m.id.is_empty() {
                d.set("NM", text_string(&m.id));
            }
            if !author.is_empty() {
                d.set("T", text_string(author));
            }
            d.set("M", Object::string_literal(date));
            d.set("CreationDate", Object::string_literal(date));
            refs.push(Object::Reference(inc.new_document.add_object(d)));
            count += 1;
        }
        if refs.is_empty() {
            continue;
        }
        // Add to the page's /Annots (inline array, referenced array, or new).
        inc.opt_clone_object_to_new_document(pid).map_err(|e| e.to_string())?;
        let annots = inc.new_document.get_dictionary(pid).map_err(|e| e.to_string())?.get(b"Annots").ok().cloned();
        match annots {
            Some(Object::Reference(aid)) => {
                inc.opt_clone_object_to_new_document(aid).map_err(|e| e.to_string())?;
                match inc.new_document.get_object_mut(aid).map_err(|e| e.to_string())? {
                    Object::Array(a) => a.extend(refs),
                    _ => return Err("unexpected /Annots".into()),
                }
            }
            Some(Object::Array(mut a)) => {
                a.extend(refs);
                inc.new_document.get_dictionary_mut(pid).map_err(|e| e.to_string())?.set("Annots", a);
            }
            _ => {
                inc.new_document.get_dictionary_mut(pid).map_err(|e| e.to_string())?.set("Annots", refs);
            }
        }
    }
    let mut out = std::io::BufWriter::new(std::fs::File::create(dest).map_err(|e| format!("cannot write {dest}: {e}"))?);
    inc.save_to(&mut out).map_err(|e| format!("saving failed: {e}"))?;
    use std::io::Write;
    out.flush().map_err(|e| e.to_string())?;
    out.into_inner().map_err(|e| e.to_string())?.sync_all().map_err(|e| e.to_string())?;
    Ok(count)
}
