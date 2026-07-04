import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const workerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = path.resolve(workerRoot, "..");
const input = process.argv[2];

if (!input) {
  console.error("用法：npm run configure-extension -- https://你的-worker.workers.dev");
  process.exit(1);
}

let origin;
try {
  const parsed = new URL(input);
  if (parsed.protocol !== "https:") {
    throw new Error("必须使用 HTTPS");
  }
  origin = parsed.origin;
} catch (error) {
  console.error(`Worker 地址无效：${error.message}`);
  process.exit(1);
}

const endpoint = `${origin}/v1/analyze`;
const configPath = path.join(extensionRoot, "background", "config.js");
const manifestPath = path.join(extensionRoot, "manifest.json");
const configText = await readFile(configPath, "utf8");
const oldUrlMatch = configText.match(/trialApiUrl:\s*"([^"]+)"/);
const oldOrigin = oldUrlMatch ? new URL(oldUrlMatch[1]).origin : "";
const nextConfig = configText.replace(
  /trialApiUrl:\s*"[^"]+"/,
  `trialApiUrl: ${JSON.stringify(endpoint)}`
);

if (nextConfig === configText) {
  throw new Error("没有在 background/config.js 中找到 trialApiUrl。");
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const oldPermission = oldOrigin ? `${oldOrigin}/*` : "";
const nextPermission = `${origin}/*`;
manifest.host_permissions = (manifest.host_permissions || []).filter((item) => (
  item !== oldPermission && !String(item).includes("replace-me.workers.dev")
));
if (!manifest.host_permissions.includes(nextPermission)) {
  manifest.host_permissions.push(nextPermission);
}

await Promise.all([
  writeFile(configPath, nextConfig, "utf8"),
  writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
]);

console.log(`体验接口已配置：${endpoint}`);
console.log(`扩展权限已配置：${nextPermission}`);
