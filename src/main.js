// Morsy 2.0 UI: four steps over the local backend. No framework - the server
// documents (profile, project) are the state; the UI polls them and patches only
// the cards whose data changed, so videos keep playing and inputs keep focus.

// ---- tiny helpers ----------------------------------------------------------------
const $ = (s, el = document) => el.querySelector(s), $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const media = (rel) => `/media/${rel}`;
const money = (n) => (n < 0.005 ? "free" : `about $${n.toFixed(2)}`);
const ICON = {
  check: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3L13 4.5"/></svg>',
  star: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.6l1.9 4 4.4.5-3.3 3 .9 4.3L8 11.3l-3.9 2.1.9-4.3-3.3-3 4.4-.5z"/></svg>',
  trash: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/></svg>',
  left: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3L5 8l5 5"/></svg>',
  right: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3l5 5-5 5"/></svg>',
};

async function api(method, path, body) {
  const r = await fetch(path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : method === "POST" ? "{}" : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${r.status} ${r.statusText}`);
  return j;
}
function toast(message, ok = false) {
  const el = Object.assign(document.createElement("div"), { className: `toast${ok ? " ok" : ""}`, textContent: message });
  $("#toasts").append(el); setTimeout(() => el.remove(), ok ? 2600 : 6000);
}
/** Run an action; surface any error as a toast instead of failing silently. */
const act = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message); } };

/** Keyed list patching: reuse a card's DOM node unless its data changed. */
function syncList(container, items, key, html) {
  const old = new Map($$(":scope > [data-key]", container).map((n) => [n.dataset.key, n]));
  let prev = null;
  for (const item of items) {
    const k = String(key(item)); const markup = html(item); let node = old.get(k); old.delete(k);
    const editing = node && node.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if (!node || (node._markup !== markup && !editing)) {
      const fresh = document.createElement("template"); fresh.innerHTML = markup.trim();
      const el = fresh.content.firstElementChild; el.dataset.key = k; el._markup = markup;
      if (node) node.replaceWith(el); node = el;
    }
    const want = prev ? prev.nextSibling : container.firstChild;
    if (node !== want) container.insertBefore(node, want);
    prev = node;
  }
  for (const n of old.values()) n.remove();
}
const segValue = (id) => $(`#${id} .on`)?.dataset.v;
function bindSeg(id, onChange) {
  $(`#${id}`).addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; $$(`#${id} button`).forEach((x) => x.classList.toggle("on", x === b)); onChange?.(b.dataset.v); });
}

// ---- state ---------------------------------------------------------------------------
const state = { health: null, profile: null, project: null, projects: [], step: "profile" };
const ui = { view: {}, open: {}, uploading: {} };          // per-card UI state that is not server data
const STEPS = ["profile", "world", "create", "review"];
const activeJobs = (doc) => (doc?.jobs ?? []).filter((j) => j.status === "queued" || j.status === "running");
const failedJobs = (doc) => (doc?.jobs ?? []).filter((j) => j.status === "failed");

function go(step) {
  state.step = STEPS.includes(step) ? step : "profile";
  if (location.hash.slice(1) !== state.step) history.replaceState(null, "", `#${state.step}`);
  $$("main section").forEach((s) => (s.hidden = s.dataset.panel !== state.step));
  window.scrollTo(0, 0); render();
}
$$("#steps button").forEach((b) => (b.onclick = () => go(b.dataset.step)));
document.addEventListener("click", (e) => { const b = e.target.closest("[data-go]"); if (b) go(b.dataset.go); });

// ---- header ------------------------------------------------------------------------
function renderHeader() {
  const p = state.profile, j = state.project;
  const done = { profile: !!(p?.likeness && p.consent), world: !!p?.footage.some((f) => f.status === "ready"), create: !!j?.shots.length, review: !!(j?.render && !j.render.stale) };
  $$("#steps button").forEach((b) => { b.classList.toggle("active", b.dataset.step === state.step); b.classList.toggle("done", done[b.dataset.step]); $("i", b).innerHTML = done[b.dataset.step] ? ICON.check : STEPS.indexOf(b.dataset.step) + 1; });
  const h = state.health; const mode = $("#mode");
  if (h) { mode.textContent = h.mode === "preview" ? "Preview mode" : "Live generation"; mode.classList.toggle("live", h.mode !== "preview"); mode.title = `Stills: ${h.image}\nVideo: ${h.video}${h.mode === "preview" ? "\nAdd FAL_KEY and RUNWAY_API_KEY to .env for real generation." : ""}`; }
  const jobs = [...activeJobs(p), ...activeJobs(j)]; const a = $("#activity");
  a.hidden = !jobs.length; if (jobs.length) a.innerHTML = `<div class="spin"></div><span>${esc(jobs.find((x) => x.status === "running")?.note || jobs[0].label)}${jobs.length > 1 ? ` · ${jobs.length} tasks` : ""}</span>`;
}

