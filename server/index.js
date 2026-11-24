// Morsy 2.0 backend. Plain Node http, bound to localhost only.
//   profiles  - likeness photos, approved references, consent, environment footage
//   projects  - request -> shot list -> stills -> clips -> rendered reel
//   jobs      - background queue (see pipeline.js); the UI polls documents for progress
//   /media/*  - the private media store, served only to the local UI
import http from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { db, uid, now } from "./db.js";
import { saveStream, mediaPath, removeDir, removeFile, contentType } from "./media.js";
import { enqueue, jobsFor } from "./jobs.js";
import { refs, renumber, newShot, enqueueOnce, DEFAULT_SETTINGS } from "./pipeline.js";
import { pick, estimate } from "./adapters/generators.js";

const PORT = +(process.env.PORT || 8790);
const HOST = process.env.HOST || "127.0.0.1";
process.on("uncaughtException", (e) => console.error("uncaught:", e.message));
process.on("unhandledRejection", (e) => console.error("unhandled:", e?.message ?? e));

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const need = (v, what) => { if (!v) throw new HttpError(404, `${what} not found`); return v; };
const profileOf = (id) => need(db.profiles.get(id), "profile");
const projectOf = (id) => need(db.projects.get(id), "project");
const shotOf = (proj, id) => need(proj.shots.find((s) => s.id === id), "shot");
const requireConsent = (prof) => { if (!prof.consent) throw new HttpError(403, "Confirm consent on the likeness step before generating."); };

// ---- views sent to the UI ----------------------------------------------------------
const jobView = ({ id, type, label, status, progress, note, error, input, updatedAt }) => ({ id, type, label, status, progress, note, error, shotId: input?.shotId, footageId: input?.footageId, target: input?.target, updatedAt });
/** Active jobs, plus the latest job per (type, target) if it failed - older history is noise. */
function jobsView(pred) {
  const latest = new Map();
  for (const j of jobsFor(pred)) { const k = `${j.type}:${j.input?.shotId ?? j.input?.footageId ?? ""}:${j.input?.target ?? ""}`; if (!latest.has(k) || latest.get(k).createdAt < j.createdAt) latest.set(k, j); }
  return [...latest.values()].filter((j) => j.status !== "done").map(jobView);
}
function profileView(p) {
  const r = refs(p);
  return { ...p, primaryFaceId: r.face?.id ?? null, primaryBodyId: r.body?.id ?? null, jobs: jobsView((j) => j.input?.profileId === p.id) };
}
function projectView(p) {
  const gen = p.shots.filter((s) => s.source === "generate");
  const toAnimate = gen.filter((s) => s.approved && s.still && !s.clip);
  return {
    ...p, settings: { ...DEFAULT_SETTINGS, ...p.settings },
    progress: { shots: p.shots.length, generated: gen.length, stills: gen.filter((s) => s.still).length, approved: gen.filter((s) => s.still && s.approved).length, clips: gen.filter((s) => s.clip).length, seconds: +p.shots.reduce((a, s) => a + s.seconds, 0).toFixed(1) },
    estimate: { stills: estimate({ stills: gen.filter((s) => !s.still).length }), animate: estimate({ videoSeconds: toAnimate.reduce((a, s) => a + s.seconds, 0) }) },
    jobs: jobsView((j) => j.input?.projectId === p.id),
  };
}
const touch = (proj) => { if (proj.render) proj.render.stale = true; return db.projects.put(proj); };

// ---- routes ---------------------------------------------------------------------------
const routes = [];
const route = (method, pattern, fn, opts = {}) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)")}$`), fn, ...opts });

route("GET", "/api/health", () => { const g = pick(); return { ok: true, name: "Morsy 2.0", model: process.env.MODEL || "claude-opus-5-5", mode: g.mode, image: g.image.label, video: g.video.label }; });

