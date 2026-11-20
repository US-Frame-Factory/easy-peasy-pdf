//! In-place editing of the PDF's own text (not markups).
//!
//! Each edit replaces the text of one top-level text object on a page, and
//! nothing else on the page is touched:
//!
//! 1. PDFium identifies the object (its text, position, size, colour, font).
//! 2. The page's drawing instructions are decoded and the one instruction that
//!    draws that text is found (by its order among the text instructions,
//!    checked against the decoded text).
//! 3. That instruction is removed (or, if later text continues from where it
//!    ended, made invisible with `3 Tr` … restore, so every later glyph stays
//!    exactly where it was), and the new text is drawn at the
//!    same spot, size, angle and colour. If every character of the new text is
//!    available in the original (often subset-embedded) font, that font is
//!    used, so it looks identical; otherwise the closest standard font
//!    (Helvetica / Times / Courier, bold / italic as the original).
//! 4. Only the page dictionary and one new content stream are written, as an
//!    incremental update; the original bytes stay as they were.

use lopdf::content::{Content, Operation};
use lopdf::{dictionary, Dictionary, Document, Encoding, IncrementalDocument, Object, ObjectId, Stream, StringFormat};
use pdfium_render::prelude::*;
use serde::Deserialize;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::os::raw::c_int;

const FPDF_PAGEOBJ_TEXT: c_int = 1;

#[derive(Deserialize, Clone)]
pub struct TextEdit {
    pub page: u32,
    /// Index of the text object in the page's object list.
    pub index: i32,
    /// The object's text when it was picked (checked before changing anything).
    pub orig: String,
    /// New text; empty deletes the text.
    pub text: String,
}

/// What PDFium knows about the object being edited.
struct Target {
    ord: usize,
    orig: String,
    text: String,
    matrix: [f32; 6],
    size: f32,
    fill: [u32; 3],
    stroke: [u32; 3],
    mode: i32,
    standard: &'static str,
    /// Characters drawn with this font on the page (the glyphs a subset font is sure to have).
    font_chars: HashSet<char>,
    subset: bool,
}

unsafe fn obj_text(b: &dyn PdfiumLibraryBindings, obj: FPDF_PAGEOBJECT, tp: FPDF_TEXTPAGE) -> String {
    let n = b.FPDFTextObj_GetText(obj, tp, std::ptr::null_mut(), 0);
    if n <= 2 {
        return String::new();
    }
    let mut buf = vec![0u16; (n as usize).div_ceil(2)];
    b.FPDFTextObj_GetText(obj, tp, buf.as_mut_ptr() as *mut FPDF_WCHAR, n);
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

unsafe fn base_font_name(b: &dyn PdfiumLibraryBindings, font: FPDF_FONT) -> String {
    let mut buf = vec![0u8; 256];
    let n = b.FPDFFont_GetBaseFontName(font, buf.as_mut_ptr() as *mut _, buf.len() as _) as usize;
    let end = buf[..n.min(buf.len())].iter().position(|&c| c == 0).unwrap_or(n.min(buf.len()));
    String::from_utf8_lossy(&buf[..end]).to_string()
}

/// The closest standard-14 font for an embedded font.
unsafe fn standard_for(b: &dyn PdfiumLibraryBindings, font: FPDF_FONT) -> &'static str {
    let name = base_font_name(b, font).to_lowercase();
    let name = name.split('+').next_back().unwrap_or(&name).to_string(); // drop the subset tag
    let bold = ["bold", "black", "heavy", "semibold", "demi"].iter().any(|w| name.contains(w)) || b.FPDFFont_GetWeight(font) >= 600;
    let mut angle: c_int = 0;
    let italic = ["italic", "oblique"].iter().any(|w| name.contains(w))
        || (b.is_true(b.FPDFFont_GetItalicAngle(font, &mut angle)) && angle != 0);
    let serif = ["times", "roman", "serif", "georgia", "garamond", "cambria", "book"].iter().any(|w| name.contains(w)) && !name.contains("sans");
    let mono = ["courier", "mono", "consol", "lucidaconsole"].iter().any(|w| name.contains(w));
    match (mono, serif, bold, italic) {
        (true, _, false, false) => "Courier",
        (true, _, true, false) => "Courier-Bold",
        (true, _, false, true) => "Courier-Oblique",
        (true, _, true, true) => "Courier-BoldOblique",
        (_, true, false, false) => "Times-Roman",
        (_, true, true, false) => "Times-Bold",
        (_, true, false, true) => "Times-Italic",
        (_, true, true, true) => "Times-BoldItalic",
        (_, _, false, false) => "Helvetica",
        (_, _, true, false) => "Helvetica-Bold",
        (_, _, false, true) => "Helvetica-Oblique",
        (_, _, true, true) => "Helvetica-BoldOblique",
    }
}

