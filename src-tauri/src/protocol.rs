//! Wire protocol between the app process and `--render-worker` processes.
//!
//! Requests: one JSON object per line on the worker's stdin.
//! Responses on the worker's stdout, one frame per request:
//!   u32 LE header length | JSON header | u32 LE body length | body bytes

use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "op")]
pub enum Request {
    /// Page sizes in points (rotation applied).
    Info { path: String },
    /// One tile of a page rendered at `scale` px/pt. Body = 32-bit BMP.
    Tile { path: String, page: u32, scale: f64, tx: u32, ty: u32 },
    /// Plain text of a page. Body = UTF-8 text.
    Text { path: String, page: u32 },
    /// Match rectangles for `query` on a page, top-left-origin points: [x, y, w, h].
    Find { path: String, page: u32, query: String },
    /// Copy pages (0-based) into a new PDF at `dest`.
    Extract { path: String, pages: Vec<u32>, dest: String },
    /// Test hook: makes the worker abort, to exercise crash recovery.
    Crash,
}

#[derive(Serialize, Deserialize, Debug, Default)]
pub struct Header {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub data: serde_json::Value,
}

pub const TILE: u32 = 512;
pub const MAX_FRAME: usize = 512 * 1024 * 1024;

pub fn write_frame(w: &mut impl Write, header: &Header, body: &[u8]) -> io::Result<()> {
    let h = serde_json::to_vec(header).map_err(io::Error::other)?;
    w.write_all(&(h.len() as u32).to_le_bytes())?;
    w.write_all(&h)?;
    w.write_all(&(body.len() as u32).to_le_bytes())?;
    w.write_all(body)?;
    w.flush()
}

fn read_chunk(r: &mut impl Read) -> io::Result<Vec<u8>> {
    let mut len = [0u8; 4];
    r.read_exact(&mut len)?;
    let len = u32::from_le_bytes(len) as usize;
    if len > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "frame too large"));
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf)?;
    Ok(buf)
}

pub fn read_frame(r: &mut impl Read) -> io::Result<(Header, Vec<u8>)> {
    let h = read_chunk(r)?;
    let header: Header =
        serde_json::from_slice(&h).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let body = read_chunk(r)?;
    Ok((header, body))
}

/// Pixel size of a page at a given scale, and of tile (tx, ty) within it.
pub fn tile_geometry(page_w: f64, page_h: f64, scale: f64, tx: u32, ty: u32) -> Option<(i32, i32, i32, i32)> {
    let w = (page_w * scale).round().max(1.0) as i64;
    let h = (page_h * scale).round().max(1.0) as i64;
    let x0 = tx as i64 * TILE as i64;
    let y0 = ty as i64 * TILE as i64;
    if x0 >= w || y0 >= h || w > i32::MAX as i64 || h > i32::MAX as i64 {
        return None;
    }
    let tw = (w - x0).min(TILE as i64);
    let th = (h - y0).min(TILE as i64);
    Some((w as i32, h as i32, tw as i32, th as i32))
}

/// Wraps top-down BGRA pixels in an uncompressed 32-bit BMP (no encode cost).
pub fn bmp_from_bgra(width: u32, height: u32, stride: usize, pixels: &[u8]) -> Vec<u8> {
    let row = width as usize * 4;
    let data_len = row * height as usize;
    let mut out = Vec::with_capacity(54 + data_len);
    // BITMAPFILEHEADER
    out.extend_from_slice(b"BM");
    out.extend_from_slice(&((54 + data_len) as u32).to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&54u32.to_le_bytes());
    // BITMAPINFOHEADER
    out.extend_from_slice(&40u32.to_le_bytes());
    out.extend_from_slice(&(width as i32).to_le_bytes());
    out.extend_from_slice(&(-(height as i32)).to_le_bytes()); // negative = top-down
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&32u16.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes()); // BI_RGB
    out.extend_from_slice(&(data_len as u32).to_le_bytes());
    out.extend_from_slice(&2835i32.to_le_bytes());
    out.extend_from_slice(&2835i32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    if stride == row {
        out.extend_from_slice(&pixels[..data_len.min(pixels.len())]);
    } else {
        for y in 0..height as usize {
            let s = y * stride;
            out.extend_from_slice(&pixels[s..s + row]);
        }
    }
    out
}