// profiles
route("GET", "/api/profiles", () => db.profiles.all().map(profileView));
route("POST", "/api/profiles", (_, body) => profileView(db.profiles.put({ id: uid("prof"), name: body.name || "Me", consent: false, consentAt: null, faces: [], bodies: [], footage: [], likeness: null, primaryFaceId: null, primaryBodyId: null, createdAt: now() })));
route("GET", "/api/profiles/:id", (p) => profileView(profileOf(p.id)));
route("DELETE", "/api/profiles/:id", (p) => {
  profileOf(p.id); removeDir(`profiles/${p.id}`);
  for (const proj of db.projects.all()) if (proj.profileId === p.id) { removeDir(`projects/${proj.id}`); db.projects.del(proj.id); }
  db.profiles.del(p.id); return { ok: true };
});
route("POST", "/api/profiles/:id/consent", (p, body) => { const prof = profileOf(p.id); prof.consent = !!body.consent; prof.consentAt = prof.consent ? now() : null; return profileView(db.profiles.put(prof)); });
route("POST", "/api/profiles/:id/likeness", (p, body) => {           // the user can correct the notes
  const prof = profileOf(p.id); if (!prof.likeness) throw new HttpError(409, "No likeness notes yet.");
  for (const k of ["description", "bodyProportions", "signatureStyle"]) if (typeof body[k] === "string") prof.likeness[k] = body[k].trim();
  prof.likeness.edited = true; prof.likeness.updatedAt = now(); return profileView(db.profiles.put(prof));
});
route("POST", "/api/profiles/:id/likeness/refresh", (p) => { const prof = profileOf(p.id); enqueueOnce("describe-likeness", { profileId: prof.id }, { label: "Likeness notes", whileRunning: true }); return profileView(prof); });

// uploads: one file per request, raw body. ?kind=face|body|footage&name=...&usage=inspiration|exact
route("POST", "/api/profiles/:id/upload", async (p, _, req, url) => {
  const prof = profileOf(p.id); const kind = url.searchParams.get("kind"); const name = url.searchParams.get("name") || "upload"; const type = (req.headers["content-type"] || "").split(";")[0];
  const isImage = type.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif)$/i.test(name), isVideo = type.startsWith("video/") || /\.(mp4|mov|webm|m4v)$/i.test(name);
  if (kind === "face" || kind === "body") {
    if (!isImage) throw new HttpError(400, "Likeness photos must be images (JPEG, PNG, WebP or HEIC).");
    const list = kind === "face" ? "faces" : "bodies";
    const saved = await saveStream(`profiles/${prof.id}/${list}`, { name, type, stream: req });
    const fresh = profileOf(p.id); fresh[list].push({ id: uid("ph"), ...saved, approved: true, createdAt: now() });
    db.profiles.put(fresh); enqueueOnce("describe-likeness", { profileId: fresh.id }, { label: "Likeness notes", whileRunning: true });
    return profileView(fresh);
  }
  if (kind === "footage") {
    if (!isImage && !isVideo) throw new HttpError(400, "Footage must be a video clip or a photo.");
    const saved = await saveStream(`profiles/${prof.id}/footage`, { name, type, stream: req });
    const fresh = profileOf(p.id);
    const item = { id: uid("ft"), kind: isVideo ? "clip" : "photo", usage: url.searchParams.get("usage") === "exact" ? "exact" : "inspiration", status: "analyzing", frames: [], analysis: null, durationSec: 0, ...saved, createdAt: now() };
    fresh.footage.push(item); db.profiles.put(fresh);
    enqueue("analyze-footage", { profileId: fresh.id, footageId: item.id }, { label: `Analyze ${item.originalName}` });
    return profileView(fresh);
  }
  throw new HttpError(400, "Unknown upload kind.");
}, { raw: true });

