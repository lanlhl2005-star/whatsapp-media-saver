/**
 * Simple concurrency-limited async queue for media downloads.
 */
export function createDownloadQueue({ concurrency = 2, logger } = {}) {
  let active = 0;
  const pending = [];

  function pump() {
    while (active < concurrency && pending.length) {
      const job = pending.shift();
      active += 1;
      Promise.resolve()
        .then(() => job.fn())
        .then(
          (value) => {
            active -= 1;
            job.resolve(value);
            pump();
          },
          (err) => {
            active -= 1;
            logger?.warn?.({ err: err?.message }, 'download job failed');
            job.reject(err);
            pump();
          },
        );
    }
  }

  function enqueue(fn) {
    return new Promise((resolve, reject) => {
      pending.push({ fn, resolve, reject });
      pump();
    });
  }

  return {
    enqueue,
    get size() {
      return pending.length + active;
    },
    get pending() {
      return pending.length;
    },
    get active() {
      return active;
    },
  };
}