// ---- 1. likeness profile ---------------------------------------------------------------
function photoHTML(kind) {
  return (ph) => {
    const p = state.profile; const primary = ph.id === (kind === "face" ? p.primaryFaceId : p.primaryBodyId); const on = ph.approved !== false;
    return `<div class="thumb${primary ? " primary" : ""}${on ? "" : " off"}">
      <img src="${media(ph.rel)}" alt="${esc(ph.originalName)}" loading="lazy" />
      ${primary ? '<span class="lead">Lead reference</span>' : ""}
      <div class="bar">
        <button class="icon tick${on ? " on" : ""}" data-photo="${ph.id}" data-act="approve" title="${on ? "Approved reference - click to exclude" : "Excluded - click to approve"}">${ICON.check}</button>
        <button class="icon${primary ? " on" : ""}" data-photo="${ph.id}" data-act="primary" title="Use as the lead reference">${ICON.star}</button>
        <span class="grow"></span>
        <button class="icon" data-photo="${ph.id}" data-act="delete" title="Delete this photo">${ICON.trash}</button>
      </div></div>`;
  };
}
function renderProfile() {
  const p = state.profile; if (!p) return;
  const faces = p.faces.filter((x) => x.approved !== false).length, bodies = p.bodies.filter((x) => x.approved !== false).length;
  $("#face-count").textContent = p.faces.length ? `${faces} approved` : ""; $("#body-count").textContent = p.bodies.length ? `${bodies} approved` : "";
  const item = (ok, text) => `<span class="tag ${ok ? "ok" : ""}">${ok ? ICON.check : ""}${text}</span>`;
  $("#profile-checklist").innerHTML = item(faces >= 3, `${Math.min(faces, 3)} of 3 face angles`) + item(bodies >= 1, "A full-body photo") + item(!!p.likeness, "Likeness notes") + item(p.consent, "Consent");
  syncList($("#face-thumbs"), p.faces, (x) => x.id, photoHTML("face")); syncList($("#body-thumbs"), p.bodies, (x) => x.id, photoHTML("body"));
  for (const kind of ["face", "body"]) { const d = $(`[data-drop=${kind}]`); const up = ui.uploading[kind]; d.classList.toggle("busy", !!up); $("b", d).textContent = up || "Drop photos here"; }

  const card = $("#likeness-card"); const busy = activeJobs(p).some((j) => j.type === "describe-likeness"); const failed = failedJobs(p).find((j) => j.type === "describe-likeness");
  if (!card.contains(document.activeElement) || document.activeElement.tagName !== "TEXTAREA") {
    const lk = p.likeness;
    const head = `<div class="card-head"><h3>Likeness notes</h3>${lk?.edited ? '<span class="tag accent">edited by you</span>' : ""}<span class="grow" style="flex:1"></span>${busy ? '<span class="activity"><div class="spin"></div>Studying your photos</span>' : lk ? '<button class="small ghost" id="btn-relikeness">Rewrite from photos</button>' : ""}</div>`;
    const markup = lk
      ? `${head}<p class="hint">Neutral appearance notes the generator uses to keep you consistent. They're yours to correct - edits are saved when you click away.</p>
         <div class="notes">${[["description", "Appearance"], ["bodyProportions", "Build and proportions"], ["signatureStyle", "Signature style"]].map(([k, label]) => `<label>${label}<textarea data-likeness="${k}">${esc(lk[k])}</textarea></label>`).join("")}</div>`
      : `${head}${busy ? '<div class="skeleton" style="width:90%"></div><div class="skeleton" style="width:72%"></div><div class="skeleton" style="width:80%"></div>' : failed ? `<p class="error">Could not write the notes: ${esc(failed.error)}</p><div><button class="small" id="btn-relikeness">Try again</button></div>` : '<p class="hint">Add face photos and a vision model writes neutral appearance notes here: hair, face shape, build, style. You can edit them.</p>'}`;
    if (card._markup !== markup) { card.innerHTML = markup; card._markup = markup; }
  }
  $("#consent").checked = !!p.consent;
  $("#consent-at").textContent = p.consent && p.consentAt ? `Consent recorded ${new Date(p.consentAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}` : "";
}
async function uploadFiles(kind, files, extra = {}) {
  const list = [...files]; let n = 0;
  for (const f of list) {
    ui.uploading[kind] = `Uploading ${++n} of ${list.length}`; render();
    const qs = new URLSearchParams({ kind, name: f.name, ...extra });
    try {
      const r = await fetch(`/api/profiles/${state.profile.id}/upload?${qs}`, { method: "POST", headers: { "content-type": f.type || "application/octet-stream" }, body: f });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || r.statusText); state.profile = j;
    } catch (e) { toast(`${f.name}: ${e.message}`); }
  }
  delete ui.uploading[kind]; render();
}
$$(".drop").forEach((d) => {
  const kind = d.dataset.drop; const input = $("input", d);
  const send = (files) => uploadFiles(kind, files, kind === "footage" ? { usage: segValue("upload-usage") } : {});
  input.onchange = () => { send(input.files); input.value = ""; };
  d.ondragover = (e) => { e.preventDefault(); d.classList.add("over"); }; d.ondragleave = () => d.classList.remove("over");
  d.ondrop = (e) => { e.preventDefault(); d.classList.remove("over"); send(e.dataTransfer.files); };
});
$("section[data-panel=profile]").addEventListener("click", act(async (e) => {
  const b = e.target.closest("[data-photo]"); const id = state.profile.id;
  if (b) {
    const ph = [...state.profile.faces, ...state.profile.bodies].find((x) => x.id === b.dataset.photo);
    if (b.dataset.act === "delete") { if (confirm("Delete this photo?")) state.profile = await api("DELETE", `/api/profiles/${id}/photos/${ph.id}`); }
    else state.profile = await api("POST", `/api/profiles/${id}/photos/${ph.id}`, b.dataset.act === "primary" ? { primary: true } : { approved: ph.approved === false });
    return render();
  }
  if (e.target.closest("#btn-relikeness")) { state.profile = await api("POST", `/api/profiles/${id}/likeness/refresh`); render(); }
}));
$("#likeness-card").addEventListener("change", act(async (e) => {
  const k = e.target.dataset.likeness; if (!k) return;
  state.profile = await api("POST", `/api/profiles/${state.profile.id}/likeness`, { [k]: e.target.value }); toast("Notes saved", true); render();
}));
$("#consent").onchange = act(async (e) => { state.profile = await api("POST", `/api/profiles/${state.profile.id}/consent`, { consent: e.target.checked }); render(); });
$("#btn-delete-profile").onclick = act(async () => {
  if (!confirm("Delete your profile, every photo and clip, and every reel made from them? This cannot be undone.")) return;
  await api("DELETE", `/api/profiles/${state.profile.id}`); state.project = null; state.projects = [];
  state.profile = await api("POST", "/api/profiles", { name: "Me" }); toast("Profile and all media deleted", true); go("profile");
});

