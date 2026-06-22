import { dialog, ipcMain, Notification, shell, type BrowserWindow } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Driver } from "./driver.js";
import type { StreamEvent, Task } from "../shared/types.js";

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

	// request/response round-trip (main asks renderer, e.g. OAuth code input)
	const pendingRequests = new Map<string, (v: string | undefined) => void>();
	let reqSeq = 0;
	const requestInput = (kind: string, payload: unknown): Promise<string | undefined> => {
		const win = getWindow();
		if (!win || win.isDestroyed()) return Promise.resolve(undefined);
		const id = `req${++reqSeq}`;
		return new Promise((resolve) => {
			pendingRequests.set(id, resolve);
			win.webContents.send("pi:request", { id, kind, payload });
		});
	};
	ipcMain.on("pi:respond", (_e, id: string, value: string | undefined) => {
		const r = pendingRequests.get(id);
		if (r) {
			pendingRequests.delete(id);
			r(value);
		}
	});

	driver.oauthBridge = {
		openExternal: (url) => shell.openExternal(url),
		requestInput,
	};

	driver.setHandlers({
		onMessages: (messages) => send({ type: "messages", messages }),
		onMessagesPatch: (from, messages) => send({ type: "patch", from, messages }),
		onState: (state) => send({ type: "state", state }),
		onTasks: (tasks) => send({ type: "tasks", tasks }),
		onRunComplete: (path) => {
			send({ type: "sessionDone", path });
			// Desktop ping ONLY when you've switched away (never nags while you watch).
			const win = getWindow();
			if ((!win || !win.isFocused()) && Notification.isSupported()) {
				new Notification({ title: "Pi — response finished", body: "The agent finished while you were away.", silent: false }).show();
			}
		},
		onError: (message) => send({ type: "error", message }),
	});

	const h = <T extends unknown[], R>(channel: string, fn: (...args: T) => Promise<R> | R) => {
		ipcMain.handle(channel, (_e, ...args) => fn(...(args as T)));
	};

	// models
	h("pi:listModels", () => driver.listModels());
	h("pi:addModels", (models: any) => driver.addModels(models));
	h("pi:removeModel", (provider: string, id: string) => driver.removeModel(provider, id));
	h("pi:fetchRemoteModels", () => driver.fetchRemoteModels());
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
	h("pi:updateTask", (task: Task) => driver.updateTask(task));
	h("pi:deleteTask", (id: string) => driver.deleteTask(id));
	h("pi:extractTasks", () => driver.extractTasks());

	// commands / workspaces / accounts
	h("pi:getCommands", () => driver.getCommands());
	h("pi:listWorkspaces", () => driver.listWorkspaces());
	h("pi:getAccounts", () => driver.getAccounts());
	h("pi:loginAccount", (id: string) => driver.loginAccount(id));
	h("pi:logoutAccount", (id: string) => driver.logoutAccount(id));
	h("pi:getUsage", () => driver.getUsage());
	h("pi:readFile", (path: string) => driver.readFile(path));
	h("pi:readMemory", (cwd?: string) => driver.readMemory(cwd));
	h("pi:writeMemory", (content: string, cwd?: string) => driver.writeMemory(content, cwd));
	h("pi:deleteExtension", (path: string) => driver.deleteExtension(path));
	h("pi:deleteSkill", (path: string) => driver.deleteSkill(path));

	// resources & settings
	h("pi:getResources", () => driver.getResources());
	h("pi:getPiSettings", () => driver.getPiSettings());
	h("pi:setPiSettings", (p: any) => driver.setPiSettings(p));
	h("pi:getGuiSettings", () => driver.getGuiSettings());
	h("pi:setGuiSettings", (p: any) => driver.setGuiSettings(p));
	h("pi:openPath", async (p: string) => {
		await shell.openPath(p);
	});

	// conversation
	h("pi:sendMessage", (text: string, images?: any) => driver.sendMessage(text, images));
	h("pi:abort", () => driver.abort());
	h("pi:setModel", (provider: string, id: string) => driver.setModel(provider, id));
	h("pi:setThinkingLevel", (level: any) => driver.setThinkingLevel(level));
	h("pi:getActiveState", () => driver.getActiveState());
	h("pi:getMessages", () => driver.getMessages());

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
