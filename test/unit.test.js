// Fast checks that need no backend and no network: `npm test`.
import test from "node:test";
import assert from "node:assert/strict";
process.env.DATA_DIR = "data/_test"; process.env.ANTHROPIC_API_KEY ||= "test-key-not-used";

const { Plan, Likeness, Critique, SceneAnalysis } = await import("../server/adapters/claude.js");
const { estimate, pick } = await import("../server/adapters/generators.js");
const { refs, renumber, newShot } = await import("../server/pipeline.js");
const { rmSync } = await import("node:fs");
test.after(() => { rmSync("data/_test", { recursive: true, force: true }); setTimeout(() => process.exit(0), 50); });

test("model output is repaired, not rejected", () => {
  const plan = Plan.parse({ title: null, shots: [{ seconds: "long", source: "cgi", footageId: 7 }, {}] });
  assert.equal(plan.title, ""); assert.equal(plan.musicMood, "warm");
  assert.deepEqual(plan.shots.map((s) => [s.seconds, s.source, s.footageId]), [[4, "generate", null], [4, "generate", null]]);
  assert.equal(Likeness.parse({ description: "tall", bestBodyRef: null }).bestBodyRef, -1);
  assert.equal(Critique.parse({ likenessScore: 7 }).verdict, "regenerate");
  assert.equal(SceneAnalysis.parse({ colorPalette: ["a", "b", "c", "d", "e", "f", "g"] }).colorPalette.length, 5);
});
test("a plan needs at least one shot and keeps at most six", () => {
  assert.throws(() => Plan.parse({ shots: [] }));
  assert.equal(Plan.parse({ shots: Array(9).fill({}) }).shots.length, 6);
});
test("only approved photos are references; the user's choice leads", () => {
  const prof = { faces: [{ id: "a", rel: "a.jpg" }, { id: "b", rel: "b.jpg", approved: false }, { id: "c", rel: "c.jpg" }], bodies: [], primaryFaceId: "c" };
  const r = refs(prof);
  assert.deepEqual(r.faces.map((f) => f.id), ["a", "c"]); assert.equal(r.face.id, "c"); assert.equal(r.body, null);
  prof.primaryFaceId = "b"; assert.equal(refs(prof).face.id, "a", "an excluded photo cannot lead");
});
test("shots renumber in order and start unapproved", () => {
  const proj = renumber({ shots: [newShot({ title: "x" }), newShot({ title: "y" })] });
  assert.deepEqual(proj.shots.map((s) => s.n), [1, 2]); assert.equal(proj.shots[0].approved, false); assert.notEqual(proj.shots[0].id, proj.shots[1].id);
});
test("preview mode is free and says so", () => {
  for (const k of ["FAL_KEY", "RUNWAY_API_KEY", "LUMA_API_KEY"]) delete process.env[k];
  assert.equal(pick().mode, "preview");
  assert.equal(estimate({ stills: 3, videoSeconds: 12 }).total, 0);
  process.env.RUNWAY_API_KEY = "x";
  const e = estimate({ stills: 2, videoSeconds: 10 }); assert.equal(e.mode, "live"); assert.ok(e.total > 0 && e.videoCost === 0.5);
  delete process.env.RUNWAY_API_KEY;
});