fn is_subset_name(n: &str) -> bool {
    n.len() > 7 && n.as_bytes()[6] == b'+' && n[..6].bytes().all(|c| c.is_ascii_uppercase())
}

/// Step 1: look the edited objects up with PDFium.
unsafe fn targets(b: &dyn PdfiumLibraryBindings, src: &[u8], edits: &[TextEdit]) -> Result<BTreeMap<u32, Vec<Target>>, String> {
    let doc = b.FPDF_LoadMemDocument64(src, None);
    if doc.is_null() {
        return Err(format!("cannot open PDF (error {})", b.FPDF_GetLastError()));
    }
    let mut by_page: BTreeMap<u32, Vec<&TextEdit>> = BTreeMap::new();
    for e in edits {
        by_page.entry(e.page).or_default().push(e);
    }
    let mut out = BTreeMap::new();
    let res = (|| -> Result<(), String> {
        for (pno, list) in by_page {
            let page = b.FPDF_LoadPage(doc, pno as c_int);
            if page.is_null() {
                return Err(format!("cannot load page {}", pno + 1));
            }
            let tp = b.FPDFText_LoadPage(page);
            let r = (|| -> Result<Vec<Target>, String> {
                let n = b.FPDFPage_CountObjects(page);
                let mut chars: HashMap<usize, HashSet<char>> = HashMap::new();
                for i in 0..n {
                    let o = b.FPDFPage_GetObject(page, i);
                    if b.FPDFPageObj_GetType(o) == FPDF_PAGEOBJ_TEXT {
                        chars.entry(b.FPDFTextObj_GetFont(o) as usize).or_default().extend(obj_text(b, o, tp).chars());
                    }
                }
                let mut v = Vec::new();
                for e in list {
                    let obj = if e.index >= 0 && e.index < n { b.FPDFPage_GetObject(page, e.index) } else { std::ptr::null_mut() };
                    if obj.is_null() || b.FPDFPageObj_GetType(obj) != FPDF_PAGEOBJ_TEXT {
                        return Err(format!("page {}: the text to edit was not found", pno + 1));
                    }
                    if obj_text(b, obj, tp).trim() != e.orig.trim() {
                        return Err(format!("page {}: the text \"{}\" changed since it was picked", pno + 1, e.orig.trim()));
                    }
                    let ord = (0..e.index).filter(|&i| b.FPDFPageObj_GetType(b.FPDFPage_GetObject(page, i)) == FPDF_PAGEOBJ_TEXT).count();
                    let font = b.FPDFTextObj_GetFont(obj);
                    let mut size = 0f32;
                    b.FPDFTextObj_GetFontSize(obj, &mut size);
                    let mut m = FS_MATRIX { a: 1.0, b: 0.0, c: 0.0, d: 1.0, e: 0.0, f: 0.0 };
                    b.FPDFPageObj_GetMatrix(obj, &mut m);
                    let (mut r, mut g, mut bl, mut a) = (0u32, 0u32, 0u32, 255u32);
                    b.FPDFPageObj_GetFillColor(obj, &mut r, &mut g, &mut bl, &mut a);
                    let (mut sr, mut sg, mut sb, mut sa) = (0u32, 0u32, 0u32, 255u32);
                    b.FPDFPageObj_GetStrokeColor(obj, &mut sr, &mut sg, &mut sb, &mut sa);
                    v.push(Target {
                        ord,
                        orig: e.orig.clone(),
                        text: e.text.clone(),
                        matrix: [m.a, m.b, m.c, m.d, m.e, m.f],
                        size: if size > 0.0 { size } else { 10.0 },
                        fill: [r, g, bl],
                        stroke: [sr, sg, sb],
                        mode: b.FPDFTextObj_GetTextRenderMode(obj) as i32,
                        standard: standard_for(b, font),
                        font_chars: chars.get(&(font as usize)).cloned().unwrap_or_default(),
                        subset: is_subset_name(&base_font_name(b, font)),
                    });
                }
                Ok(v)
            })();
            b.FPDFText_ClosePage(tp);
            b.FPDF_ClosePage(page);
            out.insert(pno, r?);
        }
        Ok(())
    })();
    b.FPDF_CloseDocument(doc);
    res.map(|_| out)
}

