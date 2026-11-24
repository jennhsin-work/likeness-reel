// Likeness Reel backend: profiles (likeness + footage), projects (shot list →
// stills → clips → render), background jobs. Plain Node http; JSON bodies with
// base64 uploads; media served to the local UI from data/.
import http from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { db, uid, now } from "./db.js";
import { saveUpload, mediaPath, removeDir, contentType, saveBuffer } from "./media.js";
import { enqueue, register, getJob, jobsFor } from "./jobs.js";
import * as claude from "./adapters/claude.js";
import { pick } from "./adapters/generators.js";

const PORT = +(process.env.PORT || 8790);
process.on("uncaughtException", (e) => console.error("uncaught:", e.message));
process.on("unhandledRejection", (e) => console.error("unhandled:", e?.message ?? e));
const py = (script, args) => new Promise((resolve, reject) => {
  const p = spawn("python3", ["-I", script, ...args]); let out = "", err = "";
  p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
  p.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err.trim().split("\n").slice(-3).join(" ") || `${script} exited ${code}`))));
});

// ---- job handlers --------------------------------------------------------------------
register("analyze-footage", async ({ profileId, footageId }, progress) => {
  const prof = db.profiles.get(profileId); const f = prof.footage.find((x) => x.id === footageId);
  progress(0.1, "extracting frames");
  const out = await py("scripts/frames.py", [mediaPath(f.rel), mediaPath(`profiles/${profileId}/frames`), f.id, "4"]);
  f.frames = out.split("\n").filter((l) => l && !l.startsWith("#")).map((p) => p.replace(/^.*?data\//, ""));
  f.durationSec = +(out.match(/#duration=([\d.]+)/)?.[1] ?? 0) || f.durationSec;
  db.profiles.put(prof);
  progress(0.5, "describing with vision model");
  try { f.analysis = await claude.analyzeFrames(f.frames, { filename: f.originalName, usage: f.usage }); f.status = "ready"; }
  catch (e) { f.status = "failed"; f.error = e.message; db.profiles.put(prof); throw e; }
  db.profiles.put(prof); return f.analysis;
});

register("describe-likeness", async ({ profileId }, progress) => {
  const prof = db.profiles.get(profileId);
  if (!prof.faces.length) throw new Error("add at least one face photo");
  progress(0.3, "studying reference photos");
  const lk = await claude.describeLikeness(prof.faces.map((x) => x.rel), prof.bodies.map((x) => x.rel));
  prof.likeness = { ...lk, faceRef: prof.faces[Math.max(0, Math.min(prof.faces.length - 1, lk.bestFaceRef))]?.rel, bodyRef: prof.bodies[lk.bestBodyRef]?.rel ?? null, updatedAt: now() };
  db.profiles.put(prof); return prof.likeness;
});

register("plan", async ({ projectId }, progress) => {
  const proj = db.projects.get(projectId); const prof = db.profiles.get(proj.profileId);
  if (!prof.likeness) throw new Error("profile has no likeness notes yet");
  progress(0.2, "planning the shot list");
  const plan = await claude.planShots({ request: proj.request, durationSec: proj.durationSec, likeness: prof.likeness, footage: prof.footage.filter((f) => f.status === "ready") });
  proj.title = plan.title; proj.logline = plan.logline; proj.music = plan.music;
  proj.shots = plan.shots.map((s) => ({ ...s, id: uid("shot"), still: null, clip: null, approved: s.source === "footage", critique: null, history: [] }));
  proj.status = "planned"; db.projects.put(proj); return plan;
});

register("still", async ({ projectId, shotId }, progress) => {
  const proj = db.projects.get(projectId); const prof = db.profiles.get(proj.profileId); const shot = proj.shots.find((s) => s.id === shotId);
  const { image } = pick();
  const prompt = shot.stillPrompt.replace(/\[LIKENESS\]/g, prof.likeness.description);
  const envRef = prof.footage.find((f) => shot.inspirationIds.includes(f.id))?.frames?.[0] ?? prof.footage.find((f) => f.frames?.length)?.frames?.[0] ?? null;
  progress(0.2, `generating with ${image.name}`);
  const res = await image.generateStill({ prompt, faceRel: prof.likeness.faceRef, bodyRel: prof.likeness.bodyRef, envRel: envRef, aspect: proj.aspect, outDir: `projects/${projectId}/stills`, caption: `${shot.n}. ${shot.title}` });
  if (shot.still) shot.history.push(shot.still);
  shot.still = { ...res, prompt, createdAt: now() }; shot.approved = false; shot.critique = null; shot.clip = null; db.projects.put(proj); // a new still invalidates its clip
  if (image.name !== "preview") { // QA the real generation against the reference face
    progress(0.8, "checking likeness");
    try { shot.critique = await claude.critiqueStill({ stillRel: res.rel, faceRel: prof.likeness.faceRef, shot }); } catch (e) { shot.critique = { verdict: "approve", issues: [`QA skipped: ${e.message}`], likenessScore: null }; }
    db.projects.put(proj);
  }
  return shot.still;
});

register("animate", async ({ projectId, shotId }, progress) => {
  const proj = db.projects.get(projectId); const shot = proj.shots.find((s) => s.id === shotId);
  const { video } = pick();
  if (!shot.still) throw new Error("no approved still to animate");
  progress(0.2, `animating with ${video.name}`);
  const res = await video.animate({ stillRel: shot.still.rel, motionPrompt: shot.motionPrompt, seconds: shot.seconds, aspect: proj.aspect, outDir: `projects/${projectId}/clips` });
  shot.clip = { ...res, createdAt: now() }; db.projects.put(proj); return shot.clip;
});

register("render", async ({ projectId }, progress) => {
  const proj = db.projects.get(projectId); const prof = db.profiles.get(proj.profileId);
  const segments = proj.shots.map((s) => {
    if (s.source === "footage") { const f = prof.footage.find((x) => x.id === s.footageId) ?? prof.footage.find((x) => x.usage === "exact"); return f ? { kind: "footage", path: mediaPath(f.rel), seconds: s.seconds, caption: s.title } : null; }
    if (s.clip) return { kind: "clip", path: mediaPath(s.clip.rel), seconds: s.seconds, caption: s.title };
    if (s.still) return { kind: "still", path: mediaPath(s.still.rel), seconds: s.seconds, caption: s.title };
    return null;
  }).filter(Boolean);
  if (!segments.length) throw new Error("nothing to render yet");
  const spec = { title: proj.title, aspect: proj.aspect, segments, music: proj.music };
  const specRel = saveBuffer(`projects/${projectId}/renders`, "spec.json", Buffer.from(JSON.stringify(spec))).rel;
  const outRel = `projects/${projectId}/renders/${uid("reel")}.mp4`;
  progress(0.3, "rendering");
  await py("scripts/render.py", [mediaPath(specRel), mediaPath(outRel)]);
  proj.render = { rel: outRel, createdAt: now(), segments: segments.length }; proj.status = "rendered"; db.projects.put(proj); return proj.render;
});

// ---- http -------------------------------------------------------------------------------
const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve, reject) => { let b = ""; req.on("data", (c) => { b += c; if (b.length > 400e6) req.destroy(); }); req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } }); });
const publicProfile = (p) => ({ ...p, jobs: jobsFor((j) => j.input?.profileId === p.id && j.status !== "done").map(({ id, type, status, progress, note, error }) => ({ id, type, status, progress, note, error })) });
const publicProject = (p) => ({ ...p, jobs: jobsFor((j) => j.input?.projectId === p.id).map(({ id, type, status, progress, note, error, input }) => ({ id, type, status, progress, note, error, shotId: input.shotId })) });

