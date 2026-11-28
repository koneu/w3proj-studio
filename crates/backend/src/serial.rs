//! One job at a time, in the order the jobs were handed in, on a thread of its own: the app's commands that used to
//! run on its main thread (which ran them one after another as they came) and write or check project files
//! (`codec_write`, `codec_canonicalize`, `objects_canonicalize`, `project_create`) run here, so the window keeps
//! answering while they encode, and they still start and end in the order they were asked for.

use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};

type Job = Box<dyn FnOnce() + Send>;

#[derive(Default)]
struct State {
    queue: VecDeque<Job>,
    running: bool,
    closed: bool,
}

#[derive(Default)]
struct Inner {
    state: Mutex<State>,
    /// A job was queued, or the runner was closed.
    work: Condvar,
    /// The runner has nothing left to run.
    idle: Condvar,
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State> {
        // A job runs outside the lock: nothing panics while holding it, and a poisoned lock still holds a sound state.
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// The runner (see the module). Clones hand jobs to the same thread.
#[derive(Clone)]
pub struct Serial {
    inner: Arc<Inner>,
}

impl Serial {
    /// Starts the runner's thread, named `name`.
    pub fn new(name: &str) -> std::io::Result<Serial> {
        let inner = Arc::new(Inner::default());
        let worker = inner.clone();
        std::thread::Builder::new().name(name.to_string()).spawn(move || run_jobs(&worker))?;
        Ok(Serial { inner })
    }

    /// Queues `job` behind every job handed in before it and returns at once; it runs when they have ended. False once
    /// the runner is closed: the job is dropped without running.
    pub fn run(&self, job: impl FnOnce() + Send + 'static) -> bool {
        let mut s = self.inner.lock();
        if s.closed {
            return false;
        }
        s.queue.push_back(Box::new(job));
        self.inner.work.notify_one();
        true
    }

    /// No job is taken after this; returns once the jobs handed in before (the one running and those queued) have ended,
    /// so a write under way when the app closes lands whole. Never call it from a job.
    pub fn close(&self) {
        let mut s = self.inner.lock();
        s.closed = true;
        self.inner.work.notify_all();
        while s.running || !s.queue.is_empty() {
            s = self.inner.idle.wait(s).unwrap_or_else(|e| e.into_inner());
        }
    }
}

fn run_jobs(inner: &Inner) {
    let mut s = inner.lock();
    loop {
        let Some(job) = s.queue.pop_front() else {
            if s.closed {
                inner.idle.notify_all();
                return;
            }
            s = inner.work.wait(s).unwrap_or_else(|e| e.into_inner());
            continue;
        };
        s.running = true;
        drop(s);
        // A job that panics ends alone: the jobs after it still run.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job));
        s = inner.lock();
        s.running = false;
        if s.queue.is_empty() {
            inner.idle.notify_all();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    /// Jobs whose work takes longer the earlier they were handed in: run side by side, they would end last first.
    fn slower_first(n: u64, log: &Arc<Mutex<Vec<u64>>>) -> Vec<impl FnOnce() + Send + 'static> {
        (0..n)
            .map(|i| {
                let log = log.clone();
                move || {
                    std::thread::sleep(Duration::from_millis((n - i) * 15));
                    log.lock().unwrap().push(i);
                }
            })
            .collect()
    }

    #[test]
    fn jobs_end_in_the_order_they_were_handed_in() {
        let serial = Serial::new("serial-test").unwrap();
        let log = Arc::new(Mutex::new(Vec::new()));
        for job in slower_first(8, &log) {
            assert!(serial.run(job));
        }
        serial.close();
        assert_eq!(*log.lock().unwrap(), (0..8).collect::<Vec<_>>());
    }

    #[test]
    fn control_the_same_jobs_side_by_side_end_out_of_order() {
        // The ordering test above can fail: without the runner, these jobs land in another order.
        let log = Arc::new(Mutex::new(Vec::new()));
        let threads: Vec<_> = slower_first(8, &log).into_iter().map(std::thread::spawn).collect();
        for t in threads {
            t.join().unwrap();
        }
        assert_ne!(*log.lock().unwrap(), (0..8).collect::<Vec<_>>());
    }

    #[test]
    fn handing_in_a_job_does_not_wait_for_it() {
        let serial = Serial::new("serial-test").unwrap();
        let (release, held) = mpsc::channel::<()>();
        let (ended_tx, ended) = mpsc::channel::<()>();
        // The job can't end until this thread lets it: run() returning proves the caller wasn't held.
        assert!(serial.run(move || {
            held.recv().unwrap();
            ended_tx.send(()).unwrap();
        }));
        assert!(ended.try_recv().is_err(), "the job ended before it was let go");
        release.send(()).unwrap();
        ended.recv_timeout(Duration::from_secs(10)).unwrap();
        serial.close();
    }

    #[test]
    fn close_waits_for_the_running_and_queued_jobs_and_refuses_new_ones() {
        let serial = Serial::new("serial-test").unwrap();
        let log = Arc::new(Mutex::new(Vec::new()));
        for job in slower_first(3, &log) {
            assert!(serial.run(job));
        }
        serial.close();
        assert_eq!(*log.lock().unwrap(), [0, 1, 2], "close returned before the jobs handed in had ended");
        let late = log.clone();
        assert!(!serial.run(move || late.lock().unwrap().push(99)), "a job was taken after close");
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(*log.lock().unwrap(), [0, 1, 2]);
    }

    #[test]
    fn a_job_that_panics_does_not_stop_the_ones_after_it() {
        let serial = Serial::new("serial-test").unwrap();
        let log = Arc::new(Mutex::new(Vec::new()));
        assert!(serial.run(|| panic!("a job's own failure")));
        let after = log.clone();
        assert!(serial.run(move || after.lock().unwrap().push(1)));
        serial.close();
        assert_eq!(*log.lock().unwrap(), [1]);
    }
}
