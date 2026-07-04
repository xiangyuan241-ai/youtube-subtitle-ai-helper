# 体验服务部署

## 1. 安装并登录

```powershell
cd worker
npm install
npx wrangler login
```

## 2. 创建 KV

```powershell
npx wrangler kv namespace create TRIALS
```

把命令返回的 `id` 填入 `wrangler.jsonc` 中的 `kv_namespaces[0].id`。

邀请码使用 KV 做白名单，5 次额度由 Durable Object 原子计数；部署时会自动创建，无需手动配置。

## 3. 保存 DeepSeek Key

```powershell
npx wrangler secret put DEEPSEEK_API_KEY
```

根据提示粘贴 Key。不要把 Key 写入源代码、配置文件或聊天消息。

## 4. 测试并部署

```powershell
npm test
npm run deploy
```

部署成功后会得到类似 `https://youtube-subtitle-ai-helper-api.<你的子域>.workers.dev` 的地址。

## 5. 配置扩展地址

```powershell
npm run configure-extension -- https://youtube-subtitle-ai-helper-api.<你的子域>.workers.dev
```

该命令会同时更新 `background/config.js` 和 `manifest.json`。

## 6. 创建 5 次体验邀请码

```powershell
npm run invite -- --write
```

每执行一次生成一个新邀请码，并写入远程 KV。把输出的邀请码单独发给测试用户。

## 7. 重新加载扩展

打开 `chrome://extensions`，重新加载扩展，然后在设置页选择“免费体验”并输入邀请码。

默认安全限制：每个邀请码 5 次成功解析、每个 IP 每分钟 6 次请求、全部用户每天最多 100 次请求。可在 `wrangler.jsonc` 调整全局限制，但 `TRIAL_LIMIT` 应保持为 `5`。
