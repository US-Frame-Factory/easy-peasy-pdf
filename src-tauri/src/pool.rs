//! Pool of `--render-worker` processes with priority queues.
//!
//! * interactive (info / find / extract) are served first, FIFO;
//! * tiles next, LIFO (the newest request is what's on screen). The queue is
//!   capped; the oldest requests are failed as "stale" and the frontend
//!   re-requests them if they're still visible;
//! * background text indexing last, and never on every worker at once.
//!
//! A worker that dies or runs a job past the timeout is killed and respawned;
//! the job is retried once, then failed. The app process never goes down.

use crate::protocol::{read_frame, Request};
use std::collections::VecDeque;
use std::io::{BufReader, BufWriter, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

pub const JOB_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_TILE_QUEUE: usize = 64;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Prio {
    Interactive,
    Tile,
    Background,
}

pub struct Reply {
    pub data: serde_json::Value,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobError {
    /// Dropped from the tile queue to make room for newer requests.
    Stale,
    Cancelled,
    Failed(String),
}

impl std::fmt::Display for JobError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            JobError::Stale => write!(f, "stale"),
            JobError::Cancelled => write!(f, "cancelled"),
            JobError::Failed(e) => write!(f, "{e}"),
        }
    }
}

pub type JobResult = Result<Reply, JobError>;

struct Job {
    req: Request,
    prio: Prio,
    retried: bool,
    cancel: Option<Arc<AtomicBool>>,
    reply: oneshot::Sender<JobResult>,
}

#[derive(Default)]
struct Queues {
    interactive: VecDeque<Job>,
    tiles: VecDeque<Job>,
    background: VecDeque<Job>,
    background_running: usize,
}

struct Slot {
    child: Mutex<Option<Child>>,
    started: Mutex<Option<Instant>>,
}

pub struct Pool {
    queues: Mutex<Queues>,
    cv: Condvar,
    exe: PathBuf,
    pdfium: PathBuf,
    slots: Vec<Slot>,
    max_background: usize,
}

pub fn default_worker_count() -> usize {
    let cores = thread::available_parallelism().map(|n| n.get()).unwrap_or(2);
    (cores.saturating_sub(1)).clamp(1, 4)
}

impl Pool {
    pub fn start(exe: PathBuf, pdfium: PathBuf, workers: usize) -> Arc<Pool> {
        let workers = workers.max(1);
        let pool = Arc::new(Pool {
            queues: Mutex::new(Queues::default()),
            cv: Condvar::new(),
            exe,
            pdfium,
            slots: (0..workers)
                .map(|_| Slot { child: Mutex::new(None), started: Mutex::new(None) })
                .collect(),
            max_background: if workers > 1 { workers - 1 } else { 1 },
        });
        for i in 0..workers {
            let p = pool.clone();
            thread::Builder::new()
                .name(format!("render-slot-{i}"))
                .spawn(move || p.slot_loop(i))
                .expect("spawn slot thread");
        }
        let p = pool.clone();
        thread::Builder::new()
            .name("render-watchdog".into())
            .spawn(move || p.watchdog())
            .expect("spawn watchdog");
        pool
    }

    pub fn workers(&self) -> usize {
        self.slots.len()
    }

    /// Queue a request; await the returned receiver for the result.
    pub fn submit(
        &self,
        req: Request,
        prio: Prio,
        cancel: Option<Arc<AtomicBool>>,
    ) -> oneshot::Receiver<JobResult> {
        let (tx, rx) = oneshot::channel();
        self.push(Job { req, prio, retried: false, cancel, reply: tx }, false);
        rx
    }

    pub async fn run(&self, req: Request, prio: Prio) -> JobResult {
        self.submit(req, prio, None)
            .await
            .unwrap_or(Err(JobError::Failed("render pool dropped the job".into())))
    }

    fn push(&self, job: Job, front: bool) {
        let mut q = self.queues.lock().unwrap();
        match job.prio {
            Prio::Interactive => {
                if front {
                    q.interactive.push_front(job)
                } else {
                    q.interactive.push_back(job)
                }
            }
            Prio::Tile => {
                q.tiles.push_back(job);
                while q.tiles.len() > MAX_TILE_QUEUE {
                    if let Some(old) = q.tiles.pop_front() {
                        let _ = old.reply.send(Err(JobError::Stale));
                    }
                }
            }
            Prio::Background => {
                if front {
                    q.background.push_front(job)
                } else {
                    q.background.push_back(job)
                }
            }
        }
        drop(q);
        self.cv.notify_one();
    }

    fn next_job(&self) -> Job {
        let mut q = self.queues.lock().unwrap();
        loop {
            if let Some(j) = q.interactive.pop_front() {
                return j;
            }
            if let Some(j) = q.tiles.pop_back() {
                return j;
            }
            if q.background_running < self.max_background {
                if let Some(j) = q.background.pop_front() {
                    q.background_running += 1;
                    return j;
                }
            }
            q = self.cv.wait(q).unwrap();
        }
    }

