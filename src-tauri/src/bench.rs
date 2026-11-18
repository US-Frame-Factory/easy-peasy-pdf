//! Headless benchmark of the render pipeline (same pool + worker processes as the app).
//! `easy-peasy-pdf --bench <file.pdf> [workers]`

use crate::pool::{default_worker_count, Pool, Prio};
use crate::protocol::{Request, TILE};
use std::time::Instant;

pub fn run(args: &[String]) -> i32 {
    let Some(file) = args.first() else {
        eprintln!("usage: --bench <file.pdf> [workers]");
        return 2;
    };
    let path = std::fs::canonicalize(file).map(|p| p.to_string_lossy().to_string()).unwrap_or(file.clone());
    let workers = args.get(1).and_then(|s| s.parse().ok()).unwrap_or_else(default_worker_count);
    let pdfium = crate::find_pdfium(None);
    let exe = std::env::current_exe().expect("exe");
    let pool = Pool::start(exe, pdfium, workers);
    println!("file: {path}\nworkers: {workers}");

    tauri::async_runtime::block_on(async move {
        let ms = |t: Instant| format!("{:>8.1} ms", t.elapsed().as_secs_f64() * 1000.0);

        let t = Instant::now();
        let info = match pool.run(Request::Info { path: path.clone() }, Prio::Interactive).await {
            Ok(r) => r,
            Err(e) => {
                eprintln!("open failed: {e}");
                return 1;
            }
        };
        let pages: Vec<(f64, f64)> = info.data["pages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| (p[0].as_f64().unwrap(), p[1].as_f64().unwrap()))
            .collect();
        println!("open + page sizes ({} pages, p1 {:.0}x{:.0} pt): {}", pages.len(), pages[0].0, pages[0].1, ms(t));

        // First page at "fit width" in a 1600 px viewport.
        let (w, h) = pages[0];
        let scale = 2f64.powf(((1600.0 / w).log2() * 2.0).ceil() / 2.0);
        let scale = (scale * 1000.0).round() / 1000.0;
        let (nx, ny) = (((w * scale) / TILE as f64).ceil() as u32, ((h * scale) / TILE as f64).ceil() as u32);
        let t = Instant::now();
        let mut rxs = Vec::new();
        for ty in 0..ny {
            for tx in 0..nx {
                rxs.push(pool.submit(Request::Tile { path: path.clone(), page: 0, scale, tx, ty }, Prio::Tile, None));
            }
        }
        let mut first = None;
        let mut bytes = 0;
        for rx in rxs {
            let r = rx.await.unwrap().expect("tile");
            bytes += r.body.len();
            first.get_or_insert_with(|| ms(t));
        }
        println!(
            "page 1 fit-width, {} tiles @ {scale} px/pt: first {} / all {}  ({:.1} MB BMP)",
            nx * ny,
            first.unwrap(),
            ms(t),
            bytes as f64 / 1e6
        );

        // Deep zoom: one tile in the middle of page 1 at 8 px/pt.
        let t = Instant::now();
        let s = 8.0;
        let (tx, ty) = (((w * s) / 2.0 / TILE as f64) as u32, ((h * s) / 2.0 / TILE as f64) as u32);
        pool.run(Request::Tile { path: path.clone(), page: 0, scale: s, tx, ty }, Prio::Tile).await.expect("tile");
        println!("page 1 deep-zoom tile @ 8 px/pt:                 {}", ms(t));

        // Low-res placeholder of every page (what the grid view shows), in screen-sized
        // batches like the viewer asks for them (the tile queue drops >64 as stale).
        let t = Instant::now();
        let mut failed = 0;
        for chunk in pages.iter().enumerate().collect::<Vec<_>>().chunks(24) {
            let rxs: Vec<_> = chunk
                .iter()
                .map(|(i, (w, h))| {
                    let s = ((TILE as f64 / w).min(TILE as f64 / h) * 1000.0).floor() / 1000.0;
                    pool.submit(Request::Tile { path: path.clone(), page: *i as u32, scale: s, tx: 0, ty: 0 }, Prio::Tile, None)
                })
                .collect();
            for rx in rxs {
                if !matches!(rx.await, Ok(Ok(_))) {
                    failed += 1;
                }
            }
        }
        println!("placeholders, all {} pages:                       {}  ({failed} failed)", pages.len(), ms(t));

        // Background text extraction of every page.
        let t = Instant::now();
        let rxs: Vec<_> = (0..pages.len())
            .map(|i| pool.submit(Request::Text { path: path.clone(), page: i as u32 }, Prio::Background, None))
            .collect();
        let mut chars = 0;
        for rx in rxs {
            if let Ok(Ok(r)) = rx.await {
                chars += r.body.len();
                if std::env::var_os("EPP_LABELS").is_some() {
                    println!("  sheet {:?} title {:?} label {:?}", r.data["sheet"], r.data["title"], r.data["label"]);
                }
            }
        }
        println!("text index, all pages ({:.1} KB):                   {}", chars as f64 / 1e3, ms(t));

        let t = Instant::now();
        let r = pool
            .run(Request::Find { path: path.clone(), page: 0, query: "the".into() }, Prio::Interactive)
            .await
            .expect("find");
        println!(
            "find \"the\" on page 1 ({} hits):                   {}",
            r.data["matches"].as_array().map(|a| a.len()).unwrap_or(0),
            ms(t)
        );

        let dest = std::env::temp_dir().join("epp-bench-extract.pdf");
        let t = Instant::now();
        let n = pages.len().min(3) as u32;
        pool.run(
            Request::Extract { path: path.clone(), pages: (0..n).collect(), dest: dest.to_string_lossy().to_string() },
            Prio::Interactive,
        )
        .await
        .expect("extract");
        let size = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
        println!("extract {n} pages -> {} ({:.1} MB):  {}", dest.display(), size as f64 / 1e6, ms(t));

        // Crash recovery: kill a worker mid-flight and make sure work still completes.
        let t = Instant::now();
        let _ = pool.run(Request::Crash, Prio::Interactive).await;
        let ok = pool.run(Request::Tile { path: path.clone(), page: 0, scale: 0.1, tx: 0, ty: 0 }, Prio::Tile).await.is_ok();
        println!("crash a worker, then render again: ok={ok}       {}", ms(t));
        0
    })
}