route("POST", "/api/profiles/:id/photos/:photo", (p, body) => {       // approve / un-approve / make primary
  const prof = profileOf(p.id); const list = prof.faces.some((x) => x.id === p.photo) ? "faces" : "bodies"; const ph = need(prof[list].find((x) => x.id === p.photo), "photo");
  if (typeof body.approved === "boolean") ph.approved = body.approved;
  if (body.primary) { ph.approved = true; if (list === "faces") { prof.primaryFaceId = ph.id; prof.primaryFaceByUser = true; } else { prof.primaryBodyId = ph.id; prof.primaryBodyByUser = true; } }
  db.profiles.put(prof);
  if (typeof body.approved === "boolean") enqueueOnce("describe-likeness", { profileId: prof.id }, { label: "Likeness notes", whileRunning: true });
  return profileView(prof);
});
route("DELETE", "/api/profiles/:id/photos/:photo", (p) => {
  const prof = profileOf(p.id); const ph = [...prof.faces, ...prof.bodies].find((x) => x.id === p.photo);
  if (ph) removeFile(ph.rel);
  prof.faces = prof.faces.filter((x) => x.id !== p.photo); prof.bodies = prof.bodies.filter((x) => x.id !== p.photo);
  if (!prof.faces.length) prof.likeness = null;
  db.profiles.put(prof); if (prof.faces.length) enqueueOnce("describe-likeness", { profileId: prof.id }, { label: "Likeness notes", whileRunning: true });
  return profileView(prof);
});
route("POST", "/api/profiles/:id/footage/:footage", (p, body) => { const prof = profileOf(p.id); const f = need(prof.footage.find((x) => x.id === p.footage), "footage"); if (body.usage === "exact" || body.usage === "inspiration") f.usage = body.usage; return profileView(db.profiles.put(prof)); });
route("POST", "/api/profiles/:id/footage/:footage/analyze", (p) => { const prof = profileOf(p.id); const f = need(prof.footage.find((x) => x.id === p.footage), "footage"); f.status = "analyzing"; f.error = null; db.profiles.put(prof); enqueueOnce("analyze-footage", { profileId: prof.id, footageId: f.id }, { label: `Analyze ${f.originalName}` }); return profileView(prof); });
route("DELETE", "/api/profiles/:id/footage/:footage", (p) => {
  const prof = profileOf(p.id); const f = prof.footage.find((x) => x.id === p.footage);
  if (f) { removeFile(f.rel); for (const fr of f.frames ?? []) removeFile(fr); }
  prof.footage = prof.footage.filter((x) => x.id !== p.footage); return profileView(db.profiles.put(prof));
});

// projects
route("GET", "/api/projects", (_, __, ___, url) => db.projects.all().filter((p) => !url.searchParams.get("profile") || p.profileId === url.searchParams.get("profile")).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(projectView));
route("POST", "/api/projects", (_, body) => {
  const prof = profileOf(body.profileId); requireConsent(prof);
  if (!prof.likeness) throw new HttpError(409, "Add face photos first - the planner needs your likeness notes.");
  const request = String(body.request || "").trim(); if (request.length < 8) throw new HttpError(400, "Describe the video in a sentence.");
  const proj = db.projects.put({ id: uid("proj"), profileId: prof.id, request, durationSec: Math.max(6, Math.min(30, +body.durationSec || 15)), aspect: ["9:16", "1:1", "16:9"].includes(body.aspect) ? body.aspect : "9:16", title: "", logline: "", music: "", status: "planning", shots: [], settings: { ...DEFAULT_SETTINGS }, render: null, createdAt: now() });
  enqueue("plan", { projectId: proj.id }, { label: "Shot list" }); return projectView(proj);
});
route("GET", "/api/projects/:id", (p) => projectView(projectOf(p.id)));
route("DELETE", "/api/projects/:id", (p) => { projectOf(p.id); removeDir(`projects/${p.id}`); db.projects.del(p.id); return { ok: true }; });
route("POST", "/api/projects/:id", (p, body) => { const proj = projectOf(p.id); if (typeof body.title === "string") proj.title = body.title.trim().slice(0, 80); return projectView(touch(proj)); });
route("POST", "/api/projects/:id/replan", (p) => { const proj = projectOf(p.id); requireConsent(profileOf(proj.profileId)); proj.status = "planning"; db.projects.put(proj); enqueueOnce("plan", { projectId: proj.id }, { label: "Shot list" }); return projectView(proj); });
route("POST", "/api/projects/:id/settings", (p, body) => {
  const proj = projectOf(p.id); const s = { ...DEFAULT_SETTINGS, ...proj.settings };
  for (const k of ["captions", "titleCard", "narration"]) if (typeof body[k] === "boolean") s[k] = body[k];
  if (["auto", "none", "upload"].includes(body.music)) s.music = body.music;
  if (["warm", "upbeat", "calm"].includes(body.mood)) { s.mood = body.mood; s.moodByUser = true; }
  if (typeof body.voice === "string") s.voice = body.voice.slice(0, 40);
  proj.settings = s; return projectView(touch(proj));
});
route("POST", "/api/projects/:id/music", async (p, _, req, url) => {
  const proj = projectOf(p.id); const name = url.searchParams.get("name") || "music"; const type = (req.headers["content-type"] || "").split(";")[0];
  if (!type.startsWith("audio/") && !/\.(mp3|m4a|wav|aac)$/i.test(name)) throw new HttpError(400, "Music must be an audio file (MP3, M4A, WAV).");
  const saved = await saveStream(`projects/${proj.id}/music`, { name, type, stream: req, maxBytes: 60e6 });
  const fresh = projectOf(p.id); fresh.settings = { ...DEFAULT_SETTINGS, ...fresh.settings, music: "upload", musicRel: saved.rel, musicName: saved.originalName };
  return projectView(touch(fresh));
}, { raw: true });

