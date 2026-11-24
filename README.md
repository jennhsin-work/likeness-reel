# Morsy 2.0

*Working name. The repo and package are still `likeness-reel`.*

**Upload your face and a few clips of your world. Describe a video. Get a short reel starring you.**

A prototype of a reusable *digital-likeness profile* connected to a video-generation pipeline. It keeps three things separate: **who you are** (the likeness profile), **what your world looks like** (environment and lifestyle footage), and **what happens in the video** (the shot list). It is built on existing models: no custom training, no 3D reconstruction.

```
Likeness profile                         Your world
  face + full-body photos                  clips and photos
  approved references, lead reference      frames (OpenCV) -> scene notes (vision model)
  appearance notes (vision model, editable)  inspiration | exact
  consent                                        |
        \_______________________  ______________/
                                \/
   Request -> planner -> shot list: generate (starring you) | footage (your clip)
                                |
   Still per generated shot  -> you approve it        <- the cheap checkpoint
                                |
   Animate approved stills   -> image-to-video
                                |
   QA: likeness drift, body distortion, scene errors -> regenerate what fails
                                |
   Render: clips + your footage + captions + title + music + narration -> reel.mp4
```

## Run it

```bash
npm install
cp .env.example .env     # set ANTHROPIC_API_KEY, or sign in once with `ant auth login`
npm run server           # backend on 127.0.0.1:8790
npm run dev              # UI on http://localhost:5174
```

Requirements: Node 20+, Python 3 with `opencv-python`, `numpy`, `scipy` and `pillow`. Sound (music mix, narration, muxing) uses tools that ship with macOS: `say`, `afconvert` and Swift with AVFoundation. On other systems the reel still renders, without sound.

### Preview mode and live mode

With no generator keys the app runs in **preview mode**, which is free and local:

- a still is you, cut out of your own reference photo and placed in a frame from your footage, framed to match the shot (wide, medium, close-up);
- "animation" is camera parallax over those two layers.

This is deliberately not a generated likeness. It exists so the whole flow can be used, judged and demoed before any money is spent. Add keys to `.env` and the same buttons call real models:

| key | what it turns on |
|---|---|
| `FAL_KEY` | stills with fal `flux-pulid` (identity-preserving) |
| `RUNWAY_API_KEY` | video with Runway `gen4_turbo` image-to-video; also stills with `gen4_image` from tagged face, body and place references when no `FAL_KEY` is set |
| `LUMA_API_KEY` + `PUBLIC_MEDIA_URL` | video with Luma `ray-2` (Luma needs a publicly reachable image URL) |

The live adapters are written from the providers' API documentation and **have not been run against the real services yet**. Expect to adjust them on first contact. Cost figures shown in the UI are rough list-price estimates; override them with `PRICE_STILL` and `PRICE_VIDEO_SEC`.

## The four steps

1. **Your likeness.** Several face photos and at least one full-body photo (JPEG, PNG, WebP or iPhone HEIC). Every ticked photo is an approved reference; the starred one leads, chosen by the model until you pick your own. A vision model writes neutral appearance notes, which you can edit. Nothing is planned or generated until consent is given, and one button deletes the profile with every photo, clip, still and reel.
2. **Your world.** Clips and photos are sampled into frames and described: location, objects, lighting, activity, camera movement, palette, shot ideas. Each is marked **Inspiration** (may be reinterpreted in generated shots) or **Exact** (appears in the reel as uploaded). Originals are kept for the edit.
3. **Create.** One sentence, a length and a format. The planner returns a title, a logline, a music brief and a shot list that mixes generated shots with your footage and adds up to the requested length.
4. **Review and render.**
   - Each generated shot gets a still. Compare it with your reference, edit the prompt, regenerate, restore an earlier version, then approve. Animation is refused until the still is approved.
   - *Check likeness* and *Check clip* ask the vision model for a likeness score, distortion and scene errors, and a verdict. In live mode this runs automatically after every generation.
   - Edit titles, lengths, captions and narration lines; reorder, remove or add shots; choose where a clip starts and whether it keeps its whole frame or fills the format.
   - Finishing options: title card, captions, composed music (warm, upbeat, calm) or your own track, and spoken narration.
   - The reel is assembled, then downloadable. If the shot list changes afterwards it is marked out of date.

## Backend

| path | what |
|---|---|
| `server/index.js` | HTTP API bound to localhost, streaming uploads, media serving with range requests |
| `server/pipeline.js` | the jobs: `analyze-footage`, `describe-likeness`, `plan`, `still`, `qa`, `animate`, `render` |
| `server/jobs.js` | background queue: concurrency, retries with backoff, progress, resume after restart |
| `server/db.js` | JSON document store: profiles, projects, jobs |
| `server/media.js` | private media store under `data/`; HEIC conversion |
| `server/adapters/claude.js` | scene analysis, likeness notes, shot planning, still and clip QA (prompted JSON, repaired with zod) |
| `server/adapters/generators.js` | `preview`, `fal`, `runwayImage`, `runway`, `luma`, and cost estimates |
| `scripts/compose_still.py` | preview stills: subject cut-out, environment plate, framing, grade |
| `scripts/kenburns.py` | preview motion: two-layer parallax |
| `scripts/render.py` | picture assembly: clips, footage, title card, captions, crossfades |
| `scripts/audio.py` | music bed (synthesised or your track) and narration, with ducking |
| `scripts/mux.swift` | attaches the audio with AVFoundation and writes the final MP4 |
| `scripts/frames.py`, `scripts/samples.py` | frame extraction; synthetic sample assets |

## Tests

```bash
npm test          # unit checks: no backend, no network
npm run smoke     # full pipeline against a running backend, using synthetic samples
```

The smoke test walks profile, consent, uploads, analysis, planning, stills, approval, animation and a render with music and narration, checks the guards (no generation without consent, no animation without approval, bad uploads refused), then deletes its profile.

## Privacy

Media stays on local disk under `data/` (gitignored). The server listens on localhost only and serves media to the local UI. Consent is recorded with a timestamp and enforced by the API. Deleting a profile removes its photos, footage, frames, projects, stills, clips and renders. In live mode, reference photos are sent to the generation providers you configured, and frames are sent to the vision model for analysis and QA.

## What this prototype is not, yet

- **Proven likeness.** Fidelity depends on the image and video models. References help but do not guarantee an exact replica, which is why stills are approved before animation and QA flags drift. This is the first thing to test with real keys.
- **Multi-user.** One profile per machine, no accounts, a JSON file for a database and a local folder for storage.
- **Guarded.** No check that an uploaded face belongs to the uploader, no moderation, no rate limits, no payments.
- **Scored.** Music is a simple synthesised bed, or your own track.
