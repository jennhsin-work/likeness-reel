// The generation pipeline as background jobs:
//   analyze-footage -> describe-likeness -> plan -> still -> (qa) -> animate -> (qa) -> render
// Each handler reads and writes the project/profile documents; the UI polls them.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { db, uid, now } from "./db.js";
import { mediaPath, saveBuffer } from "./media.js";
import { register, enqueue, jobsFor } from "./jobs.js";
import * as claude from "./adapters/claude.js";
import { pick } from "./adapters/generators.js";

const run = (cmd, args) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args); let out = "", err = "";
  p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
  p.on("error", (e) => reject(new Error(`${cmd}: ${e.message}`)));
  p.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err.trim().split("\n").slice(-2).join(" ") || `${cmd} exited ${code}`))));
});
const py = (script, args) => run("python3", ["-I", script, ...args]);
const lastJson = (out) => JSON.parse(out.split("\n").filter((l) => l.startsWith("{")).at(-1));

// ---- shared helpers --------------------------------------------------------------
/** The user-approved reference photos, and which one leads. */
export function refs(prof) {
  const faces = prof.faces.filter((p) => p.approved !== false), bodies = prof.bodies.filter((p) => p.approved !== false);
  return { faces, bodies, face: faces.find((p) => p.id === prof.primaryFaceId) ?? faces[0] ?? null, body: bodies.find((p) => p.id === prof.primaryBodyId) ?? bodies[0] ?? null };
}
export const DEFAULT_SETTINGS = { captions: true, titleCard: true, music: "auto", mood: "warm", musicRel: null, musicName: null, narration: false, voice: "Samantha" };
export function renumber(proj) { proj.shots.forEach((s, i) => (s.n = i + 1)); return proj; }
export function newShot(fields) {
  return { id: uid("shot"), n: 0, title: "New shot", seconds: 4, source: "generate", footageId: null, startSec: 0, fit: "contain", setting: "", action: "", framing: "medium shot", cameraMotion: "slow push in", outfit: "", inspirationIds: [], stillPrompt: "[LIKENESS] ", motionPrompt: "Slow push in. The subject moves naturally.", caption: "", narration: "", still: null, clip: null, approved: false, critique: null, clipCritique: null, history: [], ...fields };
}
/** Queue a job unless an identical one is already waiting (or, by default, running).
 *  Pass { whileRunning: true } for jobs whose input document can change under a running
 *  job - e.g. likeness notes while more photos are still arriving. */