/// A text-showing instruction in the page's content.
struct Show {
    op: usize,
    font: Vec<u8>,
    tr: i64,
    tc: f32,
    tw: f32,
    text: Option<String>,
    /// Nothing after it relies on where its last glyph ended, so it can simply be removed.
    removable: bool,
}

/// Whether a later instruction in the same text block continues from where `ops[i]` ended.
fn continues_after(ops: &[Operation], i: usize) -> bool {
    for op in &ops[i + 1..] {
        match op.operator.as_str() {
            "ET" | "Tm" | "Td" | "TD" | "T*" | "'" | "\"" => return false,
            "Tj" | "TJ" => return true,
            _ => {}
        }
    }
    false
}

fn num(o: &Object) -> Option<f32> {
    match o {
        Object::Integer(i) => Some(*i as f32),
        Object::Real(r) => Some(*r),
        _ => None,
    }
}

fn squash(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace() && *c != '\u{fffd}').collect()
}

/// How a font's string bytes map to text.
enum Enc<'a> {
    /// lopdf's encodings: simple fonts, or a ToUnicode map.
    Lopdf(Encoding<'a>),
    /// Two-byte codes that are the Unicode values themselves (Identity-H with
    /// `/ToUnicode /Identity-H`, as some CAD exporters write).
    Ucs2,
}

/// The font's encoding, preferring its ToUnicode map (what PDFium shows as text).
fn font_encoding<'a>(doc: &'a Document, fd: &'a Dictionary, stripped: &'a Option<Dictionary>) -> Option<Enc<'a>> {
    let composite = fd.get(b"Subtype").and_then(Object::as_name).ok() == Some(b"Type0");
    if let Some(s) = stripped {
        return s.get_font_encoding(doc).ok().map(Enc::Lopdf);
    }
    if composite {
        let enc = fd.get(b"Encoding").and_then(Object::as_name).ok();
        return matches!(enc, Some(b"Identity-H") | Some(b"Identity-V")).then_some(Enc::Ucs2);
    }
    fd.get_font_encoding(doc).ok().map(Enc::Lopdf)
}

fn decode(enc: &Enc, bytes: &[u8]) -> Option<String> {
    match enc {
        Enc::Lopdf(e) => e.bytes_to_string(bytes).ok(),
        Enc::Ucs2 => {
            let units: Vec<u16> = bytes.chunks(2).map(|c| u16::from_be_bytes([c[0], *c.get(1).unwrap_or(&0)])).collect();
            Some(String::from_utf16_lossy(&units))
        }
    }
}

