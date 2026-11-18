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
            let score = r.h * (1.0 + 2.0 * xf * xf + 2.0 * yf * yf);
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
    fn sheet_numbers() {
        for ok in ["S-208", "S-20A", "A1.01", "S0.1", "G-1", "E101", "S-001", "SK-3", "A 101"] {
            assert!(is_sheet_number(ok), "{ok}");
        }
        for bad in ["S", "208", "BEAM", "s-1", "ABCD-1", "S-12345", "1/8", "A-A"] {
            assert!(!is_sheet_number(bad), "{bad}");
        }
    }
}