const routes = [
  ["GET", /^\/api\/health$/, () => ({ ok: true, model: process.env.MODEL || "claude-opus-5-5", generators: { image: pick().image.name, video: pick().video.name, mode: pick().mode } })],

  ["GET", /^\/api\/profiles$/, () => db.profiles.all().map(publicProfile)],
  ["POST", /^\/api\/profiles$/, async (_, body) => db.profiles.put({ id: uid("prof"), name: body.name || "Me", consent: false, faces: [], bodies: [], footage: [], likeness: null, createdAt: now() })],
  ["GET", /^\/api\/profiles\/([^/]+)$/, (m) => publicProfile(db.profiles.get(m[1]))],
  ["DELETE", /^\/api\/profiles\/([^/]+)$/, (m) => { removeDir(`profiles/${m[1]}`); for (const p of db.projects.all()) if (p.profileId === m[1]) { removeDir(`projects/${p.id}`); db.projects.del(p.id); } db.profiles.del(m[1]); return { ok: true }; }],
  ["POST", /^\/api\/profiles\/([^/]+)\/consent$/, (m, body) => { const p = db.profiles.get(m[1]); p.consent = !!body.consent; p.consentAt = now(); return db.profiles.put(p); }],
  ["POST", /^\/api\/profiles\/([^/]+)\/photos$/, (m, body) => {
    const p = db.profiles.get(m[1]); const kind = body.kind === "body" ? "bodies" : "faces";
    for (const f of body.files ?? []) p[kind].push({ id: uid("ph"), ...saveUpload(`profiles/${p.id}/${kind}`, f), createdAt: now() });
    p.likeness = null; db.profiles.put(p);
    if (p.faces.length) enqueue("describe-likeness", { profileId: p.id }, { label: "likeness notes" });
    return publicProfile(p);
  }],
  ["DELETE", /^\/api\/profiles\/([^/]+)\/photos\/([^/]+)$/, (m) => { const p = db.profiles.get(m[1]); p.faces = p.faces.filter((x) => x.id !== m[2]); p.bodies = p.bodies.filter((x) => x.id !== m[2]); return db.profiles.put(p); }],
  ["POST", /^\/api\/profiles\/([^/]+)\/footage$/, (m, body) => {
    const p = db.profiles.get(m[1]);
    for (const f of body.files ?? []) {
      const kind = (f.type || "").startsWith("video/") ? "clip" : "photo";
      const item = { id: uid("ft"), kind, usage: body.usage === "exact" ? "exact" : "inspiration", status: "analyzing", frames: [], analysis: null, ...saveUpload(`profiles/${p.id}/footage`, f), createdAt: now() };
      p.footage.push(item); enqueue("analyze-footage", { profileId: p.id, footageId: item.id }, { label: `analyze ${item.originalName}` });
    }
    return db.profiles.put(p) && publicProfile(p);
  }],
  ["POST", /^\/api\/profiles\/([^/]+)\/footage\/([^/]+)\/analyze$/, (m) => { const p = db.profiles.get(m[1]); const f = p.footage.find((x) => x.id === m[2]); f.status = "analyzing"; db.profiles.put(p); enqueue("analyze-footage", { profileId: p.id, footageId: f.id }, { label: `analyze ${f.originalName}` }); return publicProfile(p); }],
  ["POST", /^\/api\/profiles\/([^/]+)\/footage\/([^/]+)$/, (m, body) => { const p = db.profiles.get(m[1]); const f = p.footage.find((x) => x.id === m[2]); if (body.usage) f.usage = body.usage; return db.profiles.put(p); }],
  ["DELETE", /^\/api\/profiles\/([^/]+)\/footage\/([^/]+)$/, (m) => { const p = db.profiles.get(m[1]); p.footage = p.footage.filter((x) => x.id !== m[2]); return db.profiles.put(p); }],

  ["GET", /^\/api\/projects$/, () => db.projects.all().map(publicProject)],
  ["POST", /^\/api\/projects$/, (_, body) => {
    const proj = db.projects.put({ id: uid("proj"), profileId: body.profileId, request: body.request, durationSec: +(body.durationSec || 15), aspect: body.aspect || "9:16", status: "planning", shots: [], render: null, createdAt: now() });
    enqueue("plan", { projectId: proj.id }, { label: "shot list" }); return publicProject(proj);
  }],
  ["GET", /^\/api\/projects\/([^/]+)$/, (m) => publicProject(db.projects.get(m[1]))],
  ["DELETE", /^\/api\/projects\/([^/]+)$/, (m) => { removeDir(`projects/${m[1]}`); db.projects.del(m[1]); return { ok: true }; }],
  ["POST", /^\/api\/projects\/([^/]+)\/replan$/, (m) => { const p = db.projects.get(m[1]); p.status = "planning"; db.projects.put(p); enqueue("plan", { projectId: p.id }); return publicProject(p); }],
  ["POST", /^\/api\/projects\/([^/]+)\/shots\/([^/]+)\/still$/, (m, body) => { const p = db.projects.get(m[1]); const s = p.shots.find((x) => x.id === m[2]); if (body.stillPrompt) s.stillPrompt = body.stillPrompt; db.projects.put(p); enqueue("still", { projectId: p.id, shotId: s.id }, { label: `still: ${s.title}` }); return publicProject(p); }],
  ["POST", /^\/api\/projects\/([^/]+)\/shots\/([^/]+)\/approve$/, (m, body) => { const p = db.projects.get(m[1]); const s = p.shots.find((x) => x.id === m[2]); s.approved = body.approved !== false; return db.projects.put(p) && publicProject(p); }],
  ["POST", /^\/api\/projects\/([^/]+)\/shots\/([^/]+)$/, (m, body) => { const p = db.projects.get(m[1]); const s = p.shots.find((x) => x.id === m[2]); for (const k of ["title", "seconds", "stillPrompt", "motionPrompt", "footageId", "source"]) if (body[k] !== undefined) s[k] = body[k]; return db.projects.put(p) && publicProject(p); }],
  ["POST", /^\/api\/projects\/([^/]+)\/animate$/, (m) => { const p = db.projects.get(m[1]); let n = 0; for (const s of p.shots) if (s.source === "generate" && s.approved && s.still && !s.clip) { enqueue("animate", { projectId: p.id, shotId: s.id }, { label: `animate: ${s.title}` }); n++; } p.status = "animating"; db.projects.put(p); return { queued: n, project: publicProject(p) }; }],
  ["POST", /^\/api\/projects\/([^/]+)\/render$/, (m) => { const p = db.projects.get(m[1]); p.status = "rendering"; db.projects.put(p); enqueue("render", { projectId: p.id }, { label: "render reel" }); return publicProject(p); }],
  ["GET", /^\/api\/jobs\/([^/]+)$/, (m) => getJob(m[1])],
];

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "GET" && url.pathname.startsWith("/media/")) {
    const rel = decodeURIComponent(url.pathname.slice(7)); const p = mediaPath(rel);
    if (!rel || rel.includes("..") || !existsSync(p) || statSync(p).isDirectory()) return json(res, 404, { error: "not found" });
    const size = statSync(p).size; const range = req.headers.range;
    const stream = (opts) => createReadStream(p, opts).on("error", (e) => { console.error("media:", e.message); res.destroy(); });
    if (range) { const [a, b] = range.replace("bytes=", "").split("-").map(Number); const end = b || size - 1; res.writeHead(206, { "content-type": contentType(rel), "content-range": `bytes ${a}-${end}/${size}`, "accept-ranges": "bytes", "content-length": end - a + 1 }); return stream({ start: a, end }).pipe(res); }
    res.writeHead(200, { "content-type": contentType(rel), "content-length": size, "accept-ranges": "bytes" }); return stream().pipe(res);
  }
  for (const [method, re, fn] of routes) {
    const m = url.pathname.match(re); if (!m || req.method !== method) continue;
    try { const body = method === "POST" ? await readBody(req) : {}; const out = await fn(m, body); return json(res, out == null ? 404 : 200, out ?? { error: "not found" }); }
    catch (err) { console.error(`[${method} ${url.pathname}]`, err.message); return json(res, 500, { error: err.message }); }
  }
  json(res, 404, { error: "not found" });
}).listen(PORT, () => console.log(`Likeness Reel backend on http://localhost:${PORT} · generators: ${JSON.stringify({ image: pick().image.name, video: pick().video.name })}`));