/// Bytes for `text` in this font, only if they decode back to exactly `text`.
fn encode(enc: &Enc, text: &str) -> Option<Vec<u8>> {
    let bytes = match enc {
        Enc::Lopdf(e) => e.string_to_bytes(text),
        Enc::Ucs2 => text.encode_utf16().flat_map(|u| u.to_be_bytes()).collect(),
    };
    (decode(enc, &bytes)? == text).then_some(bytes)
}

fn color_op(op: &str, c: [u32; 3]) -> Operation {
    Operation::new(op, c.iter().map(|&v| Object::Real(v as f32 / 255.0)).collect())
}

/// Applies the edits to the PDF in `src` and returns it with one incremental update appended.
pub unsafe fn apply(b: &dyn PdfiumLibraryBindings, src: &[u8], edits: &[TextEdit]) -> Result<Vec<u8>, String> {
    // Unchanged text is left exactly as it was (its kerning can't be reproduced by a rewrite).
    let edits: Vec<TextEdit> = edits.iter().filter(|e| e.text.trim() != e.orig.trim()).cloned().collect();
    if edits.is_empty() {
        return Ok(src.to_vec());
    }
    let by_page = targets(b, src, &edits)?;
    let prev = Document::load_mem(src).map_err(|e| format!("could not read the PDF: {e}"))?;
    let pages = prev.get_pages();
    let mut inc = IncrementalDocument::create_from(src.to_vec(), prev);
    for (pno, list) in by_page {
        let pid = *pages.get(&(pno + 1)).ok_or_else(|| format!("page {} not found", pno + 1))?;
        let (contents, resources) = edit_page(inc.get_prev_documents(), pid, pno, &list)?;
        let content_id = inc.new_document.add_object(contents);
        inc.opt_clone_object_to_new_document(pid).map_err(|e| e.to_string())?;
        let page = inc.new_document.get_dictionary_mut(pid).map_err(|e| e.to_string())?;
        page.set("Contents", Object::Reference(content_id));
        if let Some(r) = resources {
            page.set("Resources", r);
        }
    }
    let mut out = Vec::with_capacity(src.len() + (1 << 16));
    inc.save_to(&mut out).map_err(|e| format!("saving failed: {e}"))?;
    Ok(out)
}

