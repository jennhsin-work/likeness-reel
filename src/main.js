const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const api = async (method, path, body) => { const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json(); if (!r.ok) throw new Error(j.error || r.statusText); return j; };
const status = (m) => { $("#status").textContent = m; };
const media = (rel) => `/media/${rel}`;
const toB64 = (file) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result.split(",")[1]); fr.onerror = rej; fr.readAsDataURL(file); });
async function filesPayload(files) { const out = []; for (const f of files) out.push({ name: f.name, type: f.type, data: await toB64(f) }); return out; }

let profile = null, project = null, polling = null;

// ---- navigation ----------------------------------------------------------------
function go(step) {
  $$("#steps button").forEach((b) => b.classList.toggle("active", b.dataset.step === step));
  $$("main section").forEach((s) => (s.hidden = s.dataset.panel !== step));
  if (step === "create") renderProjects();
  if (step === "review" && project) renderShots();
}
$$("#steps button").forEach((b) => (b.onclick = () => go(b.dataset.step)));
document.addEventListener("click", (e) => { const b = e.target.closest("[data-go]"); if (b) go(b.dataset.go); });

// ---- profile ---------------------------------------------------------------------
async function loadProfile() {
  const all = await api("GET", "/api/profiles");
  profile = all[0] ?? (await api("POST", "/api/profiles", { name: "Me" }));
  renderProfile();
  // restore the most recent project so a reload lands back on its shot list
  const projs = await api("GET", "/api/projects").catch(() => []);
  project = projs.filter((x) => x.profileId === profile.id).at(-1) ?? null;
}
function renderProfile() {
  const p = profile;
  $("#face-count").textContent = p.faces.length; $("#body-count").textContent = p.bodies.length;
  const thumbs = (list, kind) => list.map((x) => `<div class="t ${p.likeness && (p.likeness.faceRef === x.rel || p.likeness.bodyRef === x.rel) ? "ref" : ""}"><img src="${media(x.rel)}" alt=""><button class="x" data-del-photo="${x.id}" title="remove">×</button>${p.likeness && (p.likeness.faceRef === x.rel || p.likeness.bodyRef === x.rel) ? '<span class="tag">reference</span>' : ""}</div>`).join("");
  $("#face-thumbs").innerHTML = thumbs(p.faces); $("#body-thumbs").innerHTML = thumbs(p.bodies);
  $("#consent").checked = !!p.consent;
  const job = p.jobs?.find((j) => j.type === "describe-likeness");
  const lk = p.likeness;
  $("#likeness").innerHTML = job && job.status !== "failed" ? `<div class="bar"><i style="width:${Math.round((job.progress || 0.1) * 100)}%"></i></div><div class="muted" style="margin-top:6px">${esc(job.note || "studying your photos…")}</div>`
    : job?.status === "failed" ? `<span style="color:var(--bad)">${esc(job.error)}</span>`
    : lk ? `<b>Appearance</b> · ${esc(lk.description)}\n<b>Build</b> · ${esc(lk.bodyProportions)}\n<b>Style</b> · ${esc(lk.signatureStyle)}` : "Add face photos and the system writes neutral appearance notes it will use to keep you consistent across generated shots.";
  $$("#steps button")[0].classList.toggle("done", !!lk && p.consent);
  $$("#steps button")[1].classList.toggle("done", p.footage.some((f) => f.status === "ready"));
  $("#mode").textContent = modeText;
  renderFootage();
}
async function uploadPhotos(kind, files) {
  if (!files.length) return; status(`uploading ${files.length} photo(s)…`);
  profile = await api("POST", `/api/profiles/${profile.id}/photos`, { kind, files: await filesPayload(files) });
  renderProfile(); status("");
}
$("#face-input").onchange = (e) => uploadPhotos("face", [...e.target.files]);
$("#body-input").onchange = (e) => uploadPhotos("body", [...e.target.files]);
for (const d of $$(".drop")) { d.ondragover = (e) => { e.preventDefault(); d.classList.add("over"); }; d.ondragleave = () => d.classList.remove("over"); d.ondrop = (e) => { e.preventDefault(); d.classList.remove("over"); const input = d.querySelector("input"); const dt = new DataTransfer(); for (const f of e.dataTransfer.files) dt.items.add(f); input.files = dt.files; input.dispatchEvent(new Event("change")); }; }
document.addEventListener("click", async (e) => {
  const del = e.target.closest("[data-del-photo]"); if (del) { profile = await api("DELETE", `/api/profiles/${profile.id}/photos/${del.dataset.delPhoto}`); renderProfile(); }
  const re = e.target.closest("[data-reanalyze]"); if (re) { profile = await api("POST", `/api/profiles/${profile.id}/footage/${re.dataset.reanalyze}/analyze`); renderProfile(); }
  const delF = e.target.closest("[data-del-footage]"); if (delF) { profile = await api("DELETE", `/api/profiles/${profile.id}/footage/${delF.dataset.delFootage}`); renderProfile(); }
});
$("#consent").onchange = async (e) => { profile = await api("POST", `/api/profiles/${profile.id}/consent`, { consent: e.target.checked }); renderProfile(); };
$("#btn-delete-profile").onclick = async () => { if (!confirm("Delete your profile, photos, footage and every project? This cannot be undone.")) return; await api("DELETE", `/api/profiles/${profile.id}`); project = null; await loadProfile(); go("profile"); };