// shots
const EDITABLE = { title: "string", seconds: "number", caption: "string", narration: "string", stillPrompt: "string", motionPrompt: "string", framing: "string", startSec: "number", fit: "string" };
route("POST", "/api/projects/:id/shots", (p, body) => {
  const proj = projectOf(p.id); const prof = profileOf(proj.profileId);
  const footage = body.footageId ? need(prof.footage.find((f) => f.id === body.footageId), "footage") : null;
  const shot = footage ? newShot({ source: "footage", footageId: footage.id, title: footage.analysis?.summary?.slice(0, 40) || footage.originalName, approved: true, seconds: Math.max(2, Math.min(5, Math.round(footage.durationSec || 4))) })
    : newShot({ title: "New shot", stillPrompt: "[LIKENESS] ", framing: "medium shot" });
  proj.shots.push(shot); return projectView(touch(renumber(proj)));
});
route("POST", "/api/projects/:id/shots/:shot", (p, body) => {
  const proj = projectOf(p.id); const s = shotOf(proj, p.shot);
  for (const [k, t] of Object.entries(EDITABLE)) if (typeof body[k] === t) s[k] = body[k];
  s.seconds = Math.max(1, Math.min(10, Math.round(s.seconds * 2) / 2)); s.startSec = Math.max(0, s.startSec || 0); if (!["cover", "contain"].includes(s.fit)) s.fit = "contain";
  return projectView(touch(proj));
});
route("DELETE", "/api/projects/:id/shots/:shot", (p) => { const proj = projectOf(p.id); shotOf(proj, p.shot); proj.shots = proj.shots.filter((s) => s.id !== p.shot); return projectView(touch(renumber(proj))); });
route("POST", "/api/projects/:id/shots/:shot/move", (p, body) => {
  const proj = projectOf(p.id); const i = proj.shots.indexOf(shotOf(proj, p.shot)); const j = i + (body.dir < 0 ? -1 : 1);
  if (j >= 0 && j < proj.shots.length) [proj.shots[i], proj.shots[j]] = [proj.shots[j], proj.shots[i]];
  return projectView(touch(renumber(proj)));
});
route("POST", "/api/projects/:id/shots/:shot/still", (p, body) => {
  const proj = projectOf(p.id); requireConsent(profileOf(proj.profileId)); const s = shotOf(proj, p.shot);
  if (s.source !== "generate") throw new HttpError(409, "This shot uses your footage.");
  if (typeof body.stillPrompt === "string") s.stillPrompt = body.stillPrompt; db.projects.put(proj);
  enqueueOnce("still", { projectId: proj.id, shotId: s.id }, { label: `Still: ${s.title}` }); return projectView(proj);
});
route("POST", "/api/projects/:id/shots/:shot/approve", (p, body) => { const proj = projectOf(p.id); const s = shotOf(proj, p.shot); if (!s.still && s.source === "generate") throw new HttpError(409, "Generate a still first."); s.approved = body.approved !== false; return projectView(touch(proj)); });
route("POST", "/api/projects/:id/shots/:shot/restore", (p, body) => {   // bring back an earlier still
  const proj = projectOf(p.id); const s = shotOf(proj, p.shot); const old = need(s.history[body.index], "version");
  s.history.splice(body.index, 1); if (s.still) s.history.push(s.still);
  Object.assign(s, { still: old, approved: false, critique: null, clip: null, clipCritique: null }); return projectView(touch(proj));
});
route("POST", "/api/projects/:id/shots/:shot/qa", (p, body) => {
  const proj = projectOf(p.id); const s = shotOf(proj, p.shot); const target = body.target === "clip" ? "clip" : "still";
  if (!(target === "clip" ? s.clip : s.still)) throw new HttpError(409, `No ${target} to check yet.`);
  enqueueOnce("qa", { projectId: proj.id, shotId: s.id, target }, { label: `Check ${target}: ${s.title}`, maxAttempts: 2 }); return projectView(proj);
});
route("POST", "/api/projects/:id/shots/:shot/animate", (p) => {
  const proj = projectOf(p.id); requireConsent(profileOf(proj.profileId)); const s = shotOf(proj, p.shot);
  if (!s.still || !s.approved) throw new HttpError(409, "Approve the still before animating it.");
  s.clip = null; s.clipCritique = null; db.projects.put(proj);
  enqueueOnce("animate", { projectId: proj.id, shotId: s.id }, { label: `Animate: ${s.title}` }); return projectView(proj);
});
route("POST", "/api/projects/:id/stills", (p) => {                      // every generated shot that has no still yet
  const proj = projectOf(p.id); requireConsent(profileOf(proj.profileId)); let queued = 0;
  for (const s of proj.shots) if (s.source === "generate" && !s.still) { enqueueOnce("still", { projectId: proj.id, shotId: s.id }, { label: `Still: ${s.title}` }); queued++; }
  return { queued, project: projectView(proj) };
});
route("POST", "/api/projects/:id/animate", (p) => {                     // every approved still that has no clip yet
  const proj = projectOf(p.id); requireConsent(profileOf(proj.profileId)); let queued = 0;
  for (const s of proj.shots) if (s.source === "generate" && s.approved && s.still && !s.clip) { enqueueOnce("animate", { projectId: proj.id, shotId: s.id }, { label: `Animate: ${s.title}` }); queued++; }
  return { queued, project: projectView(proj) };
});
route("POST", "/api/projects/:id/render", (p) => { const proj = projectOf(p.id); enqueueOnce("render", { projectId: proj.id }, { label: "Render reel", maxAttempts: 2 }); return projectView(proj); });

