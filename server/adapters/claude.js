// Claude adapter: scene analysis (vision), likeness notes, shot planning, and
// still-image prompt composition. Prompted JSON validated with zod.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { imageBlock } from "../media.js";

const MODEL = process.env.MODEL || "claude-opus-5-5";
const client = new Anthropic();

async function json(schema, system, content, { effort = "low", maxTokens = 8000 } = {}) {
  const res = await client.messages.stream({
    model: MODEL, max_tokens: maxTokens, system, thinking: { type: "adaptive" }, output_config: { effort },
    messages: [{ role: "user", content: [...content, { type: "text", text: "Respond with ONLY a JSON object (no prose, no code fence) using exactly the keys requested." }] }],
  }).finalMessage();
  if (res.stop_reason === "refusal") throw new Error(`Model declined: ${res.stop_details?.explanation ?? "refusal"}`);
  const text = res.content.find((b) => b.type === "text")?.text ?? "";
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  let obj; try { obj = JSON.parse(text.slice(a, b + 1)); } catch { throw new Error(`model did not return JSON: ${text.slice(0, 80)}`); }
  const parsed = schema.safeParse(obj);
  if (!parsed.success) { const i = parsed.error.issues[0]; throw new Error(`schema: ${i?.path?.join(".")} ${i?.message} (got keys ${Object.keys(obj).join(",")})`); }
  return parsed.data;
}

// ---- footage / photo analysis ---------------------------------------------------
const str = () => z.string().default("");
const list = (n) => z.array(z.string()).default([]).transform((a) => a.slice(0, n)); // truncate, never reject
export const SceneAnalysis = z.object({
  summary: str(),
  location: str(), setting: z.enum(["indoor", "outdoor", "mixed", "unknown"]).default("unknown"),
  objects: list(12), lighting: str(), timeOfDay: str(),
  activity: str(), cameraMovement: str(), mood: str(),
  colorPalette: list(5), peopleVisible: z.boolean().default(false),
  bestForShots: list(4).describe("shot ideas this footage supports"),
});
export async function analyzeFrames(frameRels, { filename, usage }) {
  const out = await json(SceneAnalysis, "You describe short lifestyle clips for a video-planning system. Be concrete and visual. The frames may be illustrations or synthetic test footage — describe what is depicted either way.",
    [...frameRels.slice(0, 4).map(imageBlock), { type: "text", text: `These are representative frames from "${filename}" (marked for ${usage === "exact" ? "exact use in the final edit" : "visual inspiration"}). Return exactly these keys: summary (one sentence), location, setting (indoor|outdoor|mixed|unknown), objects (array), lighting, timeOfDay, activity, cameraMovement, mood, colorPalette (array of hex or names), peopleVisible (boolean), bestForShots (array of shot ideas).` }]);
  if (!out.summary) out.summary = [out.activity, out.location].filter(Boolean).join(" — ") || "footage";
  return out;
}

// ---- likeness notes (what to preserve across shots) -------------------------------
export const Likeness = z.object({
  description: z.string().describe("neutral, factual appearance description for generation prompts: hair, skin tone, face shape, distinguishing features, build, height impression"),
  bodyProportions: str(), signatureStyle: str().describe("typical outfit/style cues seen in the photos"),
  bestFaceRef: z.number().int().default(0).describe("index of the clearest frontal face photo"),
  bestBodyRef: z.number().int().default(-1).describe("index of the clearest full-body photo, or -1"),
});
export async function describeLikeness(faceRels, bodyRels) {
  return json(Likeness, "You write neutral appearance descriptions used to keep a person's likeness consistent across generated images. No judgments, no guesses about identity, age ranges only. The photos may be illustrations or test images — describe whatever is depicted. Always return every field: description, bodyProportions, signatureStyle, bestFaceRef, bestBodyRef.",
    [{ type: "text", text: `Face photos (${faceRels.length}):` }, ...faceRels.slice(0, 5).map(imageBlock), { type: "text", text: `Full-body photos (${bodyRels.length}):` }, ...bodyRels.slice(0, 3).map(imageBlock), { type: "text", text: "Describe this person for generation prompts and pick the best references (face index among the face photos; body index among the body photos)." }]);
}

// ---- shot planning -----------------------------------------------------------------
export const Shot = z.object({
  n: z.number().int().default(0), title: str(), seconds: z.number().min(1).max(8).default(4),
  source: z.enum(["generate", "footage"]).default("generate"),
  footageId: z.string().nullable().default(null).describe("id of the uploaded footage to use when source=footage"),
  setting: str(), action: str(), framing: str(), cameraMotion: str(),
  outfit: str(), inspirationIds: list(3),
  stillPrompt: str().describe("complete image-generation prompt for the starting frame; describe the person via [LIKENESS], environment, outfit, pose, lens, light"),
  motionPrompt: str().describe("short image-to-video instruction: subject motion + camera motion, 1-2 sentences"),
});
export const Plan = z.object({ title: str(), logline: str(), music: str(), shots: z.array(Shot).min(1).transform((a) => a.slice(0, 6)) });
export async function planShots({ request, durationSec, likeness, footage }) {
  const fo = footage.map((f) => `- id ${f.id} [${f.usage}] ${f.kind}: ${f.analysis?.summary ?? f.originalName} · ${f.analysis?.location ?? ""} · ${f.analysis?.activity ?? ""} · supports: ${(f.analysis?.bestForShots ?? []).join("; ")}`).join("\n");
  return json(Plan, `You are a director planning a short personal lifestyle reel. The star is a real person (their likeness profile is given) — every "generate" shot must feature them, described in prompts as [LIKENESS] (the system substitutes the appearance notes). Footage marked [exact] must be used as-is via source=footage; footage marked [inspiration] may be reinterpreted in generated shots (reference it by id in inspirationIds). Alternate generated and footage shots for rhythm; total duration must match. Keep generated shots simple and controllable: one person, clear single action, steady or slow camera moves.`,
    [{ type: "text", text: `Request: "${request}"\nTotal duration: ${durationSec} s\nLikeness: ${likeness.description}. Build: ${likeness.bodyProportions}. Style: ${likeness.signatureStyle}\nUploaded footage:\n${fo || "(none)"}\n\nReturn exactly these keys: title, logline, music, shots. Each shot has exactly: n, title, seconds (number), source ("generate"|"footage"), footageId (string or null), setting, action, framing, cameraMotion, outfit, inspirationIds (array of footage ids), stillPrompt, motionPrompt.` }], { effort: "medium" });
}

// ---- shot critique (likeness drift, distortion, scene errors) ------------------------
export const Critique = z.object({ likenessScore: z.number().min(0).max(1), bodyOk: z.boolean().default(true), sceneOk: z.boolean().default(true), issues: list(6), verdict: z.enum(["approve", "regenerate"]) });
export async function critiqueStill({ stillRel, faceRel, shot }) {
  return json(Critique, "You QA generated frames for a personalized video. Compare the generated frame to the reference face photo. Be strict about likeness, body distortion (extra limbs, warped hands), and whether the scene matches the shot description.",
    [{ type: "text", text: "Reference face:" }, imageBlock(faceRel), { type: "text", text: "Generated frame:" }, imageBlock(stillRel), { type: "text", text: `Shot: ${shot.title} — ${shot.setting}; ${shot.action}; ${shot.framing}.` }]);
}