// ---- footage ---------------------------------------------------------------------
$("#footage-input").onchange = async (e) => {
  const files = [...e.target.files]; if (!files.length) return; status(`uploading ${files.length} file(s)…`);
  profile = await api("POST", `/api/profiles/${profile.id}/footage`, { usage: $("#footage-usage").value, files: await filesPayload(files) }); renderProfile(); status("");
};
function renderFootage() {
  const el = $("#footage-list");
  el.innerHTML = profile.footage.map((f) => {
    const job = profile.jobs?.find((j) => j.type === "analyze-footage" && j.status !== "done" && (profile.footage.find((x) => x.id === f.id) && j.note !== undefined));
    const a = f.analysis;
    return `<div class="fi">
      <div class="frames">${(f.frames?.length ? f.frames : []).map((fr) => `<img src="${media(fr)}" alt="">`).join("") || `<div class="muted" style="padding:40px;width:100%;text-align:center">${f.status === "analyzing" ? "extracting frames…" : "no frames"}</div>`}</div>
      <div class="body">
        <div class="name"><span>${esc(f.originalName)} <span class="muted">${f.kind}${f.durationSec ? ` · ${f.durationSec.toFixed(1)} s` : ""}</span></span>
          <span><select data-usage="${f.id}"><option value="inspiration" ${f.usage === "inspiration" ? "selected" : ""}>inspiration</option><option value="exact" ${f.usage === "exact" ? "selected" : ""}>use exactly</option></select> <button class="x muted-btn" data-del-footage="${f.id}" title="remove">×</button></span></div>
        ${a ? `<div class="desc">${esc(a.summary)}</div><div class="tags"><span class="tag ${f.usage === "exact" ? "exact" : "insp"}">${f.usage}</span><span class="tag">${esc(a.location)}</span><span class="tag">${esc(a.lighting)}</span><span class="tag">${esc(a.activity)}</span><span class="tag">${esc(a.cameraMovement)}</span></div>`
          : f.status === "analyzing" ? `<div class="desc">describing with the vision model…</div>` : `<div class="desc" style="color:var(--bad)">analysis failed${f.error ? ": " + esc(f.error.slice(0, 80)) : ""} <button class="muted-btn" data-reanalyze="${f.id}">retry</button></div>`}
      </div></div>`;
  }).join("") || `<p class="muted">Nothing yet. A café clip, a street walk, your bike, your dog — anything that's "your world".</p>`;
  el.querySelectorAll("[data-usage]").forEach((s) => (s.onchange = async () => { profile = await api("POST", `/api/profiles/${profile.id}/footage/${s.dataset.usage}`, { usage: s.value }); renderProfile(); }));
}

