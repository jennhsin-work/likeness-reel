"""Build the reel's audio mix as a WAV: a music bed (synthesised by mood, or the
user's own track) with optional narration ducked over it.

usage: audio.py <spec.json> <out.wav>
spec: { duration, music: { mode: synth|file|none, mood: warm|upbeat|calm, path },
        narration: [{ text, at }], voice }
Narration uses the macOS `say` voice synthesiser; without it the mix is music only.
Prints one JSON line: { music, narration: <lines spoken> }
"""
import sys, os, json, math, shutil, subprocess, tempfile
import warnings; warnings.simplefilter("ignore")
import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, lfilter, resample_poly

spec = json.load(open(sys.argv[1])); out = sys.argv[2]; os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
SR = 44100; D = float(spec["duration"]); N = int(D * SR)
t = np.arange(N) / SR
tmp = tempfile.mkdtemp(prefix="reel_audio_")


def lowpass(x, hz):
    b, a = butter(2, hz / (SR / 2)); return lfilter(b, a, x)


def read_wav(path):
    sr, x = wavfile.read(path)
    x = x.astype(np.float32) / (32768.0 if x.dtype == np.int16 else 2147483648.0 if x.dtype == np.int32 else 1.0)
    if x.ndim > 1: x = x.mean(axis=1)
    return resample_poly(x, SR, sr).astype(np.float32) if sr != SR else x


MOODS = {  # bpm, chord roots (MIDI) with intervals, arpeggio level
    "warm":   (84,  [(57, (0, 3, 7, 10)), (53, (0, 4, 7, 11)), (60, (0, 4, 7, 11)), (55, (0, 4, 7, 9))], 0.22),
    "upbeat": (112, [(60, (0, 4, 7, 11)), (55, (0, 4, 7, 9)), (57, (0, 3, 7, 10)), (53, (0, 4, 7, 11))], 0.34),
    "calm":   (66,  [(50, (0, 5, 7, 10)), (48, (0, 4, 7, 11)), (53, (0, 4, 7, 11)), (48, (0, 4, 7, 9))], 0.12),
}
hz = lambda m: 440.0 * 2 ** ((m - 69) / 12)


def synth(mood):
    bpm, chords, arp = MOODS.get(mood, MOODS["warm"])
    beat = 60 / bpm; bar = beat * 4; x = np.zeros(N, np.float32)
    for bi in range(int(math.ceil(D / bar))):
        root, iv = chords[bi % len(chords)]; a = int(bi * bar * SR); b = min(N, int((bi + 1) * bar * SR) + int(0.4 * SR))
        if a >= N: break
        tt = np.arange(b - a) / SR
        env = np.minimum(1, tt / 0.5) * np.minimum(1, (tt[-1] - tt) / 0.5 + 0.001)
        pad = sum(np.sin(2 * np.pi * hz(root + i) * (1 + d) * tt) for i in iv for d in (-0.003, 0.003)) / (2 * len(iv))
        pad = pad + 0.5 * np.sin(2 * np.pi * hz(root - 12) * tt)                  # bass
        x[a:b] += (0.30 * pad * env).astype(np.float32)
        for k in range(8):                                                          # eighth-note arpeggio
            n0 = a + int(k * beat / 2 * SR)
            if n0 >= N: break
            n1 = min(N, n0 + int(0.6 * SR)); tk = np.arange(n1 - n0) / SR
            note = hz(root + 12 + iv[(k * 2 + bi) % len(iv)])
            pluck = (np.sin(2 * np.pi * note * tk) + 0.3 * np.sin(4 * np.pi * note * tk)) * np.exp(-tk * 6)
            x[n0:n1] += (arp * 0.5 * pluck).astype(np.float32)
    return lowpass(x, 3800).astype(np.float32)


# ---- music bed -------------------------------------------------------------------
music = spec.get("music") or {}; mode = music.get("mode", "synth"); used = "none"
bed = np.zeros(N, np.float32)
if mode == "file" and music.get("path") and os.path.exists(music["path"]) and shutil.which("afconvert"):
    wav = os.path.join(tmp, "music.wav")
    r = subprocess.run(["afconvert", "-f", "WAVE", "-d", f"LEI16@{SR}", "-c", "1", music["path"], wav], capture_output=True)
    if r.returncode == 0:
        x = read_wav(wav); bed = np.resize(x, N) if len(x) else bed
        peak = float(np.abs(bed).max()) or 1.0; bed = bed / peak * 0.5; used = "file"
if used == "none" and mode != "none":
    bed = synth(music.get("mood", "warm")); used = f"synth:{music.get('mood', 'warm')}"
fade = np.minimum(1, t / 0.8) * np.minimum(1, (D - t) / 1.6)
bed = bed * fade.astype(np.float32)

# ---- narration ---------------------------------------------------------------------
voice = np.zeros(N, np.float32); spoken = 0
if shutil.which("say"):
    for i, line in enumerate(spec.get("narration") or []):
        text = (line.get("text") or "").strip()
        if not text: continue
        wav = os.path.join(tmp, f"vo_{i}.wav")
        cmd = ["say", "--data-format=LEI16@44100", "-o", wav] + (["-v", spec["voice"]] if spec.get("voice") else []) + [text]
        if subprocess.run(cmd, capture_output=True).returncode != 0 or not os.path.exists(wav): continue
        x = read_wav(wav); a = int(max(0, float(line.get("at", 0))) * SR)
        if a >= N: continue
        x = x[: N - a]; voice[a:a + len(x)] += x; spoken += 1
if spoken:  # duck the bed under speech
    env = lowpass(np.abs(voice), 4.0); env = np.clip(env / (env.max() or 1) * 6, 0, 1)
    bed = bed * (1 - 0.68 * env).astype(np.float32)
    voice = voice / (np.abs(voice).max() or 1) * 0.9

mix = bed * 0.8 + voice
mix = mix / max(1.0, float(np.abs(mix).max()) / 0.97)
stereo = np.stack([mix, mix], axis=1)
wavfile.write(out, SR, (stereo * 32767).astype(np.int16))
shutil.rmtree(tmp, ignore_errors=True)
print(json.dumps({"music": used, "narration": spoken}))
