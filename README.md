# Subtitle AI Helper

一款面向中文英语学习者的 Chrome 扩展。它可以在观看 YouTube 视频时读取当前字幕及上下文，提供中文解释、语气分析、重点词汇和短语示例，并把值得学习的表达保存到本地复习清单。

> 本项目与 YouTube、Google、OpenAI 或 DeepSeek 没有隶属或官方合作关系。

## 功能

- 分析当前 YouTube 字幕并结合前后文解释
- 在视频字幕中定位单词及其完整句子
- 朗读句子或重播对应视频片段
- 保存句子、解释、视频来源和时间位置
- 根据“记住、模糊、没记住”安排后续复习
- 支持自备 OpenAI 兼容 API Key
- 支持通过 Cloudflare Worker 提供限次体验服务

## 本地安装

1. 下载本仓库源码并解压。
2. 在 Chrome 中打开 `chrome://extensions/`。
3. 开启右上角的“开发者模式”。
4. 点击“加载已解压的扩展程序”。
5. 选择包含 `manifest.json` 的项目根目录。
6. 打开扩展设置，选择体验服务或配置自己的 API。

开发者模式安装的扩展不会通过 Chrome Web Store 自动更新。更新时需要重新下载源码并在扩展管理页点击“重新加载”。

## API Key 安全

仓库不包含项目维护者的生产 API Key。

- 体验服务的 DeepSeek Key 只保存在 Cloudflare Worker Secret 中。
- 自备 API Key 保存在 `chrome.storage.session`，不会写入仓库，并会在浏览器会话结束后清除。
- 不要把真实 Key 写入 `manifest.json`、`background/config.js`、`.env` 或 `.dev.vars` 后提交。

## 自行部署体验服务

Worker 部署说明见 [`worker/DEPLOY.md`](worker/DEPLOY.md)。部署时使用以下命令保存密钥：

```powershell
npx wrangler secret put DEEPSEEK_API_KEY
```

部署完成后，使用项目脚本更新扩展中的 Worker 地址：

```powershell
cd worker
npm run configure-extension -- https://your-worker.workers.dev
```

## 开发与测试

扩展主体不需要构建步骤，可以直接通过 Chrome 开发者模式加载。

Worker 测试：

```powershell
cd worker
npm install
npm test
```

## 隐私说明

执行 AI 分析时，当前字幕、字幕上下文、视频标题和播放时间会被发送到用户选择的 AI 服务，或发送到项目配置的体验 Worker。学习清单和复习记录默认保存在浏览器本地存储中。

在使用或分发本项目之前，请根据你的部署方式和适用地区补充正式隐私政策。

## 项目结构

```text
background/   扩展后台服务与配置
content/      YouTube 页面注入和字幕交互
pages/        设置、学习清单和复习页面
shared/       本地学习记录与复习调度
worker/       Cloudflare Worker 体验服务
manifest.json Chrome 扩展清单
```

## 反馈

测试期间可以通过 GitHub Issues 提交问题。请勿在 Issue、截图或日志中粘贴 API Key、邀请码或其他敏感信息。