/// The page's new content stream, and new resources if a standard font had to be added.
fn edit_page(doc: &Document, pid: ObjectId, pno: u32, list: &[Target]) -> Result<(Stream, Option<Dictionary>), String> {
    let err = |m: &str| format!("page {}: {m}", pno + 1);
    let raw = doc.get_page_content(pid);
    let mut ops = Content::decode(&raw).map_err(|e| err(&format!("cannot read the page's drawing ({e})")))?.operations;
    let fonts = doc.get_page_fonts(pid).unwrap_or_default();
    // Fonts with a ToUnicode map, minus /Encoding so lopdf uses the map.
    let stripped: HashMap<&Vec<u8>, Option<Dictionary>> = fonts
        .iter()
        .map(|(k, fd)| {
            // Only a real ToUnicode stream (some files name a CMap there instead).
            let has_map = fd.get_deref(b"ToUnicode", doc).and_then(Object::as_stream).is_ok();
            let s = has_map.then(|| {
                let mut d = (*fd).clone();
                d.remove(b"Encoding");
                d
            });
            (k, s)
        })
        .collect();
    let encs: HashMap<&Vec<u8>, Option<Enc>> = fonts.iter().map(|(k, fd)| (k, font_encoding(doc, fd, &stripped[k]))).collect();

    // Walk the content: every text-showing instruction, with the state it runs in.
    let mut shows: Vec<Show> = Vec::new();
    let (mut tr, mut tc, mut tw, mut font) = (0i64, 0f32, 0f32, Vec::new());
    let mut stack = Vec::new();
    for (i, op) in ops.iter().enumerate() {
        let a = &op.operands;
        match op.operator.as_str() {
            "q" => stack.push((tr, tc, tw, font.clone())),
            "Q" => {
                if let Some(s) = stack.pop() {
                    (tr, tc, tw, font) = s;
                }
            }
            "Tr" => tr = a.first().and_then(num).unwrap_or(0.0) as i64,
            "Tc" => tc = a.first().and_then(num).unwrap_or(0.0),
            "Tw" => tw = a.first().and_then(num).unwrap_or(0.0),
            "Tf" => {
                if let Some(Object::Name(n)) = a.first() {
                    font = n.clone();
                }
            }
            "Tj" | "'" | "\"" | "TJ" => {
                if op.operator == "\"" && a.len() == 3 {
                    tw = num(&a[0]).unwrap_or(tw);
                    tc = num(&a[1]).unwrap_or(tc);
                }
                let mut strs: Vec<&[u8]> = Vec::new();
                match a.last() {
                    Some(Object::String(s, _)) => strs.push(s),
                    Some(Object::Array(arr)) => strs.extend(arr.iter().filter_map(|o| o.as_str().ok())),
                    _ => {}
                }
                if strs.iter().all(|s| s.is_empty()) {
                    continue; // PDFium makes no object for an empty string
                }
                let text = encs.get(&font).and_then(|e| e.as_ref()).and_then(|e| {
                    let mut t = String::new();
                    for s in &strs {
                        t.push_str(&decode(e, s)?);
                    }
                    Some(t)
                });
                shows.push(Show { op: i, font: font.clone(), tr, tc, tw, text, removable: !continues_after(&ops, i) });
            }
            _ => {}
        }
    }

    // Match each target to its instruction.
    let mut picks: Vec<(usize, &Target)> = Vec::new();
    for t in list {
        let want = squash(&t.orig);
        let matches = |s: &Show| s.text.as_ref().is_some_and(|x| squash(x) == want);
        let at_ord = shows.get(t.ord).filter(|s| s.text.is_none() || matches(s));
        let si = match at_ord {
            Some(_) => t.ord,
            None => shows
                .iter()
                .enumerate()
                .filter(|(_, s)| matches(s))
                .min_by_key(|(i, _)| i.abs_diff(t.ord))
                .map(|(i, _)| i)
                .ok_or_else(|| err(&format!("could not find \"{}\" in the page's drawing", t.orig.trim())))?,
        };
        if picks.iter().any(|(p, _)| *p == si) {
            return Err(err(&format!("\"{}\" was edited twice", t.orig.trim())));
        }
        picks.push((si, t));
    }

    // New resources, only if a standard font is needed.
    let mut extra_fonts: Vec<(Vec<u8>, &'static str)> = Vec::new();
    let mut appended: Vec<Operation> = Vec::new();
    for &(si, t) in &picks {
        if t.text.trim().is_empty() {
            continue;
        }
        let s = &shows[si];
        // Same font if it can show every character (a subset font only has the glyphs used on the page).
        let own = encs.get(&s.font).and_then(|e| e.as_ref()).and_then(|e| {
            let ok = !t.subset || t.text.chars().all(|c| c == ' ' || t.font_chars.contains(&c));
            if ok { encode(e, &t.text) } else { None }
        });
        let (fname, bytes, tc, tw) = match own {
            Some(bytes) => (s.font.clone(), bytes, s.tc, s.tw),
            None => {
                let name = match extra_fonts.iter().find(|(_, base)| *base == t.standard) {
                    Some((n, _)) => n.clone(),
                    None => {
                        let n = (0..).map(|i| format!("EPPF{i}").into_bytes()).find(|n| !fonts.contains_key(n) && !extra_fonts.iter().any(|(e, _)| e == n)).unwrap();
                        extra_fonts.push((n.clone(), t.standard));
                        n
                    }
                };
                (name, Encoding::SimpleEncoding(b"WinAnsiEncoding").string_to_bytes(&t.text), 0.0, 0.0)
            }
        };
        let m = t.matrix;
        appended.extend([
            Operation::new("q", vec![]),
            color_op("rg", t.fill),
            color_op("RG", t.stroke),
            Operation::new("BT", vec![]),
            Operation::new("Tf", vec![Object::Name(fname), Object::Real(t.size)]),
            Operation::new("Tc", vec![Object::Real(tc)]),
            Operation::new("Tw", vec![Object::Real(tw)]),
            Operation::new("Tr", vec![Object::Integer(t.mode.clamp(0, 7) as i64)]),
            Operation::new("Tm", m.iter().map(|&v| Object::Real(v)).collect()),
            Operation::new("Tj", vec![Object::String(bytes, StringFormat::Hexadecimal)]),
            Operation::new("ET", vec![]),
            Operation::new("Q", vec![]),
        ]);
    }

    // Remove the original instructions (or make them invisible when later text continues from
    // where they ended); later ones first so indices stay valid.
    let mut hide: Vec<&Show> = picks.iter().map(|&(si, _)| &shows[si]).collect();
    hide.sort_by(|a, b| b.op.cmp(&a.op));
    for s in hide {
        let op = s.op;
        if s.removable {
            // ' and " also start a new line; keep that part.
            let keep: Vec<Operation> = match ops[op].operator.as_str() {
                "'" => vec![Operation::new("T*", vec![])],
                "\"" => {
                    let a = &ops[op].operands;
                    vec![Operation::new("Tw", vec![a[0].clone()]), Operation::new("Tc", vec![a[1].clone()]), Operation::new("T*", vec![])]
                }
                _ => vec![],
            };
            ops.splice(op..=op, keep);
        } else {
            ops.insert(op + 1, Operation::new("Tr", vec![Object::Integer(s.tr)]));
            ops.insert(op, Operation::new("Tr", vec![Object::Integer(if s.tr >= 4 { 7 } else { 3 })]));
        }
    }

    let mut data = b"q\n".to_vec();
    data.extend(Content { operations: ops }.encode().map_err(|e| err(&format!("cannot write the page ({e})")))?);
    data.extend(b"\nQ\n");
    if !appended.is_empty() {
        data.extend(Content { operations: appended }.encode().map_err(|e| err(&e.to_string()))?);
    }
    let mut stream = Stream::new(dictionary! {}, data);
    let _ = stream.compress();

    let resources = if extra_fonts.is_empty() {
        None
    } else {
        Some(resources_with(doc, pid, &extra_fonts))
    };
    Ok((stream, resources))
}

/// The page's resources (possibly inherited) as a direct dictionary, plus the standard fonts.
fn resources_with(doc: &Document, pid: ObjectId, extra: &[(Vec<u8>, &'static str)]) -> Dictionary {
    let mut node = doc.get_dictionary(pid).ok();
    let mut res = Dictionary::new();
    let mut seen = 0;
    while let Some(d) = node {
        if let Ok(r) = d.get(b"Resources") {
            res = match r {
                Object::Reference(id) => doc.get_dictionary(*id).cloned().unwrap_or_default(),
                Object::Dictionary(x) => x.clone(),
                _ => Dictionary::new(),
            };
            break;
        }
        seen += 1;
        node = if seen < 64 { d.get(b"Parent").and_then(Object::as_reference).ok().and_then(|p| doc.get_dictionary(p).ok()) } else { None };
    }
    let mut fonts = match res.get(b"Font") {
        Ok(Object::Reference(id)) => doc.get_dictionary(*id).cloned().unwrap_or_default(),
        Ok(Object::Dictionary(x)) => x.clone(),
        _ => Dictionary::new(),
    };
    for (name, base) in extra {
        fonts.set(
            name.clone(),
            dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => Object::Name(base.as_bytes().to_vec()), "Encoding" => "WinAnsiEncoding" },
        );
    }
    res.set("Font", fonts);
    res
}
