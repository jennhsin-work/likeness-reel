# Likeness Reel

**Upload your face and a few clips of your world. Describe a video. Get a short reel starring you.**

A prototype of a reusable *digital-likeness profile* connected to a video-generation pipeline. It separates three things: **who the user is** (likeness profile), **what their world looks like** (environment/lifestyle footage), and **what happens in the video** (the shot list). Built with existing models — no custom training, no 3D reconstruction.

```
Profile ──► likeness notes (Claude vision)      Footage ──► frames (OpenCV) ──► scene notes (Claude vision)
   │  face photos · body photos · consent            │  inspiration | exact
   └──────────────────────┬──────────────────────────┘
                          ▼
   Request ──► Planner (Claude) ──► shot list: generate | footage, per-shot still + motion prompts
                          ▼
   Stills  ──► image adapter (fal flux-pulid  | preview compositor) ──► QA critique vs. reference face
                          ▼  user approves each still (the cheap checkpoint)
   Clips   ──► video adapter (Runway gen4_turbo | Luma ray-2 | preview Ken Burns)
                          ▼
   Render  ──► OpenCV assembler: clips + user footage + captions + fades ──► reel.mp4
```

## Run

```bash
npm install
cp .env.example .env     # add ANTHROPIC_API_KEY (or use `ant auth login`); generator keys optional
npm run server           # backend on :8790 — jobs, media, adapters
npm run dev              # UI on :5174
```

Without `FAL_KEY` / `RUNWAY_API_KEY` / `LUMA_API_KEY` the app runs in **preview mode**: stills are compositions of the user's real face over a reference frame, and "animation" is a Ken Burns move — so the whole workflow (profile → plan → approve → animate → render) can be exercised and demoed before spending on generation. Add keys and the same buttons call the real models.

`python3 -I scripts/samples.py data/samples` generates synthetic sample assets (illustrated face/body, a café clip, a street photo) for testing without personal media.

## The four steps in the UI

1. **Your likeness** — several face photos (angles) + full-body photos; the vision model writes neutral appearance notes and picks reference images; consent checkbox; *delete profile & all media*.
2. **Your world** — clips/photos; each is sampled to frames and described (location, objects, lighting, activity, camera movement, shot ideas); mark **inspiration** (may be reinterpreted) or **exact** (must appear as uploaded).
3. **Create** — one-sentence request, length, format → planner returns a title, logline and 2–6 shots mixing `generate` (starring the user) and `footage` (your clips).
4. **Review & render** — per shot: editable still prompt, *Generate still*, QA note (likeness score / distortion / scene), *Approve*, *Animate*; then *Assemble the reel* and download.

## Backend layout

| path | what |
|---|---|
| `server/index.js` | HTTP API, job handlers (analyze-footage, describe-likeness, plan, still, animate, render), media serving with range requests |
| `server/db.js` | JSON document store (profiles, projects, jobs) |
| `server/media.js` | private media store under `data/`, base64 helpers |
| `server/jobs.js` | background queue: concurrency, retries with backoff, progress notes, resume after restart |
| `server/adapters/claude.js` | vision analysis, likeness notes, shot planning, still critique (prompted JSON + zod) |
| `server/adapters/generators.js` | `preview`, `fal` (flux-pulid stills), `runway` (gen4_turbo image-to-video), `luma` (ray-2) |
| `scripts/frames.py` | frame extraction |
| `scripts/compose_still.py` | preview-mode still compositor (face detection + environment plate) |
| `scripts/kenburns.py` | preview-mode animation |
| `scripts/render.py` | final assembly |

## Privacy

Media stays on local disk under `data/` (gitignored) and is only served to the local UI. Consent is recorded with a timestamp; deleting a profile removes its photos, footage, frames, projects, stills, clips and renders.

## Known limits

- Likeness fidelity depends entirely on the image/video models; references help but don't guarantee an exact replica — that's why stills are approved before animation and the QA critique flags drift.
- Luma needs a publicly reachable image URL (`PUBLIC_MEDIA_URL`); Runway and fal accept data URIs.
- Preview mode never produces a convincing likeness by design.
