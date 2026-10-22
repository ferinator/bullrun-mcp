/**
 * At most a few whole-universe screens at once from this server. Each screener POST is one large
 * query that Postgres runs with parallel workers, and those keep their hash tables in /dev/shm
 * (1 GB on prod). In a local load test, 30 anonymous sessions screening at the same moment filled
 * it and nine screens failed with HTTP 500 ("could not resize shared memory segment"). Per-caller
 * budgets make that kind of burst possible, so the extra screens wait here for a slot instead; one
 * screen takes 1-5 s, so the wait is short. With 4 slots the same run had no failures. Each screen
 * runs as 3 Postgres processes and prod has 8 cores, so the default is 3. Other reads are not gated.
 */
export const SCREEN_PATHS = new Set(["/api/screener/filter", "/api/etfs/screener"]);

const DEFAULT_CONCURRENCY = 3;
export const SCREEN_MAX_WAIT_MS = 30_000;

export interface Gate {
  run<T>(task: () => Promise<T>, maxWaitMs?: number): Promise<T>;
  readonly active: number;
  readonly waiting: number;
}

export function createGate(concurrency: number): Gate {
  let active = 0;
  const queue: Array<{ start: () => void; timer?: NodeJS.Timeout }> = [];
  // A finished screen hands its slot straight to the next waiter, so a newcomer cannot take it
  // in between and push the count over the limit.
  const release = () => {
    const next = queue.shift();
    if (next) {
      if (next.timer) clearTimeout(next.timer);
      next.start();
    } else {
      active--;
    }
  };
  return {
    get active() { return active; },
    get waiting() { return queue.length; },
    async run(task, maxWaitMs = SCREEN_MAX_WAIT_MS) {
      let waitUntil: number | undefined;
      if (active < concurrency) {
        active++;
      } else {
        waitUntil = Date.now() + maxWaitMs;
        await new Promise<void>((resolve, reject) => {
          const entry: { start: () => void; timer?: NodeJS.Timeout } = { start: resolve };
          entry.timer = setTimeout(() => {
            const at = queue.indexOf(entry);
            if (at >= 0) queue.splice(at, 1);
            reject(new Error("Bullrun is busy running other screens; retry this screen in a few seconds."));
          }, maxWaitMs);
          queue.push(entry);
        });
      }
      try {
        // A busy event loop can deliver a released slot before its overdue timer.
        // Release that slot again without starting work that already waited too long.
        if (waitUntil !== undefined && Date.now() >= waitUntil) {
          throw new Error("Bullrun is busy running other screens; retry this screen in a few seconds.");
        }
        return await task();
      } finally {
        release();
      }
    },
  };
}

function envConcurrency(): number {
  const value = Number(process.env.MCP_SCREEN_CONCURRENCY);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_CONCURRENCY;
}

export const screenGate = createGate(envConcurrency());
