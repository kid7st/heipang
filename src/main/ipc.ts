import { app, dialog, ipcMain, Notification, shell, type BrowserWindow } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Driver } from "./driver.js";
import type { AntigravitySettingsInput, StreamEvent, Task } from "../shared/types.js";
import {
	checkForUpdate,
	downloadAndInstall,
	downloadUpdate,
	getUpdateState,
	startAutoUpdateScheduler,
	syncAutoUpdateSettings,
} from "./updater.js";
import { InputRequests, type InputBridge } from "./input-requests.js";

/**
 * Registers IPC handlers and forwards driver events to the renderer.
 * Streaming is throttled inside the Driver (~16ms) and sent as incremental
 * tail patches, so long sessions never re-serialize the whole transcript.
 */
export function registerIpc(driver: Driver, getWindow: () => BrowserWindow | null): void {
	const send = (e: StreamEvent) => {
		const win = getWindow();
		if (win && !win.isDestroyed()) win.webContents.send("pi:event", e);
	};

	const requests = new InputRequests(
		(request) => {
			const win = getWindow();
			if (!win || win.isDestroyed()) throw new Error("The application window is closed");
			win.webContents.send("pi:request", request);
		},
		(id) => {
			const win = getWindow();
			if (win && !win.isDestroyed()) win.webContents.send("pi:request-dismiss", id);
		},
	);
	const requestInput: InputBridge["requestInput"] = (kind, payload, options) => {
		const win = getWindow();
		if (!win || win.isDestroyed()) return Promise.resolve(undefined);
		const cancel = () => requests.dismissAll();
		const onNavigation = (_event: Electron.Event, _url: string, isInPlace: boolean, isMainFrame: boolean) => {
			if (isMainFrame && !isInPlace) cancel();
		};
		win.webContents.once("destroyed", cancel);
		win.webContents.once("render-process-gone", cancel);
		win.webContents.on("did-start-navigation", onNavigation);
		return requests.ask(kind, payload, options).finally(() => {
			win.webContents.off("destroyed", cancel);
			win.webContents.off("render-process-gone", cancel);
			win.webContents.off("did-start-navigation", onNavigation);
		});
	};
	ipcMain.on("pi:respond", (_e, id: string, value: string | undefined) => requests.respond(id, value));
	driver.oauthBridge = {
		openExternal: (url) => { void shell.openExternal(url).catch((error) => send({ type: "error", message: error.message })); },
		requestInput,
	};

	driver.setHandlers({
		onMessages: (messages, sessionId) => send({ type: "messages", messages, sessionId }),
		onMessagesPatch: (from, messages, sessionId) => send({ type: "patch", from, messages, sessionId }),
		onState: (state) => send({ type: "state", state }),
		onTasks: (tasks, sessionId) => send({ type: "tasks", tasks, sessionId }),
		onSessionUpdated: (path) => send({ type: "sessionUpdated", path }),
		onRunComplete: (path) => {
			send({ type: "sessionDone", path });
			// Desktop ping ONLY when you've switched away (never nags while you watch).
			const win = getWindow();
			if ((!win || !win.isFocused()) && Notification.isSupported()) {
				new Notification({ title: "Pi — response finished", body: "The agent finished while you were away.", silent: false }).show();
			}
		},
		onError: (message) => send({ type: "error", message }),
		onBackground: (sessions) => send({ type: "background", sessions }),
	});

	const h = <T extends unknown[], R>(channel: string, fn: (...args: T) => Promise<R> | R) => {
		ipcMain.handle(channel, (_e, ...args) => fn(...(args as T)));
	};

	// models
	h("pi:listModels", () => driver.listModels());
	h("pi:addModels", (models: any) => driver.addModels(models));
	h("pi:fetchRemoteModels", () => driver.fetchRemoteModels());
	h("pi:fetchRemoteOpenAIModels", () => driver.fetchRemoteOpenAIModels());
	h("pi:fetchRemoteAntigravityModels", () => driver.fetchRemoteAntigravityModels());
	h("pi:refreshModelCatalog", () => driver.refreshModelCatalog());
	h("pi:setEnabledModels", (enabled: string[]) => driver.setEnabledModels(enabled));
	h("pi:setDefaultModel", (provider: string, id: string) => driver.setDefaultModel(provider, id));

	// sessions
	h("pi:listSessions", () => driver.listSessions());
	h("pi:openSession", (path: string) => driver.openSession(path));
	h("pi:newSession", (cwd?: string) => driver.newSession(cwd));
	h("pi:archiveSession", (path: string) => driver.archiveSession(path));
	h("pi:deleteSession", (path: string) => driver.deleteSession(path));
	h("pi:deleteFolder", (cwd: string) => driver.deleteFolder(cwd));
	h("pi:renameSession", (path: string, name: string) => driver.renameSession(path, name));

	// tasks
	h("pi:getTasks", () => driver.getTasks());
	h("pi:updateTask", (task: Task, sessionId: string) => driver.updateTask(task, sessionId));
	h("pi:deleteTask", (id: string, sessionId: string) => driver.deleteTask(id, sessionId));
	h("pi:extractTasks", (sessionId: string) => driver.extractTasks(sessionId));

	// commands / workspaces / accounts
	h("pi:getCommands", () => driver.getCommands());
	h("pi:getAccounts", () => driver.getAccounts());
	h("pi:getAntigravitySettings", () => driver.getAntigravitySettings());
	h("pi:saveAntigravitySettings", (input: AntigravitySettingsInput) => driver.saveAntigravitySettings(input));
	h("pi:loginAccount", (id: string) => driver.loginAccount(id));
	h("pi:logoutAccount", (id: string) => driver.logoutAccount(id));
	h("pi:getUsage", (force?: boolean) => driver.getUsage(force));
	h("pi:readFile", (path: string) => driver.readFile(path));
	h("pi:readMemory", (cwd?: string) => driver.readMemory(cwd));
	h("pi:writeMemory", (content: string, cwd?: string) => driver.writeMemory(content, cwd));
	h("pi:deleteExtension", (path: string) => driver.deleteExtension(path));
	h("pi:setExtensionDisabled", (path: string, disabled: boolean) => driver.setExtensionDisabled(path, disabled));
	h("pi:deleteSkill", (path: string) => driver.deleteSkill(path));

	// resources & settings
	h("pi:getResources", () => driver.getResources());
	h("pi:getPiSettings", () => driver.getPiSettings());
	h("pi:setPiSettings", (p: any) => driver.setPiSettings(p));
	h("pi:getGuiSettings", () => driver.getGuiSettings());
	h("pi:setGuiSettings", (p: any) => {
		const next = driver.setGuiSettings(p);
		syncAutoUpdateSettings(next);
		return next;
	});
	h("pi:openPath", async (p: string) => {
		await shell.openPath(p);
	});

	// conversation
	h("pi:sendMessage", (text: string, images: any, sessionId: string | null) => driver.sendMessage(text, images, sessionId));
	h("pi:abort", () => driver.abort());
	h("pi:setModel", (provider: string, id: string) => driver.setModel(provider, id));
	h("pi:setThinkingLevel", (level: any) => driver.setThinkingLevel(level));
	h("pi:getActiveState", () => driver.getActiveState());
	h("pi:getMessages", () => driver.getMessages());

	// updates
	h("pi:getVersion", () => app.getVersion());
	h("pi:getUpdateState", () => getUpdateState());
	h("pi:checkForUpdate", (options?: { background?: boolean }) => checkForUpdate(options));
	h("pi:downloadUpdate", (url: string) => downloadUpdate(url));
	h("pi:installUpdate", (url: string) =>
		downloadAndInstall(url, (phase, pct, message) => send({ type: "updateProgress", phase, pct, message }), () => driver.shutdown()),
	);
	if (typeof driver.getGuiSettings === "function") {
		startAutoUpdateScheduler({
			getSettings: () => driver.getGuiSettings(),
			onStateChange: (state) => send({ type: "updateState", state }),
		});
	}

	// misc
	h("pi:getHome", () => homedir());
	h("pi:pickDirectory", async () => {
		const win = getWindow();
		const res = await dialog.showOpenDialog(win!, {
			properties: ["openDirectory", "createDirectory"],
			defaultPath: join(homedir(), "Desktop"),
			buttonLabel: "Start here",
		});
		if (res.canceled || res.filePaths.length === 0) return undefined;
		return res.filePaths[0];
	});
}
