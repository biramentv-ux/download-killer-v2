import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

const required = [
  "background.js", "content.js", "popup.html", "popup.js", "styles.css",
  "utils/api.js", "utils/metadata.js", "utils/storage.js", "utils/validators.js",
  "icons/icon16.png", "icons/icon48.png", "icons/icon128.png"
];

for (const file of required) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`Missing ${file}`);
}

if (manifest.manifest_version !== 3) throw new Error("Manifest V3 is required");
for (const forbiddenPermission of ["webRequest", "webRequestBlocking", "declarativeNetRequestWithHostAccess"]) {
  if (manifest.permissions?.includes(forbiddenPermission)) {
    throw new Error(`Forbidden/unneeded permission: ${forbiddenPermission}`);
  }
}

const sources = required
  .filter((file) => /\.(?:js|html|css)$/.test(file))
  .map((file) => fs.readFileSync(path.join(root, file), "utf8"))
  .join("\n");

for (const forbidden of [
  "Widevine", "PlayPlay DRM", "re-unplayplay", "PSSH", "obfuscatedKey",
  "window.fetch =", "XMLHttpRequest.prototype.open =", "audio-files"
]) {
  if (sources.includes(forbidden)) throw new Error(`Forbidden implementation marker: ${forbidden}`);
}

console.log("Extension structure validated.");