export function enqueueOnce(type, input, { whileRunning = false, ...opts } = {}) {
  const key = JSON.stringify(input);
  const same = jobsFor((j) => j.type === type && (j.status === "queued" || (!whileRunning && j.status === "running")) && JSON.stringify(j.input) === key);
  return same[0] ?? enqueue(type, input, opts);
}
async function extractFrames(srcRel, outDirRel, prefix, n) {
  const out = await py("scripts/frames.py", [mediaPath(srcRel), mediaPath(outDirRel), prefix, String(n)]);
  return { frames: out.split("\n").filter((l) => l && !l.startsWith("#")).map((p) => p.replace(/^.*?data\//, "")), duration: +(out.match(/#duration=([\d.]+)/)?.[1] ?? 0) };
}

// ---- footage analysis ---------------------------------------------------------------
register("analyze-footage", async ({ profileId, footageId }, progress) => {
  const prof = db.profiles.get(profileId); const f = prof?.footage.find((x) => x.id === footageId);
  if (!f) return null;                                              // deleted while queued
  progress(0.15, "Extracting frames");
  const { frames, duration } = await extractFrames(f.rel, `profiles/${profileId}/frames`, f.id, 4);
  f.frames = frames; f.durationSec = duration || f.durationSec || 0; db.profiles.put(prof);
  progress(0.5, "Describing the scene");
  try { f.analysis = await claude.analyzeFrames(f.frames, { filename: f.originalName, usage: f.usage }); f.status = "ready"; f.error = null; }
  catch (e) { f.status = "failed"; f.error = e.message; db.profiles.put(prof); throw e; }
  db.profiles.put(prof); return f.analysis;
});

// ---- likeness notes -------------------------------------------------------------------
register("describe-likeness", async ({ profileId }, progress) => {
  const prof = db.profiles.get(profileId); if (!prof) return null;
  const r = refs(prof);
  if (!r.faces.length) { prof.likeness = null; db.profiles.put(prof); return null; }
  progress(0.3, "Studying your reference photos");
  const lk = await claude.describeLikeness(r.faces.map((x) => x.rel), r.bodies.map((x) => x.rel));
  const fresh = db.profiles.get(profileId); if (!fresh) return null;
  if (!fresh.primaryFaceByUser) fresh.primaryFaceId = r.faces[Math.max(0, Math.min(r.faces.length - 1, lk.bestFaceRef))]?.id ?? null;
  if (!fresh.primaryBodyByUser) fresh.primaryBodyId = r.bodies[lk.bestBodyRef]?.id ?? r.bodies[0]?.id ?? null;
  fresh.likeness = { description: lk.description, bodyProportions: lk.bodyProportions, signatureStyle: lk.signatureStyle, edited: false, updatedAt: now() };
  db.profiles.put(fresh); return fresh.likeness;
});

// ---- shot planning --------------------------------------------------------------------
register("plan", async ({ projectId }, progress) => {
  const proj = db.projects.get(projectId); if (!proj) return null;
  const prof = db.profiles.get(proj.profileId);
  if (!prof?.likeness) throw new Error("invalid: the profile has no likeness notes yet");
  progress(0.2, "Planning the shot list");
  const ready = prof.footage.filter((f) => f.status === "ready");
  const plan = await claude.planShots({ request: proj.request, durationSec: proj.durationSec, likeness: prof.likeness, footage: ready });
  const exact = ready.filter((f) => f.usage === "exact");
  let shots = plan.shots.map((s) => {
    const shot = newShot({ ...s });
    if (shot.source === "footage") {
      const f = ready.find((x) => x.id === shot.footageId) ?? exact[0] ?? null;
      if (f) { shot.footageId = f.id; shot.approved = true; } else { shot.source = "generate"; shot.footageId = null; }
    }
    if (shot.source === "generate" && !shot.stillPrompt.includes("[LIKENESS]")) shot.stillPrompt = `[LIKENESS] ${shot.stillPrompt}`.trim();
    return shot;
  });
  // make the shots add up to the requested length (the planner is usually close)
  const total = shots.reduce((a, s) => a + s.seconds, 0) || 1; const k = proj.durationSec / total;
  if (Math.abs(k - 1) > 0.04) shots = shots.map((s) => ({ ...s, seconds: Math.max(2, Math.min(8, Math.round(s.seconds * k * 2) / 2)) }));
  const fresh = db.projects.get(projectId); if (!fresh) return null;
  Object.assign(fresh, { title: plan.title || fresh.request.slice(0, 40), logline: plan.logline, music: plan.music, shots, render: null, status: "planned" });
  fresh.settings = { ...DEFAULT_SETTINGS, ...fresh.settings, mood: fresh.settings?.moodByUser ? fresh.settings.mood : plan.musicMood };
  db.projects.put(renumber(fresh)); return { shots: shots.length };
});

// ---- stills (the cheap checkpoint) -----------------------------------------------------
register("still", async ({ projectId, shotId }, progress) => {
  const proj = db.projects.get(projectId); const shot = proj?.shots.find((s) => s.id === shotId); if (!shot) return null;
  const prof = db.profiles.get(proj.profileId); const r = refs(prof);
  if (!r.face) throw new Error("invalid: no approved face reference");
  const { image } = pick();
  const prompt = shot.stillPrompt.replace(/\[LIKENESS\]/g, prof.likeness?.description ?? "the person");
  const usable = prof.footage.filter((f) => f.frames?.length);
  const env = usable.find((f) => shot.inspirationIds.includes(f.id)) ?? usable.find((f) => f.usage === "inspiration") ?? usable[0];
  progress(0.25, `Generating with ${image.label}`);
  const res = await image.generateStill({ prompt, faceRel: r.face.rel, bodyRel: r.body?.rel ?? null, envRel: env?.frames?.[0] ?? null, aspect: proj.aspect, framing: shot.framing, outDir: `projects/${projectId}/stills`, seed: shot.history.length + shot.n * 7 });
  const fresh = db.projects.get(projectId); const s = fresh?.shots.find((x) => x.id === shotId); if (!s) return null;
  if (s.still) s.history.push(s.still);
  s.still = { ...res, prompt, createdAt: now() };
  Object.assign(s, { approved: false, critique: null, clip: null, clipCritique: null });   // a new still invalidates what came after it
  db.projects.put(fresh);
  if (image.name !== "preview") enqueue("qa", { projectId, shotId, target: "still" }, { label: `check still: ${s.title}`, maxAttempts: 2 });
  return s.still;
});

// ---- QA: likeness drift, body distortion, scene errors ----------------------------------
register("qa", async ({ projectId, shotId, target }, progress) => {
  const proj = db.projects.get(projectId); const shot = proj?.shots.find((s) => s.id === shotId); if (!shot) return null;
  const prof = db.profiles.get(proj.profileId); const face = refs(prof).face;
  if (!face) throw new Error("invalid: no approved face reference");
  let result;
  if (target === "clip") {
    if (!shot.clip) throw new Error("invalid: no clip to check");
    progress(0.2, "Sampling frames");
    const { frames } = await extractFrames(shot.clip.rel, `projects/${projectId}/qa`, `${shot.id}_${Date.now().toString(36)}`, 3);
    progress(0.5, "Checking for drift and distortion");
    result = await claude.critiqueClip({ frameRels: frames, faceRel: face.rel, shot });
  } else {
    if (!shot.still) throw new Error("invalid: no still to check");
    progress(0.4, "Comparing with your reference");
    result = await claude.critiqueStill({ stillRel: shot.still.rel, faceRel: face.rel, shot });
  }
  const fresh = db.projects.get(projectId); const s = fresh?.shots.find((x) => x.id === shotId); if (!s) return null;
  const stamped = { ...result, checkedAt: now(), of: target === "clip" ? s.clip?.rel : s.still?.rel };
  if (target === "clip") s.clipCritique = stamped; else s.critique = stamped;
  db.projects.put(fresh); return stamped;
});

// ---- animation ---------------------------------------------------------------------
register("animate", async ({ projectId, shotId }, progress) => {
  const proj = db.projects.get(projectId); const shot = proj?.shots.find((s) => s.id === shotId); if (!shot) return null;
  if (!shot.still) throw new Error("invalid: generate and approve a still first");
  if (!shot.approved) throw new Error("invalid: the still has not been approved");
  const { video } = pick();
  progress(0.2, `Animating with ${video.label}`);
  const res = await video.animate({ stillRel: shot.still.rel, motionPrompt: shot.motionPrompt, seconds: shot.seconds, aspect: proj.aspect, outDir: `projects/${projectId}/clips` });
  const fresh = db.projects.get(projectId); const s = fresh?.shots.find((x) => x.id === shotId); if (!s) return null;
  s.clip = { ...res, of: s.still?.rel, createdAt: now() }; s.clipCritique = null; db.projects.put(fresh);
  if (video.name !== "preview") enqueue("qa", { projectId, shotId, target: "clip" }, { label: `check clip: ${s.title}`, maxAttempts: 2 });
  return s.clip;
});

// ---- render: picture (OpenCV) + audio mix (numpy / say) + mux (AVFoundation) -------------
register("render", async ({ projectId }, progress) => {
  const proj = db.projects.get(projectId); if (!proj) return null;
  const prof = db.profiles.get(proj.profileId); const settings = { ...DEFAULT_SETTINGS, ...proj.settings };
  const used = [];
  const segments = proj.shots.map((s) => {
    const base = { seconds: s.seconds, caption: s.caption || "" };
    if (s.source === "footage") {
      const f = prof.footage.find((x) => x.id === s.footageId);
      if (!f) return null;
      used.push(s); return { ...base, kind: f.kind === "photo" ? "still" : "footage", path: mediaPath(f.rel), start: s.startSec || 0, fit: s.fit || "contain" };
    }
    if (s.clip) { used.push(s); return { ...base, kind: "clip", path: mediaPath(s.clip.rel), fit: "cover" }; }
    if (s.still && s.approved) { used.push(s); return { ...base, kind: "still", path: mediaPath(s.still.rel), fit: "cover" }; }
    return null;
  }).filter(Boolean);
  if (!segments.length) throw new Error("invalid: nothing to render yet - approve a still or add footage");
  const dir = `projects/${projectId}/renders`; const id = uid("reel");
  const spec = saveBuffer(dir, `${id}.spec.json`, Buffer.from(JSON.stringify({ title: proj.title, titleCard: settings.titleCard, captions: settings.captions, aspect: proj.aspect, segments })));
  progress(0.15, "Rendering the picture");
  const picture = `${dir}/${id}.silent.mp4`;
  const timeline = lastJson(await py("scripts/render.py", [spec.path, mediaPath(picture)]));
  let rel = picture, audio = { music: "none", narration: 0 }, note = null;
  const wantsAudio = settings.music !== "none" || settings.narration;
  if (wantsAudio) {
    try {
      progress(0.6, "Mixing music and narration");
      const narration = settings.narration ? used.map((s, i) => ({ text: s.narration, at: (timeline.segments[i]?.at ?? 0) + 0.35 })).filter((n) => n.text) : [];
      const music = settings.music === "none" ? { mode: "none" } : settings.music === "upload" && settings.musicRel ? { mode: "file", path: mediaPath(settings.musicRel), mood: settings.mood } : { mode: "synth", mood: settings.mood };
      const aspec = saveBuffer(dir, `${id}.audio.json`, Buffer.from(JSON.stringify({ duration: timeline.duration, music, narration, voice: settings.voice })));
      const wav = mediaPath(`${dir}/${id}.wav`);
      audio = lastJson(await py("scripts/audio.py", [aspec.path, wav]));
      progress(0.85, "Finishing the file");
      await run("swift", ["scripts/mux.swift", mediaPath(picture), wav, mediaPath(`${dir}/${id}.mp4`)]);
      if (existsSync(mediaPath(`${dir}/${id}.mp4`))) rel = `${dir}/${id}.mp4`;
    } catch (e) { note = `Rendered without sound: ${e.message}`; audio = { music: "none", narration: 0 }; }
  }
  const fresh = db.projects.get(projectId); if (!fresh) return null;
  fresh.render = { rel, createdAt: now(), segments: segments.length, duration: timeline.duration, audio, note, stale: false };
  fresh.status = "rendered"; db.projects.put(fresh); return fresh.render;
});
