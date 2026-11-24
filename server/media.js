// Private media store on local disk: data/profiles/<id>/{faces,bodies,footage,frames}
// and data/projects/<id>/{stills,clips,renders}. Nothing here is served publicly;
// the dev server exposes /media/* to the local UI only.
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { DATA_DIR, uid } from "./db.js";
export { uid };

const EXT = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm" };

export function saveUpload(dir, { name, type, data }) {
  mkdirSync(join(DATA_DIR, dir), { recursive: true });
  const ext = EXT[type] || extname(name || "") || ".bin";
  const file = `${uid("m")}${ext}`; const path = join(DATA_DIR, dir, file);
  writeFileSync(path, Buffer.from(data, "base64"));
  return { file, path, rel: `${dir}/${file}`, type, bytes: statSync(path).size, originalName: basename(name || file) };
}
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
  return { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".json": "application/json" }[ext] || "application/octet-stream";
}
