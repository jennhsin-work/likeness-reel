// Image and video generation adapters. Each exposes the same two functions:
//   generateStill({ prompt, faceRel, bodyRel, aspect, outDir }) → { rel, provider }
//   animate({ stillRel, motionPrompt, seconds, aspect, outDir }) → { rel, provider }
// Real providers are selected by env keys; without them the "preview" adapters run,
// so the whole pipeline can be exercised (and its stills approved) before paying.
import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { mediaPath, saveBuffer, toDataUri, uid } from "../media.js";

const py = (script, args) => new Promise((resolve, reject) => {
  mkdirSync(dirname(args.at(-1)), { recursive: true }); // last arg is always the output path
  const p = spawn("python3", ["-I", script, ...args]); let out = "", err = "";
  p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
  p.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `${script} exited ${code}`))));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const download = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`download ${r.status}`); return Buffer.from(await r.arrayBuffer()); };

// ---- preview (no external API) ----------------------------------------------------
export const preview = {
  name: "preview",
  async generateStill({ prompt, faceRel, bodyRel, envRel, aspect, outDir, caption }) {
    const file = `${uid("still")}.jpg`;
    await py("scripts/compose_still.py", [mediaPath(faceRel), bodyRel ? mediaPath(bodyRel) : "-", envRel ? mediaPath(envRel) : "-", aspect, caption ?? "", mediaPath(`${outDir}/${file}`)]);
    return { rel: `${outDir}/${file}`, provider: "preview" };
  },
  async animate({ stillRel, seconds, motionPrompt, outDir }) {
    const file = `${uid("clip")}.mp4`;
    await py("scripts/kenburns.py", [mediaPath(stillRel), String(seconds), motionPrompt ?? "", mediaPath(`${outDir}/${file}`)]);
    return { rel: `${outDir}/${file}`, provider: "preview" };
  },
};

// ---- fal.ai: flux-pulid (identity-preserving stills) ---------------------------------
export const fal = {
  name: "fal",
  enabled: () => !!process.env.FAL_KEY,
  async generateStill({ prompt, faceRel, aspect, outDir }) {
    const headers = { Authorization: `Key ${process.env.FAL_KEY}`, "Content-Type": "application/json" };
    const image_size = aspect === "9:16" ? "portrait_16_9" : aspect === "1:1" ? "square_hd" : "landscape_16_9";
    const submit = await fetch("https://queue.fal.run/fal-ai/flux-pulid", { method: "POST", headers, body: JSON.stringify({ prompt, reference_image_url: toDataUri(faceRel), image_size, num_inference_steps: 24, guidance_scale: 4, id_weight: 1.05, true_cfg: 1, enable_safety_checker: true }) });
    if (!submit.ok) throw new Error(`fal submit ${submit.status}: ${await submit.text()}`);
    const { status_url, response_url } = await submit.json();
    for (let i = 0; i < 120; i++) {
      await sleep(2500);
      const s = await (await fetch(status_url, { headers })).json();
      if (s.status === "COMPLETED") { if (s.error) throw new Error(`fal: ${s.error}`); break; }
    }
    const out = await (await fetch(response_url, { headers })).json();
    const url = out.images?.[0]?.url; if (!url) throw new Error("fal: no image in result");
    const { rel } = saveBuffer(outDir, `${uid("still")}.jpg`, await download(url));
    return { rel, provider: "fal/flux-pulid" };
  },
};

// ---- Runway: image_to_video (gen4_turbo) ------------------------------------------------
export const runway = {
  name: "runway",
  enabled: () => !!process.env.RUNWAY_API_KEY,
  async animate({ stillRel, motionPrompt, seconds, aspect, outDir }) {
    const headers = { Authorization: `Bearer ${process.env.RUNWAY_API_KEY}`, "X-Runway-Version": "2024-11-06", "Content-Type": "application/json" };
    const ratio = aspect === "9:16" ? "720:1280" : aspect === "1:1" ? "960:960" : "1280:720";
    const r = await fetch("https://api.dev.runwayml.com/v1/image_to_video", { method: "POST", headers, body: JSON.stringify({ model: "gen4_turbo", promptImage: toDataUri(stillRel), promptText: motionPrompt.slice(0, 1000), ratio, duration: Math.max(2, Math.min(10, Math.round(seconds))) }) });
    if (!r.ok) throw new Error(`runway ${r.status}: ${await r.text()}`);
    const { id } = await r.json();
    for (let i = 0; i < 120; i++) {
      await sleep(5000);
      const t = await (await fetch(`https://api.dev.runwayml.com/v1/tasks/${id}`, { headers })).json();
      if (t.status === "SUCCEEDED") { const { rel } = saveBuffer(outDir, `${uid("clip")}.mp4`, await download(t.output[0])); return { rel, provider: "runway/gen4_turbo" }; }
      if (t.status === "FAILED" || t.status === "CANCELLED") throw new Error(`runway: ${t.failureCode ?? t.status} ${t.failure ?? ""}`);
    }
    throw new Error("runway: timed out");
  },
};

// ---- Luma Dream Machine: generations with a start keyframe ----------------------------
// Luma needs a public image URL (no data URIs); set PUBLIC_MEDIA_URL to a reachable base.
export const luma = {
  name: "luma",
  enabled: () => !!process.env.LUMA_API_KEY && !!process.env.PUBLIC_MEDIA_URL,
  async animate({ stillRel, motionPrompt, outDir }) {
    const headers = { Authorization: `Bearer ${process.env.LUMA_API_KEY}`, "Content-Type": "application/json", accept: "application/json" };
    const r = await fetch("https://api.lumalabs.ai/dream-machine/v1/generations", { method: "POST", headers, body: JSON.stringify({ prompt: motionPrompt, model: "ray-2", keyframes: { frame0: { type: "image", url: `${process.env.PUBLIC_MEDIA_URL}/${stillRel}` } } }) });
    if (!r.ok) throw new Error(`luma ${r.status}: ${await r.text()}`);
    const { id } = await r.json();
    for (let i = 0; i < 120; i++) {
      await sleep(5000);
      const g = await (await fetch(`https://api.lumalabs.ai/dream-machine/v1/generations/${id}`, { headers })).json();
      if (g.state === "completed") { const { rel } = saveBuffer(outDir, `${uid("clip")}.mp4`, await download(g.assets.video)); return { rel, provider: "luma/ray-2" }; }
      if (g.state === "failed") throw new Error(`luma: ${g.failure_reason ?? "failed"}`);
    }
    throw new Error("luma: timed out");
  },
};

export function pick() {
  const image = fal.enabled() ? fal : preview;
  const video = runway.enabled() ? runway : luma.enabled() ? luma : preview;
  return { image, video, mode: image === preview && video === preview ? "preview" : "live" };
}
