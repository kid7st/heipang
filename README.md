# HEIPANG Meta

HEIPANG 的并行版本桌面客户端（Electron + React + TypeScript），跑在 pi 编码代理引擎（`@earendil-works/pi-*`）之上。和老版 `HEIPANG.app` 可以同时安装、互不影响。

## 环境要求

- macOS（arm64）本地构建；Windows 用 CI 打包
- Node.js 22.19.0 or newer, npm
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
- npm 包目录 `~/.pi/agent/npm/`（第三方扩展与技能通过 `pi install npm:...` 装在这里）

## Antigravity relay connection

Antigravity is bundled in the application. No separate `pi install` or local plugin checkout is required.

1. Deploy and sign in to a pi-antigravity relay. Google authentication and token renewal happen on the relay, not in HEIPANG.
2. Open **Settings → Accounts → Antigravity**.
3. Enter **Relay URL** (`ANTIGRAVITY_RELAY_URL`) and **Relay key** (`ANTIGRAVITY_RELAY_KEY`), then click **Save and connect**.
4. After verification, choose an Antigravity model in the conversation's model selector. The app loads the account's advertised catalog and adds its models to an existing enabled-model list. If catalog discovery fails, the last-known catalog remains available and the account card shows a warning.

The URL must be an HTTPS origin without credentials, paths, query parameters or fragments. HTTP is accepted only for localhost testing. The key is encrypted using Electron's OS-backed `safeStorage` and stored in `~/.pi/agent/heipang-antigravity.json` with owner-only permissions. Saving is rejected when secure storage is unavailable. Leave the key field blank to retain a saved key; **Disconnect** removes the saved connection. HEIPANG uses these application settings rather than shell relay environment variables.

External copies of the `pi-antigravity` package are excluded from HEIPANG's active extensions to avoid duplicate providers, commands and tools. They remain installed for CLI use. Existing `auth.json` OAuth credentials are left untouched; HEIPANG overrides them only in memory while its relay connection is configured.

The bundled source in `src/main/antigravity/` comes from pi-antigravity 0.11.0 (MIT; see its `LICENSE`), with application-specific configuration, provider availability, project-cache isolation and redirect protection. It includes upstream's system-prompt fix from `72e4786`: the exact phrase `codemode scripts and non-LLM models such as classifiers and image models` is shortened to `codemode scripts` in system instructions and injected skill instructions. Ordinary user messages are not rewritten.

## DeepSeek built-in models

DeepSeek V4.1 Flash (`deepseek-flash`) and DeepSeek V4 Pro (`deepseek-v4-pro`) are preconfigured and always appear in the conversation model selector. No model ID entry or manual model setup is required. Selecting one without credentials prompts for a DeepSeek API key; an account with access to Flash but not Pro can still connect.

Settings → Models lists these entries as **Built-in**. Their capabilities, limits and reasoning options come from the bundled Pi model catalog. Other model selections and the shared enabled-model configuration are unchanged. DeepSeek API usage requires a separate API balance.

## 测试

```bash
npm run test:performance   # 流式解码、PDF 转换、会话索引、IPC 补丁等
npm run test:deepseek      # DeepSeek 接入
npm run test:antigravity   # Antigravity relay settings, credentials, models and routing
```

## 发版

源码在私有仓库 `kuaai/heipang`；安装包和更新源在公开仓库 `kuaai/heipang-releases`：

- 资产：`HEIPANG-Meta-arm64.dmg` / `HEIPANG-Meta-Setup.exe`（`meta-latest` tag）
- 更新源：`meta-latest.json`（version 字段决定自动更新）
- 模型目录：`models-catalog.json`

改完记得 `package.json` 的 `version` 加一，再走 `pack:meta:mac` / `pack:meta:win` 上传。
