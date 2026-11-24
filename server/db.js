// Tiny JSON document store: profiles, projects, jobs. Atomic writes, in-memory reads.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export const DATA_DIR = process.env.DATA_DIR || "data";
const FILE = join(DATA_DIR, "db.json");

const state = { profiles: {}, projects: {}, jobs: {} };
mkdirSync(DATA_DIR, { recursive: true });
if (existsSync(FILE)) { try { Object.assign(state, JSON.parse(readFileSync(FILE, "utf8"))); } catch (e) { console.warn("db: could not read", e.message); } }

let timer = null;
function flush() { timer = null; writeFileSync(FILE + ".tmp", JSON.stringify(state, null, 1)); renameSync(FILE + ".tmp", FILE); }
export function save() { if (!timer) timer = setTimeout(flush, 50); }
export function saveNow() { if (timer) clearTimeout(timer); flush(); }

export const uid = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export const now = () => new Date().toISOString();

export const db = {
  profiles: { get: (id) => state.profiles[id], all: () => Object.values(state.profiles), put: (p) => { state.profiles[p.id] = p; save(); return p; }, del: (id) => { delete state.profiles[id]; save(); } },
  projects: { get: (id) => state.projects[id], all: () => Object.values(state.projects), put: (p) => { state.projects[p.id] = p; save(); return p; }, del: (id) => { delete state.projects[id]; save(); } },
  jobs: { get: (id) => state.jobs[id], all: () => Object.values(state.jobs), put: (j) => { state.jobs[j.id] = j; save(); return j; }, del: (id) => { delete state.jobs[id]; save(); } },
};
