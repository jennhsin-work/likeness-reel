// Background job queue: persisted job records, limited concurrency, retries with
// backoff, progress updates the UI polls for. Handlers are registered by type.
import { db, uid, now } from "./db.js";

const handlers = new Map();
const queue = []; let running = 0;
const CONCURRENCY = +(process.env.JOB_CONCURRENCY || 2);

export function register(type, fn) { handlers.set(type, fn); }

export function enqueue(type, input, { maxAttempts = 3, label = type } = {}) {
  const job = { id: uid("job"), type, label, input, status: "queued", attempts: 0, maxAttempts, progress: 0, note: "", result: null, error: null, createdAt: now(), updatedAt: now() };
  db.jobs.put(job); queue.push(job.id); pump(); return job;
}
export const getJob = (id) => db.jobs.get(id);
export const jobsFor = (pred) => db.jobs.all().filter(pred);

function update(job, patch) { Object.assign(job, patch, { updatedAt: now() }); db.jobs.put(job); }

async function pump() {
  while (running < CONCURRENCY && queue.length) {
    const job = db.jobs.get(queue.shift()); if (!job) continue;
    running++; run(job).finally(() => { running--; pump(); });
  }
}

async function run(job) {
  const fn = handlers.get(job.type);
  if (!fn) return update(job, { status: "failed", error: `no handler for ${job.type}` });
  update(job, { status: "running", attempts: job.attempts + 1, startedAt: now() });
  const progress = (p, note) => update(job, { progress: Math.max(0, Math.min(1, p)), note: note ?? job.note });
  try {
    const result = await fn(job.input, progress, job);
    update(job, { status: "done", progress: 1, result, finishedAt: now() });
  } catch (err) {
    const msg = err?.message || String(err);
    if (job.attempts < job.maxAttempts && !/invalid|not allowed|unauthori|quota|credit/i.test(msg)) {
      update(job, { status: "queued", error: msg, note: `retrying (${job.attempts}/${job.maxAttempts}): ${msg}` });
      setTimeout(() => { queue.push(job.id); pump(); }, 1500 * job.attempts);
    } else update(job, { status: "failed", error: msg.replace(/^invalid:\s*/, ""), finishedAt: now() });
  }
}

// Forget finished jobs after a day, then re-queue whatever was in flight when the process died.
for (const j of db.jobs.all()) if (j.status !== "queued" && j.status !== "running" && Date.now() - Date.parse(j.updatedAt) > 864e5) db.jobs.del(j.id);
for (const j of db.jobs.all()) if (j.status === "running" || j.status === "queued") { j.status = "queued"; queue.push(j.id); }
setTimeout(pump, 0);
