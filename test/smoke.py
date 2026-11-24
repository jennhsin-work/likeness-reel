"""End-to-end smoke test against a running backend, using the synthetic samples.
Walks the whole pipeline: profile -> consent -> photos -> footage -> plan ->
stills -> approve -> animate -> render (with music + narration).

usage: python3 test/smoke.py [http://127.0.0.1:8790]
Creates its own profile and deletes it at the end (pass --keep to leave it).
"""
import json, os, sys, time, subprocess, urllib.request, urllib.parse, urllib.error

BASE = next((a for a in sys.argv[1:] if a.startswith("http")), "http://127.0.0.1:8790")
KEEP = "--keep" in sys.argv
SAMPLES = "data/samples"
if not os.path.exists(f"{SAMPLES}/face_0.jpg"): subprocess.run(["python3", "-I", "scripts/samples.py", SAMPLES], check=True)


def call(method, path, body=None, raw=None, ctype="application/json", expect=200):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else (b"{}" if method == "POST" else None))
    req = urllib.request.Request(BASE + path, data=data, method=method, headers={"content-type": ctype})
    try:
        with urllib.request.urlopen(req) as r: status, out = r.status, json.load(r)
    except urllib.error.HTTPError as e: status, out = e.code, json.load(e)
    assert status == expect, f"{method} {path}: expected {expect}, got {status} {out}"
    return out


def upload(pid, kind, file, ctype, **q):
    qs = urllib.parse.urlencode({"kind": kind, "name": os.path.basename(file), **q})
    return call("POST", f"/api/profiles/{pid}/upload?{qs}", raw=open(file, "rb").read(), ctype=ctype)


def wait(get, done, what, timeout=240):
    t0 = time.time()
    while time.time() - t0 < timeout:
        doc = get(); failed = [j for j in doc["jobs"] if j["status"] == "failed"]
        assert not failed, f"{what}: job failed: {failed[0]['type']} - {failed[0]['error']}"
        if done(doc): print(f"  ok  {what}  ({time.time() - t0:.0f}s)"); return doc
        time.sleep(2)
    raise AssertionError(f"{what}: timed out")


print(call("GET", "/api/health"))
prof = call("POST", "/api/profiles", {"name": "Smoke test"}); pid = prof["id"]
try:
    # guards: nothing generates without consent; bad uploads are refused
    call("POST", "/api/projects", {"profileId": pid, "request": "A weekend in Paris"}, expect=403)
    call("POST", f"/api/profiles/{pid}/upload?kind=face&name=notes.txt", raw=b"hello", ctype="text/plain", expect=400)
    call("POST", f"/api/profiles/{pid}/consent", {"consent": True})

    for i in range(3): upload(pid, "face", f"{SAMPLES}/face_{i}.jpg", "image/jpeg")
    upload(pid, "body", f"{SAMPLES}/body_0.jpg", "image/jpeg")
    upload(pid, "footage", f"{SAMPLES}/cafe.mp4", "video/mp4", usage="exact")
    upload(pid, "footage", f"{SAMPLES}/street.jpg", "image/jpeg", usage="inspiration")
    get_prof = lambda: call("GET", f"/api/profiles/{pid}")
    prof = wait(get_prof, lambda p: p["likeness"] and all(f["status"] == "ready" for f in p["footage"]) and not p["jobs"], "likeness notes + footage analysis")
    assert prof["primaryFaceId"] and prof["primaryBodyId"], "references were not chosen"

    # user picks their own primary reference and corrects the notes
    other = next(f["id"] for f in prof["faces"] if f["id"] != prof["primaryFaceId"])
    assert call("POST", f"/api/profiles/{pid}/photos/{other}", {"primary": True})["primaryFaceId"] == other
    assert call("POST", f"/api/profiles/{pid}/likeness", {"signatureStyle": "rust tunic, dark trousers"})["likeness"]["edited"]

    proj = call("POST", "/api/projects", {"profileId": pid, "request": "Make a 15-second video of me enjoying a weekend in Paris", "durationSec": 15, "aspect": "9:16"}); jid = proj["id"]
    get = lambda: call("GET", f"/api/projects/{jid}")
    proj = wait(get, lambda p: p["shots"] and not p["jobs"], "shot list")
    gen = [s for s in proj["shots"] if s["source"] == "generate"]; foot = [s for s in proj["shots"] if s["source"] == "footage"]
    print(f"      {len(gen)} generated + {len(foot)} footage shots, {proj['progress']['seconds']} s: " + " | ".join(f"{s['title']} ({s['seconds']}s)" for s in proj["shots"]))
    assert len(gen) >= 2 and len(foot) >= 1, "MVP shape is two generated shots plus one footage segment"
    assert abs(proj["progress"]["seconds"] - 15) <= 2, "shot lengths should add up to the requested duration"

    # the checkpoint: animation is refused until the still is approved
    call("POST", f"/api/projects/{jid}/shots/{gen[0]['id']}/animate", expect=409)
    assert call("POST", f"/api/projects/{jid}/stills")["queued"] == len(gen)
    proj = wait(get, lambda p: p["progress"]["stills"] == len(gen) and not p["jobs"], "stills")
    call("POST", f"/api/projects/{jid}/shots/{gen[0]['id']}/still"); proj = wait(get, lambda p: not p["jobs"] and len(next(s for s in p["shots"] if s["id"] == gen[0]["id"])["history"]) == 1, "regenerate one still (keeps the old version)")
    call("POST", f"/api/projects/{jid}/shots/{gen[0]['id']}/restore", {"index": 0})
    for s in gen: call("POST", f"/api/projects/{jid}/shots/{s['id']}/approve", {"approved": True})

    # edit the list: caption, reorder, settings
    call("POST", f"/api/projects/{jid}/shots/{gen[0]['id']}", {"caption": "Bonjour, Paris"})
    assert [s["n"] for s in call("POST", f"/api/projects/{jid}/shots/{proj['shots'][-1]['id']}/move", {"dir": -1})["shots"]] == list(range(1, len(proj["shots"]) + 1))
    call("POST", f"/api/projects/{jid}/settings", {"narration": True, "mood": "upbeat"})

    assert call("POST", f"/api/projects/{jid}/animate")["queued"] == len(gen)
    proj = wait(get, lambda p: p["progress"]["clips"] == len(gen) and not p["jobs"], "animation")
    call("POST", f"/api/projects/{jid}/render")
    proj = wait(get, lambda p: p["render"] and not p["jobs"], "render")
    r = proj["render"]; path = f"data/{r['rel']}"
    print(f"      {r['rel']}  {r['duration']} s  audio={r['audio']}  note={r['note']}")
    assert os.path.getsize(path) > 100_000 and r["segments"] == len(proj["shots"])
    assert r["audio"]["music"] != "none", "the reel should have a music bed"
    print("PASS")
finally:
    if not KEEP: call("DELETE", f"/api/profiles/{pid}"); assert not os.path.exists(f"data/profiles/{pid}"), "profile media was not deleted"
