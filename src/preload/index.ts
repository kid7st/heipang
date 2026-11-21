import { contextBridge, ipcRenderer } from "electron";
import type { InputRequest, PiApi, StreamEvent } from "../shared/types.js";

const api: PiApi = {
	listModels: () => ipcRenderer.invoke("pi:listModels"),
	addModels: (models) => ipcRenderer.invoke("pi:addModels", models),
	fetchRemoteModels: () => ipcRenderer.invoke("pi:fetchRemoteModels"),
	fetchRemoteOpenAIModels: () => ipcRenderer.invoke("pi:fetchRemoteOpenAIModels"),
	fetchRemoteAntigravityModels: () => ipcRenderer.invoke("pi:fetchRemoteAntigravityModels"),
	refreshModelCatalog: () => ipcRenderer.invoke("pi:refreshModelCatalog"),
	setEnabledModels: (enabled) => ipcRenderer.invoke("pi:setEnabledModels", enabled),
	setDefaultModel: (provider, id) => ipcRenderer.invoke("pi:setDefaultModel", provider, id),

	listSessions: () => ipcRenderer.invoke("pi:listSessions"),
	openSession: (path) => ipcRenderer.invoke("pi:openSession", path),
	newSession: (cwd) => ipcRenderer.invoke("pi:newSession", cwd),
	archiveSession: (path) => ipcRenderer.invoke("pi:archiveSession", path),
	deleteSession: (path) => ipcRenderer.invoke("pi:deleteSession", path),
	deleteFolder: (cwd) => ipcRenderer.invoke("pi:deleteFolder", cwd),
	renameSession: (path, name) => ipcRenderer.invoke("pi:renameSession", path, name),

	getTasks: () => ipcRenderer.invoke("pi:getTasks"),
	updateTask: (task, sessionId) => ipcRenderer.invoke("pi:updateTask", task, sessionId),
	deleteTask: (id, sessionId) => ipcRenderer.invoke("pi:deleteTask", id, sessionId),
	extractTasks: (sessionId) => ipcRenderer.invoke("pi:extractTasks", sessionId),

	getCommands: () => ipcRenderer.invoke("pi:getCommands"),
	getAccounts: () => ipcRenderer.invoke("pi:getAccounts"),
	getAntigravitySettings: () => ipcRenderer.invoke("pi:getAntigravitySettings"),
	saveAntigravitySettings: (input) => ipcRenderer.invoke("pi:saveAntigravitySettings", input),
	loginAccount: (id) => ipcRenderer.invoke("pi:loginAccount", id),
	logoutAccount: (id) => ipcRenderer.invoke("pi:logoutAccount", id),
	getUsage: (force) => ipcRenderer.invoke("pi:getUsage", force),
	readFile: (path) => ipcRenderer.invoke("pi:readFile", path),
	readMemory: (cwd) => ipcRenderer.invoke("pi:readMemory", cwd),
	writeMemory: (content, cwd) => ipcRenderer.invoke("pi:writeMemory", content, cwd),
	deleteExtension: (path) => ipcRenderer.invoke("pi:deleteExtension", path),
	setExtensionDisabled: (path, disabled) => ipcRenderer.invoke("pi:setExtensionDisabled", path, disabled),
	deleteSkill: (path) => ipcRenderer.invoke("pi:deleteSkill", path),
	respondRequest: (id, value) => ipcRenderer.send("pi:respond", id, value),
	onRequest: (cb) => {
		const listener = (_e: unknown, req: InputRequest) => cb(req);
		ipcRenderer.on("pi:request", listener);
		return () => ipcRenderer.removeListener("pi:request", listener);
	},
	onRequestDismiss: (cb) => {
		const listener = (_e: unknown, id: string) => cb(id);
		ipcRenderer.on("pi:request-dismiss", listener);
		return () => ipcRenderer.removeListener("pi:request-dismiss", listener);
	},

	getResources: () => ipcRenderer.invoke("pi:getResources"),
	getPiSettings: () => ipcRenderer.invoke("pi:getPiSettings"),
	setPiSettings: (p) => ipcRenderer.invoke("pi:setPiSettings", p),
	getGuiSettings: () => ipcRenderer.invoke("pi:getGuiSettings"),
	setGuiSettings: (p) => ipcRenderer.invoke("pi:setGuiSettings", p),
	openPath: (p) => ipcRenderer.invoke("pi:openPath", p),

	sendMessage: (text, images, sessionId) => ipcRenderer.invoke("pi:sendMessage", text, images, sessionId),
	abort: () => ipcRenderer.invoke("pi:abort"),
	setModel: (provider, id) => ipcRenderer.invoke("pi:setModel", provider, id),
	setThinkingLevel: (level) => ipcRenderer.invoke("pi:setThinkingLevel", level),
	getActiveState: () => ipcRenderer.invoke("pi:getActiveState"),
	getMessages: () => ipcRenderer.invoke("pi:getMessages"),

	getVersion: () => ipcRenderer.invoke("pi:getVersion"),
	getUpdateState: () => ipcRenderer.invoke("pi:getUpdateState"),
	checkForUpdate: (options) => ipcRenderer.invoke("pi:checkForUpdate", options),
	downloadUpdate: (url) => ipcRenderer.invoke("pi:downloadUpdate", url),
	installUpdate: (url) => ipcRenderer.invoke("pi:installUpdate", url),

	pickDirectory: () => ipcRenderer.invoke("pi:pickDirectory"),
	getHome: () => ipcRenderer.invoke("pi:getHome"),

	onEvent: (cb: (e: StreamEvent) => void) => {
		const listener = (_e: unknown, payload: StreamEvent) => cb(payload);
		ipcRenderer.on("pi:event", listener);
		return () => ipcRenderer.removeListener("pi:event", listener);
	},
};

contextBridge.exposeInMainWorld("pi", api);
