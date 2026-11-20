//! Sheet names for plan sets: the sheet number (e.g. "S-208") and title
//! (e.g. "BUILDING SECTION 1") read from the title block.
//!
//! Most plan PDFs carry no page labels or bookmarks, so we look at the text:
//! the sheet number is the largest sheet-number-shaped text near the
//! bottom-right of the page (where title blocks live).

/// A run of text on the page in top-left-origin display points.
pub struct Run {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

/// "S-208", "S-20A", "A1.01", "S0.1", "G-1", "E101", "S-001", "SK-3".
pub fn is_sheet_number(s: &str) -> bool {
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() && b[i].is_ascii_uppercase() {
        i += 1;
    }
    if i == 0 || i > 3 {
        return false;
    }
    if i < b.len() && matches!(b[i], b'-' | b'.' | b' ') {
        i += 1;
    }
    let d0 = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    if i == d0 || i - d0 > 4 {
        return false;
    }
    if i < b.len() && b[i] == b'.' {
        i += 1;
        let d1 = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == d1 || i - d1 > 3 {
            return false;
        }
    }
    if i < b.len() && b[i].is_ascii_uppercase() {
        i += 1;
    }
    i == b.len()
}

const BOILERPLATE: &[&str] = &[
    "SHEET", "SCALE", "DATE", "DRAWN", "CHECK", "PROJECT", "LLC", "INC", "PHONE", "FAX", "NOTE",
    "REVISION", "ISSUE", "SEAL", "CLIENT", "JOB", "NO.", "ENGINEER", "ARCHITECT", "COPYRIGHT",
    "CONSTRUCTION", "WWW", "@", "SUITE", "STREET", " DR", "AVE", "ROAD", "USA", "TITLE", "DESCRIPTION",
    "APPROVED", "REVIEWED", "PRELIMINARY", "NOT FOR", "FOR CONSTRUCTION",
];

fn is_title_like(s: &str) -> bool {
    let letters = s.chars().filter(|c| c.is_alphabetic()).count();
    let n = s.chars().count();
    if !(4..=60).contains(&n) || letters * 2 < n {
        return false;
    }
    // Plan titles are upper case.
    if s.chars().any(|c| c.is_lowercase()) {
        return false;
    }
    let up = s.to_uppercase();
    if BOILERPLATE.iter().any(|w| up.contains(w)) {
        return false;
    }
    // A scale like 1/8"=1'-0" is not a title.
    !(s.contains('"') || s.contains('='))
}

/// The sheet number only (what the app shows).
pub fn sheet_number(runs: &[Run], pw: f32, ph: f32) -> Option<String> {
    let mut best: Option<(f32, String)> = None;
    for r in runs {
        let xf = (r.x + r.w / 2.0) / pw;
        let yf = (r.y + r.h / 2.0) / ph;
        if xf < 0.5 || yf < 0.5 {
            continue;
        }
        for tok in r.text.split(|c: char| c.is_whitespace() || c == ':' || c == '#') {
            let tok = tok.trim_matches(|c: char| c == ',' || c == ';' || c == '(' || c == ')');
            if is_sheet_number(tok) {
                let score = r.w.min(r.h) * (1.0 + 2.0 * xf * xf + 2.0 * yf * yf);
                if best.as_ref().is_none_or(|(s, _)| score > *s) {
                    best = Some((score, tok.to_string()));
                }
            }
        }
    }
    best.map(|(_, n)| n)
}

fn clean(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").trim_matches(|c: char| c == ':' || c == '-' || c == ' ').to_string()
}

/// If `text` is a drawing-title label ("DWG TITLE", "Drawing Title:", "SHEET TITLE", …),
/// returns whatever follows it on the same run (often empty).
pub fn title_label_rest(text: &str) -> Option<String> {
    let t = clean(text).to_uppercase();
    for bad in ["PROJECT", "JOB", "CLIENT", "OWNER", "CONTRACT"] {
        if t.starts_with(bad) {
            return None;
        }
    }
    for lbl in ["DWG. TITLE", "DWG TITLE", "DRAWING TITLE", "SHEET TITLE", "SHEET NAME", "DRAWING NAME", "PLAN TITLE", "TITLE"] {
        if let Some(rest) = t.strip_prefix(lbl) {
            if rest.is_empty() || rest.starts_with(':') || rest.starts_with(' ') {
                if rest.trim_start_matches([':', ' ']).starts_with(|c: char| c.is_ascii_digit()) {
                    return None; // "TITLE 24 ..." (energy code notes), not a label
                }
                // Keep the original casing of the remainder.
                let orig = clean(text);
                return Some(clean(&orig[orig.len() - rest.len()..]));
            }
        }
    }
    None
}

fn looks_like_label(s: &str) -> bool {
    let u = s.trim().to_uppercase();
    u.ends_with(':')
        || ["DRAWN", "DESIGNED", "CHECKED", "SCALE", "DATE", "PROJECT", "JOB", "SHEET NO", "SHEET NUMBER", "REVISION", "DRAWING NO", "DWG NO", "APPROVED", "ISSUE"]
            .iter()
            .any(|w| u.starts_with(w))
}

/// Sheet title from a title label and the text runs below it (display points).
pub fn title_from(label: &Run, below: &[Run]) -> Option<String> {
    if let Some(rest) = title_label_rest(&label.text) {
        if rest.chars().filter(|c| c.is_alphabetic()).count() >= 3 {
            return Some(rest);
        }
    } else {
        return None;
    }
    let lh = label.w.min(label.h);
    // Group runs into lines (top to bottom), each line ordered left to right.
    let mut runs: Vec<&Run> = below.iter().filter(|r| !clean(&r.text).is_empty()).collect();
    runs.sort_by(|a, b| a.y.total_cmp(&b.y));
    let mut lines: Vec<Vec<&Run>> = Vec::new();
    for r in runs {
        let size = r.w.min(r.h);
        match lines.last_mut() {
            Some(line) if (line[0].y + line[0].h / 2.0 - (r.y + r.h / 2.0)).abs() < size * 0.5 => line.push(r),
            _ => lines.push(vec![r]),
        }
    }
    let mut out: Vec<String> = Vec::new();
    let mut prev_bottom = label.y + label.h;
    let mut first_size = 0.0f32;
    for mut line in lines {
        line.sort_by(|a, b| a.x.total_cmp(&b.x));
        let size = line.iter().map(|r| r.w.min(r.h)).fold(0.0, f32::max);
        let top = line.iter().map(|r| r.y).fold(f32::MAX, f32::min);
        // Lone one-character runs next to real text are markers (revision deltas, grid tags).
        let alnum = |r: &&Run| r.text.chars().filter(|c| c.is_alphanumeric()).count();
        if line.iter().any(|r| alnum(r) >= 3) {
            line.retain(|r| alnum(r) > 1 || r.text.trim() == "&");
        }
        let text = clean(&line.iter().map(|r| clean(&r.text)).collect::<Vec<_>>().join(" "));
        if text.chars().filter(|c| c.is_alphanumeric()).count() <= 2 {
            continue; // revision triangles, detail bubbles ("A", "1")
        }
        let gap = top - prev_bottom;
        if out.is_empty() {
            if gap > lh * 3.0 || looks_like_label(&text) {
                return None;
            }
            first_size = size;
        } else if gap > first_size * 0.9 || size < first_size * 0.8 || size <= lh * 1.02 || looks_like_label(&text) {
            break;
        }
        out.push(text);
        prev_bottom = line.iter().map(|r| r.y + r.h).fold(0.0, f32::max);
        if out.len() == 6 {
            break;
        }
    }
    let t = clean(&out.join(" "));
    (t.chars().filter(|c| c.is_alphabetic()).count() >= 2).then_some(t.chars().take(100).collect())
}

/// Returns (sheet number, sheet title) for a page of size `pw` x `ph` points.
pub fn detect(runs: &[Run], pw: f32, ph: f32) -> (Option<String>, Option<String>) {
    // Sheet number: biggest candidate, biased toward the bottom-right corner.
    let mut best: Option<(f32, &Run, String)> = None;
    for r in runs {
        let xf = (r.x + r.w / 2.0) / pw;
        let yf = (r.y + r.h / 2.0) / ph;
        if xf < 0.5 || yf < 0.5 {
            continue;
        }
        for tok in r.text.split(|c: char| c.is_whitespace() || c == ':' || c == '#') {
            let tok = tok.trim_matches(|c: char| c == ',' || c == ';' || c == '(' || c == ')');
            if !is_sheet_number(tok) {
                continue;
            }
            let score = r.w.min(r.h) * (1.0 + 2.0 * xf * xf + 2.0 * yf * yf);
            if best.as_ref().is_none_or(|(s, _, _)| score > *s) {
                best = Some((score, r, tok.to_string()));
            }
        }
    }
    let Some((_, num_run, number)) = best else { return (None, None) };

    // Title: largest title-like text in the title block near the number.
    let (nx, ny) = (num_run.x + num_run.w / 2.0, num_run.y + num_run.h / 2.0);
    let reach = pw.max(ph) * 0.22;
    let mut title: Option<(f32, String)> = None;
    for r in runs {
        if std::ptr::eq(r, num_run) {
            continue;
        }
        let t = r.text.split_whitespace().collect::<Vec<_>>().join(" ");
        let (cx, cy) = (r.x + r.w / 2.0, r.y + r.h / 2.0);
        let dist = ((cx - nx).powi(2) + (cy - ny).powi(2)).sqrt();
        if dist > reach || cy / ph < 0.6 || cx / pw < 0.45 || !is_title_like(&t) {
            continue;
        }
        let score = r.h * 10.0 - dist * 0.02;
        if title.as_ref().is_none_or(|(s, _)| score > *s) {
            title = Some((score, t));
        }
    }
    (Some(number), title.map(|(_, t)| t))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vertical_note_does_not_beat_title_block() {
        let run = |text: &str, x, y, w, h| Run { text: text.into(), x, y, w, h };
        let runs = [
            // A note running up the page: tall box, thin text.
            run("MATCH LINE A-A SEE PARTIAL PLAN ON SHEET S-2B", 1450.0, 830.0, 10.0, 393.0),
            run("S-2A", 2370.0, 1600.0, 45.0, 18.6),
        ];
        assert_eq!(sheet_number(&runs, 2592.0, 1728.0).as_deref(), Some("S-2A"));
    }
    #[test]
    fn titles() {
        let run = |text: &str, x, y, w, h| Run { text: text.into(), x, y, w, h };
        // Thomas Manor: label, title below.
        let label = run("DWG TITLE ", 837.0, 1607.0, 72.0, 11.1);
        let below = [run("GENERAL LAYOUT ", 837.0, 1626.0, 155.0, 14.9)];
        assert_eq!(title_from(&label, &below).as_deref(), Some("GENERAL LAYOUT"));
        // HVAC set: three lines, then the next (smaller) label.
        let label = run("Drawing Title", 2706.0, 1834.0, 54.0, 8.9);
        let below = [
            run("MECHANICAL", 2706.0, 1851.0, 160.0, 18.4),
            run("LEGEND, SCHEDULES", 2706.0, 1879.0, 266.0, 21.7),
            run("& NOTES", 2706.0, 1907.0, 106.0, 18.6),
            run("Designed", 2706.0, 1959.0, 39.0, 8.9),
        ];
        assert_eq!(title_from(&label, &below).as_deref(), Some("MECHANICAL LEGEND, SCHEDULES & NOTES"));
        // Thomas Manor two-line title: first line on the label's row.
        let label = run("DWG TITLE", 837.0, 1617.0, 72.0, 11.1);
        let below = [
            run("FIRST FLOOR ANCHOR SCREW", 923.0, 1615.0, 260.0, 14.9),
            run("A", 1190.0, 1630.0, 8.0, 14.9),
            run("& HOLDOWN LOCATION PLAN", 837.0, 1640.0, 250.0, 14.9),
        ];
        assert_eq!(title_from(&label, &below).as_deref(), Some("FIRST FLOOR ANCHOR SCREW & HOLDOWN LOCATION PLAN"));
        // Same-line title and non-title labels.
        assert_eq!(title_label_rest("SHEET TITLE: FOUNDATION PLAN").as_deref(), Some("FOUNDATION PLAN"));
        assert_eq!(title_label_rest("Project Title"), None);
        assert_eq!(title_label_rest("TITLE 24 COMPLIANCE"), None);
    }

    #[test]
    fn sheet_numbers() {
        for ok in ["S-208", "S-20A", "A1.01", "S0.1", "G-1", "E101", "S-001", "SK-3", "A 101"] {
            assert!(is_sheet_number(ok), "{ok}");
        }
        for bad in ["S", "208", "BEAM", "s-1", "ABCD-1", "S-12345", "1/8", "A-A"] {
            assert!(!is_sheet_number(bad), "{bad}");
        }
    }
}
