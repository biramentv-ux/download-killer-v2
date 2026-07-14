import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

const required = [
  "manifest.json",
  "background.js",
  "content.js",
  "popup.html",
  "popup.js",
  "styles.css",
  "utils/api.js",
  "utils/metadata.js",
  "utils/storage.js",
  "utils/validators.js",
  "icons/icon16.png",
  "icons/icon48.png",
  "icons/icon128.png"
];

const allowedRuntimeFiles = new Set(required.filter((file) =>
  /\.(?:js|mjs|ts|json|html|css|wasm)$/i.test(file)
));

const ignoredTopLevelDirectories = new Set(["scripts", "tests"]);
const executableExtensions = new Set([".js", ".mjs", ".cjs", ".ts", ".wasm"]);
const forbiddenPathFragments = [
  "content_key_decryption",
  "eme_interception",
  "widevine",
  "decryptor",
  "clearkey",
  "widevinecdm",
  "pssh"
];

const forbiddenSourcePatterns = [
  { label: "Widevine/CDM implementation", pattern: /\bwidevine(?:cdm)?\b/i },
  { label: "EME session interception", pattern: /\bMediaKeySession\b|requestMediaKeySystemAccess|eme[_ -]?interception/i },
  { label: "content-key extraction", pattern: /content[_ -]?key[_ -]?(?:decrypt|extract|log)|plaintext[^\n]{0,80}\bkey\b|Found key:/i },
  { label: "CENC decryption command", pattern: /-decryption_key\b|\bmpeg-cenc\b|\bcenc decrypt/i },
  { label: "ClearKey conversion", pattern: /\bclear[_ -]?key\b/i },
  { label: "license challenge interception", pattern: /license[_ -]?(?:challenge|response)[^\n]{0,80}(?:intercept|decrypt|key)/i },
  { label: "PlayPlay implementation", pattern: /re-unplayplay|PlayPlay DRM|obfuscatedKey/i },
  { label: "page-world network monkey patch", pattern: /window\.fetch\s*=|XMLHttpRequest\.prototype\.open\s*=/i },
  { label: "protected audio endpoint interception", pattern: /audio-files|playlist\/v1\/audio/i }
];

function walk(directory, prefix = "") {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!prefix && ignoredTopLevelDirectories.has(entry.name)) continue;
      files.push(...walk(path.join(directory, entry.name), relative));
    } else {
      files.push(relative.replaceAll("\\", "/"));
    }
  }
  return files;
}

for (const file of required) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`Missing ${file}`);
}

if (manifest.manifest_version !== 3) throw new Error("Manifest V3 is required");
if (manifest.web_accessible_resources?.length) {
  throw new Error("web_accessible_resources are not allowed for this companion extension");
}

for (const forbiddenPermission of [
  "webRequest",
  "webRequestBlocking",
  "declarativeNetRequestWithHostAccess",
  "scripting",
  "debugger"
]) {
  if (manifest.permissions?.includes(forbiddenPermission)) {
    throw new Error(`Forbidden/unneeded permission: ${forbiddenPermission}`);
  }
}

const contentScriptMatches = (manifest.content_scripts || []).flatMap((entry) => entry.matches || []);
if (contentScriptMatches.some((match) => match === "<all_urls>" || match.includes("https://*/*"))) {
  throw new Error("Broad all-site content-script access is forbidden");
}
if (!contentScriptMatches.every((match) => match === "https://open.spotify.com/*")) {
  throw new Error("Content scripts may run only on https://open.spotify.com/*");
}

const runtimeFiles = walk(root).filter((file) => {
  const topLevel = file.split("/")[0];
  if (ignoredTopLevelDirectories.has(topLevel)) return false;
  if (file === "package.json") return false;
  return executableExtensions.has(path.extname(file).toLowerCase()) || file === "manifest.json";
});

for (const file of runtimeFiles) {
  const normalizedPath = file.toLowerCase();
  if (!allowedRuntimeFiles.has(file)) {
    throw new Error(`Unapproved runtime file: ${file}`);
  }
  for (const fragment of forbiddenPathFragments) {
    if (normalizedPath.includes(fragment)) {
      throw new Error(`Forbidden runtime filename marker in ${file}: ${fragment}`);
    }
  }

  if (path.extname(file).toLowerCase() === ".wasm") {
    throw new Error(`WASM runtime is not permitted: ${file}`);
  }

  const source = fs.readFileSync(path.join(root, file), "utf8");
  for (const check of forbiddenSourcePatterns) {
    if (check.pattern.test(source)) {
      throw new Error(`Forbidden implementation in ${file}: ${check.label}`);
    }
  }
}

console.log(`Extension structure and DRM boundaries validated across ${runtimeFiles.length} runtime files.`);