    fn finish_background(&self) {
        let mut q = self.queues.lock().unwrap();
        q.background_running = q.background_running.saturating_sub(1);
        drop(q);
        self.cv.notify_all();
    }

    fn spawn_worker(&self, idx: usize) -> std::io::Result<(BufWriter<ChildStdin>, BufReader<ChildStdout>)> {
        let mut cmd = Command::new(&self.exe);
        cmd.arg("--render-worker")
            .arg("--pdfium")
            .arg(&self.pdfium)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn()?;
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        *self.slots[idx].child.lock().unwrap() = Some(child);
        Ok((BufWriter::new(stdin), BufReader::with_capacity(1 << 20, stdout)))
    }

    fn kill_worker(&self, idx: usize) {
        if let Some(mut c) = self.slots[idx].child.lock().unwrap().take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }

    fn slot_loop(self: Arc<Self>, idx: usize) {
        let mut io: Option<(BufWriter<ChildStdin>, BufReader<ChildStdout>)> = None;
        loop {
            let mut job = self.next_job();
            let is_bg = job.prio == Prio::Background;
            if job.cancel.as_ref().is_some_and(|c| c.load(Ordering::Relaxed)) || job.reply.is_closed() {
                let _ = job.reply.send(Err(JobError::Cancelled));
                if is_bg {
                    self.finish_background();
                }
                continue;
            }
            if io.is_none() {
                match self.spawn_worker(idx) {
                    Ok(x) => io = Some(x),
                    Err(e) => {
                        let _ = job.reply.send(Err(JobError::Failed(format!("cannot start render worker: {e}"))));
                        if is_bg {
                            self.finish_background();
                        }
                        thread::sleep(Duration::from_millis(500));
                        continue;
                    }
                }
            }
            let (w, r) = io.as_mut().unwrap();
            *self.slots[idx].started.lock().unwrap() = Some(Instant::now());
            let res = (|| -> std::io::Result<(crate::protocol::Header, Vec<u8>)> {
                let line = serde_json::to_string(&job.req).map_err(std::io::Error::other)?;
                w.write_all(line.as_bytes())?;
                w.write_all(b"\n")?;
                w.flush()?;
                read_frame(r)
            })();
            let timed_out = self.slots[idx].started.lock().unwrap().take().is_none();
            if is_bg {
                self.finish_background();
            }
            match res {
                Ok((h, body)) if h.ok => {
                    let _ = job.reply.send(Ok(Reply { data: h.data, body }));
                }
                Ok((h, _)) => {
                    let _ = job.reply.send(Err(JobError::Failed(h.error.unwrap_or_else(|| "unknown error".into()))));
                }
                Err(e) => {
                    // Worker crashed, hung (killed by the watchdog) or the pipe broke.
                    self.kill_worker(idx);
                    io = None;
                    let why = if timed_out { "timed out".to_string() } else { format!("crashed ({e})") };
                    eprintln!("[pool] worker {idx} {why} on {:?}", short(&job.req));
                    if !job.retried && !matches!(job.req, Request::Crash) {
                        job.retried = true;
                        let front = job.prio != Prio::Tile;
                        self.push(job, front);
                    } else {
                        let _ = job.reply.send(Err(JobError::Failed(format!("render worker {why}"))));
                    }
                }
            }
        }
    }

    fn watchdog(self: Arc<Self>) {
        loop {
            thread::sleep(Duration::from_secs(1));
            for (i, slot) in self.slots.iter().enumerate() {
                let mut started = slot.started.lock().unwrap();
                if started.is_some_and(|t| t.elapsed() > JOB_TIMEOUT) {
                    // Clearing `started` marks this as a timeout for the slot thread.
                    *started = None;
                    drop(started);
                    eprintln!("[pool] worker {i} exceeded {JOB_TIMEOUT:?}; killing it");
                    if let Some(c) = slot.child.lock().unwrap().as_mut() {
                        let _ = c.kill();
                    }
                }
            }
        }
    }
}

fn short(req: &Request) -> String {
    match req {
        Request::Info { path } => format!("info {path}"),
        Request::Tile { path, page, scale, tx, ty } => format!("tile {path} p{} s{scale:.3} {tx},{ty}", page + 1),
        Request::Text { path, page } => format!("text {path} p{}", page + 1),
        Request::Find { path, page, .. } => format!("find {path} p{}", page + 1),
        Request::Extract { path, .. } => format!("extract {path}"),
        Request::SelectText { path, page, .. } => format!("select {path} p{}", page + 1),
        Request::Region { path, page, .. } => format!("region {path} p{}", page + 1),
        Request::Crash => "crash".into(),
    }
}
