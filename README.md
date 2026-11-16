# HEIPANG Meta

HEIPANG 的并行版本桌面客户端（Electron + React + TypeScript），跑在 pi 编码代理引擎（`@earendil-works/pi-*`）之上。和老版 `HEIPANG.app` 可以同时安装、互不影响。

## 环境要求

- macOS（arm64）本地构建；Windows 用 CI 打包
- Node.js 22.19.0 or newer, npm
- 一份 `~/.pi/agent/` 共享配置（见下）

## 首次拉取

```bash
git clone https://github.com/kid7st/heipang.git
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

The bundled source in `src/main/antigravity/` comes from pi-antigravity 0.11.0 (MIT; see its `LICENSE`), with application-specific configuration, provider availability, project-cache isolation and redirect protection. It includes upstream's system-prompt fix from `72e4786`: the exact phrase `codemode scripts and non-LLM models such as classifiers and image models` is shortened to `codemode scripts` in system instructions and injected skill instructions. Ordinary user messages are not rewritten. It also includes upstream's tool-result image fix from `a889327`: Gemini function responses remain in the model turn, while images follow in a user turn after all consecutive tool results. Claude and GPT-OSS tool-result formatting is unchanged.

## DeepSeek built-in models

DeepSeek V4.1 Flash (`deepseek-flash`) and DeepSeek V4 Pro (`deepseek-v4-pro`) are preconfigured and always appear in the conversation model selector. No model ID entry or manual model setup is required. Selecting one without credentials prompts for a DeepSeek API key; an account with access to Flash but not Pro can still connect.

Settings → Models lists these entries as **Built-in**. Their capabilities, limits and reasoning options come from the bundled Pi model catalog. Other model selections and the shared enabled-model configuration are unchanged. DeepSeek API usage requires a separate API balance.

## Session resources and updates

Each session loads project instructions, extensions and skills from its own working directory. Project settings, packages and extensions are disabled until trust is resolved through the SDK's shared `trust.json` and global `defaultProjectTrust` policy. With the default `ask` policy, unfamiliar projects with local resources require an explicit choice to trust the folder or open without those resources. Cancellation does not save a trust decision. User-installed global resources remain available.

Sessions own their SDK runtime, extension lifecycle and task extraction state; account credentials still use the shared `auth.json`. Switching away from a running session keeps it alive in the background. Release waits for accepted prompts, including asynchronous input and authentication preparation, and checks cancellation before building or sending model context. Stop cancels already-accepted prompts and queued follow-ups without closing the session or affecting other sessions; later prompts use a new cancellation scope. SDK input hooks without cancellation must return before cleanup can finish. Reopening a conversation waits for the previous file owner and superseded openings to finish cleanup before reading its JSONL, without blocking unrelated conversations. Late navigation results and messages from other sessions cannot replace the selected conversation. Navigation clears the old task list and disables task actions until loading finishes. Task updates, deletion and extraction carry the expected session ID through IPC; stale requests reject and late results cannot replace another session's tasks. The resource list uses already-loaded metadata without executing new project code; resource additions take effect in a new session, and deleted files disappear from the list without tearing down running extensions.

Deleting or archiving sessions blocks reopening the affected file or workspace until cleanup and file operations finish. Pending creation, accepted prompts, model changes and shutdown hooks must finish before the file is removed or moved. Shutdown-hook errors reported through SDK callbacks also block deletion or archiving; remaining cleanup still runs and its errors are combined. The selected conversation shows progress and cannot send or change models during the operation; messages carry the expected session ID so a stale request cannot create a replacement conversation in the default directory. Unrelated conversations and their pending navigation remain usable. Destructive session operations cannot overlap; failures are reported and release the operation guard. After success or failure, the interface restores the main process's actual session state without replacing a newer navigation.

Normal application exit, including update-triggered exit, cancels pending session creation and waits for active/background sessions and ongoing session file operations to finish. Extension shutdown hooks run before exit. Releasing sessions and exiting also wait for SDK credential writes, including OAuth refresh-token rotation, before forgetting their runtimes; catalog and unfinished session runtimes are covered too. Shutdown cancellation prevents new account authentication work while already-started credential transactions finish. Credential persistence failures are retained even when the authentication caller has already been cancelled; SDK settlement alone does not imply a successful save. A successful replacement or logout in any runtime for the shared credential store clears older failures for that provider across catalog and session runtimes. No-op modifications, failed writes and changes to other providers do not clear them. Shutdown rechecks captured persistence failures after all entered credential writes settle, so recovery during shutdown removes only obsolete credential failures while preserving unrelated cleanup errors. Cleanup failures are logged and displayed before the requested exit continues. Reloading the renderer or losing its process cancels pending input so sign-in can be retried.

SDK compatibility guards depend on the pinned 1.5.2 `_preparePrompt` and `_runInputHandlers` methods and the `core/auth-storage.js` module path. Revalidate these boundaries with the real-SDK regressions when upgrading.

History indexing reports damaged files with their paths while keeping healthy conversations available. Partial scans are not cached as complete results, so repairing the file and refreshing can recover the list. Root-directory failures still reject the scan. Indexing never repairs or rewrites conversation files.

The model catalog is resolved in the main process. Enabling an existing model does not copy unchanged SDK capabilities into `models.json`; known-model differences use `modelOverrides`, while new model definitions remain in provider `models`. A failed manual catalog refresh reports an error while cached models remain usable. Atomic `models.json` writes use a private temporary directory and owner-only file permissions, including when replacing an existing configuration that contains credentials.

Update channels come from packaged `updateChannel` metadata: `stable` for HEIPANG, `meta` for HEIPANG Meta. Installers start only after `Driver.shutdown()` succeeds; a cleanup failure is shown in the update area without launching the installer. If cleanup or installer launch fails after shutdown has started, restart the application before continuing to work. macOS updates stage the matching app bundle on the destination volume before quitting, retain the old bundle during replacement, and restore it if replacement fails. Installer output is kept in `install.log` beside the downloaded installer in the temporary update directory.

## 测试

```bash
npm run test:performance   # 流式解码、PDF 转换、会话索引、IPC 补丁等
npm run test:deepseek      # DeepSeek 接入
npm run test:antigravity   # Antigravity relay settings, credentials, models and routing
node scripts/session-regression.mjs # Session ownership, input cancellation, model catalog and update rollback
```

## 发版

源码、安装包和更新源都在公开仓库 `kid7st/heipang`，更新源就是 GitHub Release：

1. 把 `package.json` 的 `version` 加一，并新增 `release-notes/<version>.md`（面向用户的更新说明，应用内会显示），合入 `main`。
2. 打同版本的标签并推送：`git tag meta-v<version> && git push origin meta-v<version>`。
3. `.github/workflows/release-meta.yml` 构建 `HEIPANG-Meta-arm64.dmg` 和 `HEIPANG-Meta-Setup.exe`，并自动创建 Release（标签必须等于 `meta-v` + `package.json` 版本，且说明文件存在，否则在构建前就失败）。

应用内更新读取最新的已发布 Release（草稿和预发布不算）：版本号来自标签，更新说明来自 Release 正文（即 `release-notes/<version>.md`），安装包取 `.dmg` / `.exe` 资产。

`models-catalog.json` 位于仓库根目录，应用从 `main` 读取。