// ---- create ------------------------------------------------------------------------
$("#btn-plan").onclick = async () => {
  const request = $("#request").value.trim(); if (!request) return;
  if (!profile.likeness) { status("Add face photos first — the planner needs your likeness notes."); go("profile"); return; }
  if (!profile.consent) { status("Please confirm consent on step 1 first."); go("profile"); return; }
  project = await api("POST", "/api/projects", { profileId: profile.id, request, durationSec: +$("#duration").value, aspect: $("#aspect").value });
  go("review");
};
async function renderProjects() {
  const all = (await api("GET", "/api/projects")).filter((p) => p.profileId === profile.id).reverse();
  $("#projects").innerHTML = all.map((p) => `<div class="proj" data-open="${p.id}"><span><b>${esc(p.title || p.request)}</b><br><span class="muted">${esc(p.request)} · ${p.durationSec} s · ${p.aspect}</span></span><span class="tag">${p.status}</span></div>`).join("");
  $$("[data-open]").forEach((d) => (d.onclick = () => { project = all.find((p) => p.id === d.dataset.open); go("review"); }));
}

// ---- review ------------------------------------------------------------------------
function renderShots() {
  const p = project; if (!p) return;
  $("#review-title").textContent = p.title || "Planning your shots…"; $("#review-logline").textContent = p.logline || p.request;
  const jobFor = (shotId, type) => p.jobs?.find((j) => j.shotId === shotId && j.type === type && j.status !== "done");
  const planJob = p.jobs?.find((j) => j.type === "plan" && j.status !== "done");
  if (!p.shots.length) { $("#shots").innerHTML = `<div class="card">${planJob?.status === "failed" ? `<span style="color:var(--bad)">${esc(planJob.error)}</span>` : `<div class="bar"><i style="width:${Math.round(((planJob?.progress) || 0.15) * 100)}%"></i></div><p class="muted" style="margin-top:8px">${esc(planJob?.note || "planning the shot list…")}</p>`}</div>`; }
  else $("#shots").innerHTML = p.shots.map((s) => {
    const sj = jobFor(s.id, "still"), aj = jobFor(s.id, "animate");
    const foot = s.source === "footage" ? profile.footage.find((f) => f.id === s.footageId) ?? profile.footage.find((f) => f.usage === "exact") : null;
    const mediaHtml = s.clip ? `<video src="${media(s.clip.rel)}" controls muted loop playsinline></video><span class="badge">clip · ${esc(s.clip.provider)}</span>`
      : foot ? (foot.kind === "clip" ? `<video src="${media(foot.rel)}" controls muted loop playsinline></video>` : `<img src="${media(foot.rel)}" alt="">`) + `<span class="badge">your footage</span>`
      : s.still ? `<img src="${media(s.still.rel)}" alt=""><span class="badge">still · ${esc(s.still.provider)}</span>`
      : sj ? `<div><div class="bar" style="width:200px"><i style="width:${Math.round((sj.progress || 0.1) * 100)}%"></i></div><p class="muted">${esc(sj.note || sj.status)}</p></div>` : `<span class="muted">no still yet</span>`;
    const crit = s.critique ? `<div class="critique ${s.critique.verdict === "approve" ? "ok" : ""}">QA: likeness ${s.critique.likenessScore == null ? "n/a" : Math.round(s.critique.likenessScore * 100) + "%"} · ${s.critique.verdict}${s.critique.issues?.length ? " — " + esc(s.critique.issues.join("; ")) : ""}</div>` : "";
    return `<div class="shot ${s.approved ? "approved" : ""}">
      <div class="media">${mediaHtml}${aj ? `<span class="badge" style="top:auto;bottom:8px">${esc(aj.note || "animating…")}</span>` : ""}</div>
      <div class="body">
        <div class="title"><span>${s.n}. ${esc(s.title)}</span><span class="muted">${s.seconds} s · ${s.source}</span></div>
        <div class="meta">${esc(s.setting)} · ${esc(s.action)} · ${esc(s.framing)} · ${esc(s.cameraMotion)}</div>
        ${s.source === "generate" ? `<textarea data-prompt="${s.id}" title="still prompt">${esc(s.stillPrompt)}</textarea>${crit}` : `<div class="meta">${foot ? esc(foot.originalName) : "no matching footage"}</div>`}
        <div class="actions">
          ${s.source === "generate" ? `<button data-still="${s.id}" ${sj ? "disabled" : ""}>${s.still ? "Regenerate still" : "Generate still"}</button>
            <button data-approve="${s.id}" ${!s.still ? "disabled" : ""}>${s.approved ? "✓ Approved" : "Approve"}</button>
            ${s.still && !s.clip ? `<button data-animate="${s.id}" ${!s.approved || aj ? "disabled" : ""}>Animate</button>` : ""}` : `<span class="tag exact">used as uploaded</span>`}
        </div>
      </div></div>`;
  }).join("");
  $$("[data-still]").forEach((b) => (b.onclick = async () => { const ta = $(`[data-prompt="${b.dataset.still}"]`); project = await api("POST", `/api/projects/${p.id}/shots/${b.dataset.still}/still`, { stillPrompt: ta?.value }); renderShots(); }));
  $$("[data-approve]").forEach((b) => (b.onclick = async () => { const s = p.shots.find((x) => x.id === b.dataset.approve); project = await api("POST", `/api/projects/${p.id}/shots/${s.id}/approve`, { approved: !s.approved }); renderShots(); }));
  $$("[data-animate]").forEach((b) => (b.onclick = async () => { await api("POST", `/api/projects/${p.id}/shots/${b.dataset.animate}/approve`, { approved: true }); const r = await api("POST", `/api/projects/${p.id}/animate`); project = r.project; renderShots(); }));
  const rj = p.jobs?.find((j) => j.type === "render" && j.status !== "done");
  $("#render").innerHTML = p.render ? `<video src="${media(p.render.rel)}" controls playsinline></video><div class="row"><a href="${media(p.render.rel)}" download="reel.mp4"><button class="primary">Download reel</button></div>` : rj ? `<div class="bar" style="margin-top:10px"><i style="width:${Math.round((rj.progress || 0.1) * 100)}%"></i></div><p class="muted">${esc(rj.status === "failed" ? rj.error : rj.note || "rendering…")}</p>` : "";
  const gen = p.shots.filter((s) => s.source === "generate");
  status(p.shots.length ? `${gen.filter((s) => s.still).length}/${gen.length} stills · ${gen.filter((s) => s.approved).length} approved · ${gen.filter((s) => s.clip).length} animated` : "");
}
$("#btn-stills").onclick = async () => { for (const s of project.shots) if (s.source === "generate" && !s.still) project = await api("POST", `/api/projects/${project.id}/shots/${s.id}/still`, {}); renderShots(); };
$("#btn-animate").onclick = async () => { const r = await api("POST", `/api/projects/${project.id}/animate`); project = r.project; renderShots(); status(r.queued ? `animating ${r.queued} shot(s)` : "approve at least one still first"); };
$("#btn-render").onclick = async () => { project = await api("POST", `/api/projects/${project.id}/render`); renderShots(); };
$("#btn-replan").onclick = async () => { project = await api("POST", `/api/projects/${project.id}/replan`); renderShots(); };

// ---- polling: refresh while any job runs -------------------------------------------
let modeText = "";
async function poll() {
  try {
    if (profile) { const fresh = await api("GET", `/api/profiles/${profile.id}`); if (JSON.stringify(fresh) !== JSON.stringify(profile)) { profile = fresh; if (!$("[data-panel=profile]").hidden || !$("[data-panel=footage]").hidden) renderProfile(); } }
    if (project) { const fresh = await api("GET", `/api/projects/${project.id}`); if (JSON.stringify(fresh) !== JSON.stringify(project)) { project = fresh; if (!$("[data-panel=review]").hidden) renderShots(); } }
  } catch {}
  polling = setTimeout(poll, 2000);
}
api("GET", "/api/health").then((h) => { modeText = h.generators.mode === "preview" ? "preview mode · add FAL_KEY / RUNWAY_API_KEY for real generation" : `live · ${h.generators.image} + ${h.generators.video}`; $("#mode").textContent = modeText; }).catch(() => ($("#mode").textContent = "backend offline"));
loadProfile().then(poll);
