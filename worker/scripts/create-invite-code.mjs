import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const workerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shouldWrite = process.argv.includes("--write");
const code = `SAI_${randomBytes(18).toString("base64url")}`;
const hash = createHash("sha256").update(code).digest("hex");
const key = `invite:${hash}`;
const value = JSON.stringify({
  limit: 5,
  enabled: true,
  createdAt: new Date().toISOString()
});

if (shouldWrite) {
  const wranglerEntry = path.join(workerRoot, "node_modules", "wrangler", "bin", "wrangler.js");
  const result = spawnSync(process.execPath, [
    wranglerEntry,
    "kv",
    "key",
    "put",
    key,
    value,
    "--binding",
    "TRIALS",
    "--remote"
  ], {
    cwd: workerRoot,
    stdio: "inherit",
    shell: false
  });

  if (result.status !== 0) {
    if (result.error) {
      console.error(result.error.message);
    }
    process.exit(result.status || 1);
  }
}

console.log(`邀请码：${code}`);
console.log("额度：5 次成功解析");
if (!shouldWrite) {
  console.log("当前仅生成，尚未写入 Cloudflare KV。");
  console.log("部署完成后运行：npm run invite -- --write");
}
