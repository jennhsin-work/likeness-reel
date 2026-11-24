// Private media store on local disk: data/profiles/<id>/{faces,bodies,footage,frames}
// and data/projects/<id>/{stills,clips,renders}. Nothing here is served publicly;
// the dev server exposes /media/* to the local UI only.
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, statSync, createWriteStream, unlinkSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";
import { join, extname, basename } from "node:path";
import { DATA_DIR, uid } from "./db.js";
export { uid };

const EXT = { "image/heic": ".heic", "image/heif": ".heic", "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "audio/x-m4a": ".m4a", "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/aac": ".aac", "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm" };

export function saveUpload(dir, { name, type, data }) {
  mkdirSync(join(DATA_DIR, dir), { recursive: true });
  const ext = EXT[type] || extname(name || "") || ".bin";
  const file = `${uid("m")}${ext}`; const path = join(DATA_DIR, dir, file);
  writeFileSync(path, Buffer.from(data, "base64"));
  return { file, path, rel: `${dir}/${file}`, type, bytes: statSync(path).size, originalName: basename(name || file) };
}
/** Stream a request body straight to disk (no base64, no buffering the whole file).
 *  iPhone HEIC photos are converted to JPEG with macOS `sips` so OpenCV and browsers can read them. */
export async function saveStream(dir, { name, type, stream, maxBytes = 600e6 }) {
  mkdirSync(join(DATA_DIR, dir), { recursive: true });
  let ext = (EXT[type] || extname(name || "") || ".bin").toLowerCase();
  let file = `${uid("m")}${ext}`; let path = join(DATA_DIR, dir, file); let seen = 0;
  stream.on("data", (c) => { seen += c.length; if (seen > maxBytes) stream.destroy(new Error("invalid: file is too large")); });
  try { await pipeline(stream, createWriteStream(path)); } catch (e) { rmSync(path, { force: true }); throw e; }
  if (ext === ".heic" || ext === ".heif") {
    const jpg = path.replace(/\.[^.]+$/, ".jpg");
    if (spawnSync("sips", ["-s", "format", "jpeg", path, "--out", jpg]).status === 0 && existsSync(jpg)) { unlinkSync(path); path = jpg; file = basename(jpg); ext = ".jpg"; type = "image/jpeg"; }
    else { rmSync(path, { force: true }); throw new Error("invalid: could not read this HEIC photo - export it as JPEG"); }
  }
  const bytes = statSync(path).size; if (!bytes) { rmSync(path, { force: true }); throw new Error("invalid: empty upload"); }
  return { file, rel: `${dir}/${file}`, type: type || contentType(file), bytes, originalName: basename(name || file) };
}
export function removeFile(rel) { if (rel) for (const extra of ["", ".plate.jpg", ".subject.png", ".spec.json"]) rmSync(join(DATA_DIR, rel + extra), { force: true }); }
export function saveBuffer(dir, file, buf) { mkdirSync(join(DATA_DIR, dir), { recursive: true }); const path = join(DATA_DIR, dir, file); writeFileSync(path, buf); return { file, path, rel: `${dir}/${file}` }; }
export function mediaPath(rel) { return join(DATA_DIR, rel); }
export function removeDir(dir) { const p = join(DATA_DIR, dir); if (existsSync(p)) rmSync(p, { recursive: true, force: true }); }
export function toDataUri(rel) {
  const p = mediaPath(rel); const ext = extname(p).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  return `data:${mime};base64,${readFileSync(p).toString("base64")}`;
}
export function imageBlock(rel) {
  const p = mediaPath(rel); const ext = extname(p).toLowerCase();
  const media_type = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  return { type: "image", source: { type: "base64", media_type, data: readFileSync(p).toString("base64") } };
}
export function contentType(rel) {
  const ext = extname(rel).toLowerCase();
  return { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".json": "application/json", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".aac": "audio/aac" }[ext] || "application/octet-stream";
}
