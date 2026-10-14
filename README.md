# HEIPANG Meta

HEIPANG 的并行版本桌面客户端（Electron + React + TypeScript），跑在 pi 编码代理引擎（`@earendil-works/pi-*`）之上。和老版 `HEIPANG.app` 可以同时安装、互不影响。

## 环境要求

- macOS（arm64）本地构建；Windows 用 CI 打包
- Node 22+（`/opt/homebrew/bin`），npm
- 一份 `~/.pi/agent/` 共享配置（见下）

## 首次拉取

```bash
git clone https://github.com/kuaai/heipang.git
cd heipang
npm install
npm run typecheck
```

## 开发 / 构建

```bash
npm run dev            # electron-vite 开发预览
npm run typecheck      # 类型检查
npm run build          # 产出 out/（不打包）
npm run pack:meta:mac:dir   # 打包成 HEIPANG Meta.app（release-meta/mac-arm64/）
npm run pack:meta:mac       # 打包 dmg（release-meta/HEIPANG-Meta-arm64.dmg）
```

## 关键：共享配置不在本仓库

App 读写的模型、登录凭证、扩展、技能都在 **`~/.pi/agent/`**，不在仓库里：

- `auth.json` / `models.json` / `settings.json`
- `extensions/`（含 read-url、read-page、force-opus-xhigh 等）
- `skills/`
- npm 包目录 `~/.pi/agent/npm/`（Antigravity/Gemini、DeepSeek 等第三方 provider 通过 `pi install npm:...` 装在这里）

所以同事拉取仓库后，需要自己的 `~/.pi/agent` 配置才能登录模型。Antigravity（Gemini）用：

```bash
pi install npm:pi-antigravity
```

## 测试

```bash
npm run test:performance   # 流式解码、PDF 转换、会话索引、IPC 补丁等
npm run test:deepseek      # DeepSeek 接入
npm run test:antigravity   # Antigravity OAuth 接线
```

## 发版

源码在私有仓库 `kuaai/heipang`；安装包和更新源在公开仓库 `kuaai/heipang-releases`：

- 资产：`HEIPANG-Meta-arm64.dmg` / `HEIPANG-Meta-Setup.exe`（`meta-latest` tag）
- 更新源：`meta-latest.json`（version 字段决定自动更新）
- 模型目录：`models-catalog.json`

改完记得 `package.json` 的 `version` 加一，再走 `pack:meta:mac` / `pack:meta:win` 上传。