// ---- 2. your world ---------------------------------------------------------------------
const USAGE_HINT = { inspiration: "Inspiration can be reinterpreted: its look, place and mood guide generated shots.", exact: "Exact footage appears in the reel as you uploaded it, never regenerated." };
bindSeg("upload-usage", (v) => ($("#usage-hint").textContent = USAGE_HINT[v])); $("#usage-hint").textContent = USAGE_HINT.inspiration;
function footageHTML(f) {
  const a = f.analysis; const job = state.profile.jobs.find((j) => j.footageId === f.id);
  const facts = a ? [a.location, a.lighting, a.timeOfDay, a.cameraMovement && `Camera: ${a.cameraMovement}`].filter(Boolean) : [];
  const swatch = (c) => (/^#[0-9a-f]{3,8}$/i.test(c.trim()) ? `<i style="background:${c.trim()}" title="${esc(c)}"></i>` : "");
  return `<div class="fcard">
    <div class="media">${f.kind === "clip" ? `<video src="${media(f.rel)}" controls muted playsinline preload="metadata"></video>` : `<img src="${media(f.rel)}" alt="" loading="lazy" />`}</div>
    <div class="body">
      <div class="row"><span class="name grow" title="${esc(f.originalName)}">${esc(f.originalName)}</span><span class="hint">${f.kind === "clip" && f.durationSec ? `${f.durationSec.toFixed(1)} s` : f.kind}</span><button class="icon ghost" data-footage="${f.id}" data-act="delete" title="Delete">${ICON.trash}</button></div>
      <div class="row wrap"><div class="seg">${["inspiration", "exact"].map((u) => `<button data-footage="${f.id}" data-act="usage" data-v="${u}" class="${f.usage === u ? "on" : ""}">${u === "exact" ? "Exact" : "Inspiration"}</button>`).join("")}</div><span class="hint">${f.usage === "exact" ? "appears as uploaded" : "may be reinterpreted"}</span></div>
      ${f.status === "analyzing" ? `<div class="activity"><div class="spin"></div>${esc(job?.note || "Waiting to analyze")}</div><div class="skeleton" style="width:85%"></div><div class="skeleton" style="width:60%"></div>`
      : f.status === "failed" ? `<p class="error">Analysis failed: ${esc(f.error)}</p><div><button class="small" data-footage="${f.id}" data-act="retry">Try again</button></div>`
      : `<p class="summary">${esc(a.summary)}</p>
         <div class="chips">${facts.map((x) => `<span class="tag">${esc(x)}</span>`).join("")}</div>
         ${a.colorPalette?.some((c) => /^#/.test(c.trim())) ? `<div class="swatches">${a.colorPalette.map(swatch).join("")}</div>` : ""}
         ${a.bestForShots?.length ? `<div><span class="label">Good for</span><ul>${a.bestForShots.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}`}
    </div></div>`;
}
function renderWorld() {
  const p = state.profile; if (!p) return;
  const d = $("[data-drop=footage]"); const up = ui.uploading.footage; d.classList.toggle("busy", !!up); $("b", d).textContent = up || "Drop clips or photos here";
  syncList($("#footage-list"), [...p.footage].reverse(), (f) => f.id, footageHTML);
}
$("#footage-list").addEventListener("click", act(async (e) => {
  const b = e.target.closest("[data-footage]"); if (!b) return; const base = `/api/profiles/${state.profile.id}/footage/${b.dataset.footage}`;
  if (b.dataset.act === "delete") { if (!confirm("Delete this footage?")) return; state.profile = await api("DELETE", base); }
  else if (b.dataset.act === "retry") state.profile = await api("POST", `${base}/analyze`);
  else if (b.dataset.act === "usage") state.profile = await api("POST", base, { usage: b.dataset.v });
  render();
}));

// ---- 3. create ---------------------------------------------------------------------------
const EXAMPLES = ["Make a 15-second video of me enjoying a weekend in Paris", "A calm morning routine: coffee, a walk, getting to work", "Me exploring a night market, trying street food"];
$("#examples").innerHTML = EXAMPLES.map((x) => `<button>${esc(x)}</button>`).join("");
$("#examples").onclick = (e) => { if (e.target.tagName === "BUTTON") { $("#request").value = e.target.textContent; $("#request").focus(); } };
bindSeg("duration"); bindSeg("aspect");
function projectStatus(j) {
  const a = activeJobs(j); if (a.length) return `<span class="tag"><div class="spin"></div>${esc(a[0].label)}</span>`;
  if (j.render && !j.render.stale) return '<span class="tag ok">Rendered</span>';
  if (!j.shots.length) return failedJobs(j).length ? '<span class="tag bad">Planning failed</span>' : '<span class="tag">Planning</span>';
  const g = j.progress; return `<span class="tag">${g.clips}/${g.generated} animated</span>`;
}
function projectHTML(j) {
  const thumb = j.shots.find((s) => s.still)?.still.rel;
  return `<div class="pcard${j.id === state.project?.id ? " current" : ""}" data-project="${j.id}">
    <div class="pthumb">${thumb ? `<img src="${media(thumb)}" alt="" loading="lazy" />` : ""}</div>
    <div class="pbody"><div class="row"><span class="ptitle grow">${esc(j.title || "Untitled reel")}</span><button class="icon ghost" data-act="delete" title="Delete reel">${ICON.trash}</button></div>
      <div class="preq">${esc(j.request)}</div><div class="row">${projectStatus(j)}<span class="hint">${j.durationSec} s · ${j.aspect}</span></div></div></div>`;
}
function renderCreate() {
  const p = state.profile; if (!p) return;
  const ready = p.footage.filter((f) => f.status === "ready").length;
  const item = (ok, text, step, soft) => `<span class="tag ${ok ? "ok" : soft ? "" : "warn"}">${ok ? ICON.check : ""}${text}</span>${ok || soft ? "" : `<button class="small ghost" data-go="${step}">Fix</button>`}`;
  $("#readiness").innerHTML = item(!!p.likeness, p.likeness ? "Likeness ready" : "Add face photos first", "profile") + item(p.consent, p.consent ? "Consent given" : "Consent needed", "profile")
    + item(ready > 0, ready ? `${ready} clip${ready > 1 ? "s" : ""} of your world` : "No footage yet - every shot will be generated", "world", true);
  $("#btn-plan").disabled = !(p.likeness && p.consent);
  $("#projects-head").hidden = !state.projects.length;
  syncList($("#projects"), state.projects, (j) => j.id, projectHTML);
}
$("#btn-plan").onclick = act(async () => {
  const request = $("#request").value.trim() || $("#request").placeholder;
  state.project = await api("POST", "/api/projects", { profileId: state.profile.id, request, durationSec: +segValue("duration"), aspect: segValue("aspect") });
  state.projects.unshift(state.project); $("#request").value = ""; go("review");
});
$("#projects").addEventListener("click", act(async (e) => {
  const card = e.target.closest("[data-project]"); if (!card) return; const id = card.dataset.project;
  if (e.target.closest("[data-act=delete]")) {
    if (!confirm("Delete this reel and its stills, clips and renders?")) return;
    await api("DELETE", `/api/projects/${id}`); state.projects = state.projects.filter((j) => j.id !== id); if (state.project?.id === id) state.project = null; return render();
  }
  state.project = state.projects.find((j) => j.id === id); go("review");
}));

// ---- 4. review and render ------------------------------------------------------------------
const RATIO = { "9:16": "9 / 16", "1:1": "1 / 1", "16:9": "16 / 9" };
function qaHTML(q, what) {
  if (!q) return "";
  const pct = q.likenessScore == null ? "" : `${Math.round(q.likenessScore * 100)}% likeness`;
  const flags = [pct, q.bodyOk === false && "body distortion", q.sceneOk === false && "scene mismatch"].filter(Boolean).join(" · ");
  return `<div class="qa ${q.verdict}"><div class="row"><b>${what} check: ${q.verdict === "approve" ? "looks right" : "regenerate recommended"}</b><span class="grow"></span><span class="hint">${esc(flags)}</span></div>${q.issues?.length ? `<ul>${q.issues.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : ""}</div>`;
}
function shotHTML(s) {
  const j = state.project, p = state.profile; const jobs = j.jobs.filter((x) => x.shotId === s.id);
  const busy = jobs.find((x) => x.status === "running") ?? jobs.find((x) => x.status === "queued"); const failed = jobs.find((x) => x.status === "failed");
  const i = j.shots.indexOf(s); const gen = s.source === "generate";
  const f = gen ? null : p.footage.find((x) => x.id === s.footageId);
  const view = s.clip && ui.view[s.id] !== "still" ? "clip" : "still";
  const face = p.faces.find((x) => x.id === p.primaryFaceId);
  let main = "";
  if (!gen) main = !f ? '<div class="placeholder">This footage was deleted. Remove the shot or pick another clip.</div>' : f.kind === "clip" ? `<video class="main" src="${media(f.rel)}#t=${s.startSec || 0}" controls muted playsinline preload="metadata"></video>` : `<img class="main" src="${media(f.rel)}" alt="" />`;
  else if (view === "clip") main = `<video class="main" src="${media(s.clip.rel)}" controls muted loop playsinline preload="metadata"></video>`;
  else if (s.still) main = `<img class="main" src="${media(s.still.rel)}" alt="Still for ${esc(s.title)}" />`;
  else main = `<div class="placeholder">No still yet.<br>${esc(s.framing)}</div>`;
  const badges = `<span class="tag">${s.n}</span>` + (gen ? '<span class="tag accent">Starring you</span>' : '<span class="tag exact">Your footage</span>')
    + (gen && s.clip ? `<span class="tag">${esc(s.clip.provider === "preview" ? "Preview motion" : s.clip.provider)}</span>` : gen && s.still ? `<span class="tag">${esc(s.still.provider === "preview" ? "Preview still" : s.still.provider)}</span>` : "");
  const prog = busy ? `<div class="busy"><div class="spin"></div><span>${esc(busy.status === "queued" ? "Queued" : busy.note || busy.label)}</span><div class="bar-track"><i style="width:${Math.round((busy.progress || 0.05) * 100)}%"></i></div></div>` : "";
  const footageOptions = gen ? "" : `<label class="field">Clip<select data-shot="${s.id}" data-field="footageId">${p.footage.filter((x) => x.status === "ready").map((x) => `<option value="${x.id}" ${x.id === s.footageId ? "selected" : ""}>${esc(x.originalName)}</option>`).join("")}</select></label>`;
  const actions = gen
    ? `<button class="small" data-shot="${s.id}" data-act="still" ${busy ? "disabled" : ""}>${s.still ? "Regenerate still" : "Generate still"}</button>
       ${s.still ? `<button class="small ${s.approved ? "" : "primary"}" data-shot="${s.id}" data-act="approve" ${busy ? "disabled" : ""}>${s.approved ? "Approved" : "Approve still"}</button>` : ""}
       ${s.still ? `<button class="small" data-shot="${s.id}" data-act="animate-one" ${!s.approved || busy ? "disabled" : ""} title="${s.approved ? "" : "Approve the still first"}">${s.clip ? "Re-animate" : "Animate"}</button>` : ""}
       ${s.still ? `<button class="small ghost" data-shot="${s.id}" data-act="qa" data-target="${view}" ${busy ? "disabled" : ""}>Check ${view === "clip" ? "clip" : "likeness"}</button>` : ""}`
    : "";
  return `<div class="shot${s.approved && (gen ? s.still : true) ? " approved" : ""}" id="shot-${s.id}">
    <div class="media${gen ? "" : " " + (s.fit || "contain")}" style="aspect-ratio:${RATIO[j.aspect]}">${main}
      <div class="badges">${badges}</div>
      ${gen && s.still && face ? `<div class="ref" title="Your lead reference, for comparison"><img src="${media(face.rel)}" alt="" /><span>reference</span></div>` : ""}${prog}</div>
    <div class="body">
      <div class="head"><input type="text" value="${esc(s.title)}" data-shot="${s.id}" data-field="title" aria-label="Shot title" /><label class="secs"><input type="number" min="1" max="10" step="0.5" value="${s.seconds}" data-shot="${s.id}" data-field="seconds" aria-label="Seconds" />s</label></div>
      ${gen && s.clip ? `<div class="viewtoggle"><div class="seg"><button data-shot="${s.id}" data-act="view" data-v="clip" class="${view === "clip" ? "on" : ""}">Clip</button><button data-shot="${s.id}" data-act="view" data-v="still" class="${view === "still" ? "on" : ""}">Still</button></div></div>` : ""}
      ${s.action || s.setting ? `<p class="desc">${esc([s.action, s.setting].filter(Boolean).join(" · "))}</p>` : ""}
      ${failed ? `<p class="error">${esc(failed.label)} failed: ${esc(failed.error)}</p>` : ""}
      <div class="actions">${actions}</div>
      ${qaHTML(view === "clip" ? s.clipCritique : s.critique, view === "clip" ? "Clip" : "Likeness")}
      ${gen && s.history.length ? `<div class="versions"><span class="hint">Earlier stills</span>${s.history.map((h, k) => `<button data-shot="${s.id}" data-act="restore" data-index="${k}" title="Restore this version"><img src="${media(h.rel)}" alt="" loading="lazy" /></button>`).join("")}</div>` : ""}
      <label class="field">Caption<input type="text" value="${esc(s.caption)}" data-shot="${s.id}" data-field="caption" placeholder="On-screen text" /></label>
      ${j.settings.narration ? `<label class="field">Narration<input type="text" value="${esc(s.narration)}" data-shot="${s.id}" data-field="narration" placeholder="One spoken line" /></label>` : ""}
      ${footageOptions}
      ${gen ? `<details ${ui.open[s.id] ? "open" : ""} data-shot="${s.id}"><summary>Prompts</summary>
        <label class="field">Still prompt<textarea rows="5" data-shot="${s.id}" data-field="stillPrompt">${esc(s.stillPrompt)}</textarea></label>
        <label class="field">Motion<textarea rows="3" data-shot="${s.id}" data-field="motionPrompt">${esc(s.motionPrompt)}</textarea></label>
        <span class="hint">[LIKENESS] is replaced with your appearance notes.</span></details>`
      : f?.kind === "clip" ? `<div class="row wrap"><label class="secs">Start at <input type="number" min="0" step="0.5" value="${s.startSec || 0}" data-shot="${s.id}" data-field="startSec" />s</label><span class="grow"></span><div class="seg"><button data-shot="${s.id}" data-act="fit" data-v="contain" class="${(s.fit || "contain") === "contain" ? "on" : ""}" title="Keep the whole frame">Whole frame</button><button data-shot="${s.id}" data-act="fit" data-v="cover" class="${s.fit === "cover" ? "on" : ""}" title="Crop to fill the reel's format">Fill</button></div></div>` : ""}
      <div class="row"><button class="icon ghost" data-shot="${s.id}" data-act="move" data-dir="-1" ${i === 0 ? "disabled" : ""} title="Move earlier">${ICON.left}</button><button class="icon ghost" data-shot="${s.id}" data-act="move" data-dir="1" ${i === j.shots.length - 1 ? "disabled" : ""} title="Move later">${ICON.right}</button><span class="grow"></span><button class="icon ghost" data-shot="${s.id}" data-act="delete" title="Remove shot">${ICON.trash}</button></div>
    </div></div>`;
}
function addShotHTML() {
  const ready = state.profile.footage.filter((f) => f.status === "ready");
  return `<div class="shot add"><b>Add a shot</b><button data-act="add-gen">A generated shot starring you</button>
    ${ready.length ? `<select id="add-footage"><option value="">A clip from your world…</option>${ready.map((f) => `<option value="${f.id}">${esc(f.originalName)}</option>`).join("")}</select>` : ""}</div>`;
}
function renderReview() {
  const j = state.project; $("#review-empty").hidden = !!j; $("#review-body").hidden = !j; if (!j) return;
  const g = j.progress; const planning = activeJobs(j).find((x) => x.type === "plan"); const planFailed = !j.shots.length && failedJobs(j).find((x) => x.type === "plan");
  if (document.activeElement !== $("#review-title")) $("#review-title").value = j.title || (planning ? "Planning your reel…" : "Untitled reel");
  $("#review-logline").textContent = j.logline || j.request;
  const st = (ok, text) => `<span class="tag ${ok ? "ok" : ""}">${ok ? ICON.check : ""}${text}</span>`;
  $("#tracker").innerHTML = planFailed ? `<span class="tag bad">Planning failed: ${esc(planFailed.error)}</span><button class="small" data-act="replan">Try again</button>`
    : planning ? '<span class="tag"><div class="spin"></div>Planning the shot list</span>'
    : [st(g.shots > 0, `${g.shots} shots · ${g.seconds} s`), st(g.generated > 0 && g.stills === g.generated, `Stills ${g.stills}/${g.generated}`), st(g.generated > 0 && g.approved === g.generated, `Approved ${g.approved}/${g.generated}`), st(g.generated > 0 && g.clips === g.generated, `Animated ${g.clips}/${g.generated}`), st(!!j.render && !j.render.stale, "Reel")].join('<span class="sep"></span>')
      + (Math.abs(g.seconds - j.durationSec) > 1.5 ? `<span class="tag warn">target ${j.durationSec} s</span>` : "") + '<span class="grow" style="flex:1"></span><button class="small ghost" data-act="replan" title="Throw this list away and plan again">Re-plan</button>';
  syncList($("#timeline"), j.shots, (s) => s.id, (s) => `<button class="${s.source}" style="flex:${s.seconds}" data-jump="${s.id}" title="${esc(s.title)} · ${s.seconds} s"><b>${s.n}</b>${esc(s.title)}</button>`);
  $("#shots").classList.toggle("wide", j.aspect === "16:9"); $("#shots").classList.toggle("square", j.aspect === "1:1");
  const waiting = !j.shots.length && (planning || planFailed);
  const skeleton = () => `<div class="shot"><div class="media" style="aspect-ratio:${RATIO[j.aspect]}"><div class="placeholder"><div class="spin"></div></div></div><div class="body"><div class="skeleton" style="width:70%"></div><div class="skeleton" style="width:90%"></div><div class="skeleton" style="width:50%"></div></div></div>`;
  syncList($("#shots"), waiting ? (planning ? [{ id: "__s1" }, { id: "__s2" }, { id: "__s3" }] : []) : [...j.shots, { id: "__add", add: true }], (s) => s.id, (s) => (s.id.startsWith("__s") ? skeleton() : s.add ? addShotHTML() : shotHTML(s)));
  $(".finish").hidden = waiting; $("#render").hidden = waiting;
  renderFinish();
}
function renderFinish() {
  const j = state.project; const s = j.settings; const g = j.progress; const e = j.estimate; const preview = state.health?.mode === "preview";
  const sw = (k, on) => `<label class="switch"><input type="checkbox" data-setting="${k}" ${on ? "checked" : ""} /><i></i></label>`;
  const settings = `<h3>Finishing</h3>
    <div class="setting"><span class="name">Title card</span>${sw("titleCard", s.titleCard)}</div>
    <div class="setting"><span class="name">Captions</span>${sw("captions", s.captions)}</div>
    <div class="setting"><span class="name">Music</span><div class="seg">${[["auto", "Composed"], ["upload", "Your track"], ["none", "None"]].map(([v, l]) => `<button data-music="${v}" class="${s.music === v ? "on" : ""}">${l}</button>`).join("")}</div>
      ${s.music === "auto" ? `<select data-setting="mood" style="width:auto">${["warm", "upbeat", "calm"].map((m) => `<option ${s.mood === m ? "selected" : ""}>${m}</option>`).join("")}</select>` : ""}</div>
    ${s.music === "upload" ? `<div class="setting"><span class="name"></span><label class="small" style="cursor:pointer"><input type="file" id="music-file" accept="audio/*,.mp3,.m4a,.wav" hidden /><span class="tag">${esc(s.musicName || "Choose an audio file")}</span></label></div>` : ""}
    ${j.music && s.music === "auto" ? `<p class="hint">Planner's brief: ${esc(j.music)}</p>` : ""}
    <div class="setting"><span class="name">Narration</span>${sw("narration", s.narration)}<span class="hint">${s.narration ? "Each shot's line is spoken over the music." : "A spoken line per shot."}</span></div>`;
  const set = $("#settings"); if (set._markup !== settings && !set.contains(document.activeElement)) { set.innerHTML = settings; set._markup = settings; }

  const busy = (t) => activeJobs(j).some((x) => x.type === t); const missing = g.generated - g.stills, toAnimate = e.animate.videoSeconds;
  const canRender = j.shots.some((x) => (x.source === "footage" ? true : x.clip || (x.still && x.approved)));
  const actions = `<h3>Produce</h3>
    <div class="step-row"><div class="what"><b>Stills</b><span>${missing ? `${missing} to generate · ${preview ? "free in preview" : money(e.stills.total)}` : g.generated ? "Every generated shot has a still." : "No generated shots."}</span></div><button data-act="stills" ${!missing || busy("still") ? "disabled" : ""}>Generate stills</button></div>
    <div class="step-row"><div class="what"><b>Animate</b><span>${toAnimate ? `${toAnimate} s across approved stills · ${preview ? "free in preview" : `${money(e.animate.total)} with ${esc(e.animate.video)}`}` : g.approved < g.generated ? "Approve stills to unlock animation. This is the cheap checkpoint." : "All approved stills are animated."}</span></div><button data-act="animate" ${!toAnimate || busy("animate") ? "disabled" : ""}>Animate approved</button></div>
    <div class="step-row"><div class="what"><b>Reel</b><span>${j.render ? (j.render.stale ? "Changed since the last render." : "Up to date.") : "Assembles clips, your footage, captions and sound."}</span></div><button class="primary" data-act="render" ${!canRender || busy("render") ? "disabled" : ""}>${busy("render") ? "Rendering…" : j.render ? "Render again" : "Render reel"}</button></div>`;
  const ac = $("#actions"); if (ac._markup !== actions) { ac.innerHTML = actions; ac._markup = actions; }

  const r = j.render; const rj = j.jobs.find((x) => x.type === "render"); const box = $("#render"); box.classList.toggle("wide", j.aspect === "16:9");
  const sound = r ? [r.audio?.music?.startsWith("synth") ? `composed music (${r.audio.music.split(":")[1]})` : r.audio?.music === "file" ? "your track" : null, r.audio?.narration ? `${r.audio.narration} narrated lines` : null].filter(Boolean).join(" + ") || "silent" : "";
  const markup = (rj?.status === "failed" ? `<p class="error">Render failed: ${esc(rj.error)}</p>` : "") + (r ? `<div class="player"><video src="${media(r.rel)}#t=0.6" controls playsinline preload="metadata"></video>
      <div class="meta"><h2>${esc(j.title)}</h2><div class="chips"><span class="tag">${r.duration} s</span><span class="tag">${j.aspect}</span><span class="tag">${r.segments} shots</span><span class="tag">${esc(sound)}</span></div>
      ${r.stale ? '<div class="notice">The shot list or settings changed after this render. Render again to include the changes.</div>' : ""}${r.note ? `<div class="notice">${esc(r.note)}</div>` : ""}
      ${preview ? '<p class="hint">Preview mode: generated shots are composites of your own photos with parallax motion, so the flow can be judged before paying for generation.</p>' : ""}
      <div><a href="${media(r.rel)}" download="${esc((j.title || "reel").replace(/[^\w\- ]+/g, "").trim() || "reel")}.mp4"><button class="primary">Download reel</button></a></div></div></div>` : "");
  if (box._markup !== markup) { box.innerHTML = markup; box._markup = markup; }
}
const PJ = () => `/api/projects/${state.project.id}`;
const setProject = (j) => { state.project = j.project ?? j; const i = state.projects.findIndex((x) => x.id === state.project.id); if (i >= 0) state.projects[i] = state.project; render(); };
$("section[data-panel=review]").addEventListener("click", act(async (e) => {
  const jump = e.target.closest("[data-jump]"); if (jump) return $(`#shot-${jump.dataset.jump}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  const music = e.target.closest("[data-music]"); if (music) return setProject(await api("POST", `${PJ()}/settings`, { music: music.dataset.music }));
  const b = e.target.closest("[data-act]"); if (!b || b.disabled) return; const a = b.dataset.act, id = b.dataset.shot, S = `${PJ()}/shots/${id}`;
  if (a === "view") { ui.view[id] = b.dataset.v; return render(); }
  if (a === "replan") { if (state.project.shots.length && !confirm("Plan a new shot list? Current stills and clips will be replaced.")) return; return setProject(await api("POST", `${PJ()}/replan`)); }
  if (a === "stills" || a === "animate" || a === "render") return setProject(await api("POST", `${PJ()}/${a}`));
  if (a === "add-gen") return setProject(await api("POST", `${PJ()}/shots`, {}));
  if (a === "still") return setProject(await api("POST", `${S}/still`, { stillPrompt: $(`textarea[data-shot="${id}"][data-field=stillPrompt]`)?.value }));
  if (a === "approve") return setProject(await api("POST", `${S}/approve`, { approved: !state.project.shots.find((s) => s.id === id).approved }));
  if (a === "animate-one") return setProject(await api("POST", `${S}/animate`));
  if (a === "qa") return setProject(await api("POST", `${S}/qa`, { target: b.dataset.target }));
  if (a === "restore") return setProject(await api("POST", `${S}/restore`, { index: +b.dataset.index }));
  if (a === "move") return setProject(await api("POST", `${S}/move`, { dir: +b.dataset.dir }));
  if (a === "fit") return setProject(await api("POST", S, { fit: b.dataset.v }));
  if (a === "delete") { if (confirm("Remove this shot from the reel?")) setProject(await api("DELETE", S)); }
}));
$("section[data-panel=review]").addEventListener("change", act(async (e) => {
  const t = e.target;
  if (t.id === "review-title") return setProject(await api("POST", PJ(), { title: t.value }));
  if (t.id === "add-footage" && t.value) return setProject(await api("POST", `${PJ()}/shots`, { footageId: t.value }));
  if (t.id === "music-file" && t.files[0]) {
    const f = t.files[0]; const r = await fetch(`${PJ()}/music?${new URLSearchParams({ name: f.name })}`, { method: "POST", headers: { "content-type": f.type || "application/octet-stream" }, body: f });
    const j = await r.json(); if (!r.ok) throw new Error(j.error); return setProject(j);
  }
  if (t.dataset.setting) return setProject(await api("POST", `${PJ()}/settings`, { [t.dataset.setting]: t.type === "checkbox" ? t.checked : t.value }));
  if (t.dataset.field) { const v = t.type === "number" ? +t.value : t.value; return setProject(await api("POST", `${PJ()}/shots/${t.dataset.shot}`, { [t.dataset.field]: v })); }
}));
$("#shots").addEventListener("toggle", (e) => { if (e.target.tagName === "DETAILS") ui.open[e.target.dataset.shot] = e.target.open; }, true);
// ---- render + polling ---------------------------------------------------------------------
function render() {
  renderHeader();
  ({ profile: renderProfile, world: renderWorld, create: renderCreate, review: renderReview })[state.step]();
}
let lastSeen = "";
async function poll() {
  try {
    if (!state.health) state.health = await api("GET", "/api/health");
    if (state.profile) state.profile = await api("GET", `/api/profiles/${state.profile.id}`);
    if (state.step === "create" || !state.projects.length) state.projects = await api("GET", `/api/projects?profile=${state.profile.id}`);
    if (state.project) { state.project = await api("GET", PJ()).catch(() => null); }
    const seen = JSON.stringify([state.profile, state.project, state.projects.map((j) => [j.id, j.status, j.jobs.length, j.title])]);
    if (seen !== lastSeen) { lastSeen = seen; render(); }
  } catch { /* backend restarting - try again on the next tick */ }
  const busy = activeJobs(state.profile).length || activeJobs(state.project).length;
  setTimeout(poll, busy ? 1200 : 3500);
}
(async function start() {
  try {
    state.health = await api("GET", "/api/health");
    const all = await api("GET", "/api/profiles"); state.profile = all[0] ?? (await api("POST", "/api/profiles", { name: "Me" }));
    state.projects = await api("GET", `/api/projects?profile=${state.profile.id}`); state.project = state.projects[0] ?? null;
  } catch (e) { toast(`Cannot reach the backend: ${e.message}. Start it with "npm run server".`); }
  const hash = location.hash.slice(1);
  go(STEPS.includes(hash) ? hash : state.project?.shots.length ? "review" : state.profile?.likeness ? "create" : "profile");
  poll();
})();
window.addEventListener("hashchange", () => { const h = location.hash.slice(1); if (STEPS.includes(h) && h !== state.step) go(h); });