// ---- http plumbing ----------------------------------------------------------------------
const send = (res, code, body) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
const readJson = (req) => new Promise((resolve, reject) => {
  let b = ""; req.on("data", (c) => { b += c; if (b.length > 2e6) req.destroy(new Error("body too large")); });
  req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new HttpError(400, "Invalid JSON body.")); } }); req.on("error", reject);
});
function serveMedia(req, res, url) {
  const rel = decodeURIComponent(url.pathname.slice("/media/".length)); const p = mediaPath(rel);
  if (!rel || rel.includes("..") || rel.endsWith("db.json") || !existsSync(p) || statSync(p).isDirectory()) return send(res, 404, { error: "not found" });
  const size = statSync(p).size; const head = { "content-type": contentType(rel), "accept-ranges": "bytes", "cache-control": "private, max-age=3600" };
  const stream = (opts) => createReadStream(p, opts).on("error", () => res.destroy());
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (m) {
    const start = m[1] ? +m[1] : Math.max(0, size - +m[2]); const end = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1;
    if (start >= size) { res.writeHead(416, { "content-range": `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { ...head, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 }); return stream({ start, end }).pipe(res);
  }
  res.writeHead(200, { ...head, "content-length": size }); stream().pipe(res);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname.startsWith("/media/")) return serveMedia(req, res, url);
  for (const r of routes) {
    const m = r.method === req.method && url.pathname.match(r.re); if (!m) continue;
    try {
      const body = r.raw || req.method === "GET" ? {} : await readJson(req);
      return send(res, 200, await r.fn(m.groups ?? {}, body, req, url));
    } catch (err) {
      const status = err.status ?? (/^invalid:/.test(err.message) ? 400 : 500);
      if (status >= 500) console.error(`[${req.method} ${url.pathname}]`, err.message);
      if (r.raw) req.resume();
      return send(res, status, { error: err.message.replace(/^invalid:\s*/, "") });
    }
  }
  send(res, 404, { error: "not found" });
}).listen(PORT, HOST, () => { const g = pick(); console.log(`Morsy 2.0 backend on http://${HOST}:${PORT} · stills: ${g.image.label} · video: ${g.video.label}`); });
