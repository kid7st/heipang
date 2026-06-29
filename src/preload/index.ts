import { contextBridge, ipcRenderer } from "electron";
import type { PiApi, StreamEvent } from "../shared/types.js";

const api: PiApi = {
	listModels: () => ipcRenderer.invoke("pi:listModels"),
	addModels: (models) => ipcRenderer.invoke("pi:addModels", models),
	removeModel: (provider, id) => ipcRenderer.invoke("pi:removeModel", provider, id),
	fetchRemoteModels: () => ipcRenderer.invoke("pi:fetchRemoteModels"),
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
	updateTask: (task) => ipcRenderer.invoke("pi:updateTask", task),
	deleteTask: (id) => ipcRenderer.invoke("pi:deleteTask", id),
	extractTasks: () => ipcRenderer.invoke("pi:extractTasks"),

	getCommands: () => ipcRenderer.invoke("pi:getCommands"),
	listWorkspaces: () => ipcRenderer.invoke("pi:listWorkspaces"),
	getAccounts: () => ipcRenderer.invoke("pi:getAccounts"),
	loginAccount: (id) => ipcRenderer.invoke("pi:loginAccount", id),
	logoutAccount: (id) => ipcRenderer.invoke("pi:logoutAccount", id),
	getUsage: () => ipcRenderer.invoke("pi:getUsage"),
	readFile: (path) => ipcRenderer.invoke("pi:readFile", path),
	readMemory: (cwd) => ipcRenderer.invoke("pi:readMemory", cwd),
	writeMemory: (content, cwd) => ipcRenderer.invoke("pi:writeMemory", content, cwd),
	deleteExtension: (path) => ipcRenderer.invoke("pi:deleteExtension", path),
	deleteSkill: (path) => ipcRenderer.invoke("pi:deleteSkill", path),
	respondRequest: (id, value) => ipcRenderer.send("pi:respond", id, value),
	onRequest: (cb: (req: { id: string; kind: string; payload: any }) => void) => {
		const listener = (_e: unknown, req: { id: string; kind: string; payload: any }) => cb(req);
		ipcRenderer.on("pi:request", listener);
		return () => ipcRenderer.removeListener("pi:request", listener);
	},

	getResources: () => ipcRenderer.invoke("pi:getResources"),
	getPiSettings: () => ipcRenderer.invoke("pi:getPiSettings"),
	setPiSettings: (p) => ipcRenderer.invoke("pi:setPiSettings", p),
	getGuiSettings: () => ipcRenderer.invoke("pi:getGuiSettings"),
	setGuiSettings: (p) => ipcRenderer.invoke("pi:setGuiSettings", p),
	openPath: (p) => ipcRenderer.invoke("pi:openPath", p),

	sendMessage: (text, images) => ipcRenderer.invoke("pi:sendMessage", text, images),
	abort: () => ipcRenderer.invoke("pi:abort"),
	setModel: (provider, id) => ipcRenderer.invoke("pi:setModel", provider, id),
	setThinkingLevel: (level) => ipcRenderer.invoke("pi:setThinkingLevel", level),
	getActiveState: () => ipcRenderer.invoke("pi:getActiveState"),
	getMessages: () => ipcRenderer.invoke("pi:getMessages"),

	getVersion: () => ipcRenderer.invoke("pi:getVersion"),
	checkForUpdate: () => ipcRenderer.invoke("pi:checkForUpdate"),
	installUpdate: (url) => ipcRenderer.invoke("pi:installUpdate", url),

	metaListRecordings: () => ipcRenderer.invoke("pi:metaListRecordings"),
	metaGetSummary: () => ipcRenderer.invoke("pi:metaGetSummary"),
	metaSetStatus: (recId, status) => ipcRenderer.invoke("pi:metaSetStatus", recId, status),
	metaUndo: (recId) => ipcRenderer.invoke("pi:metaUndo", recId),
	metaClassify: (recId) => ipcRenderer.invoke("pi:metaClassify", recId),
	metaConfirmSort: (recId, payload) => ipcRenderer.invoke("pi:metaConfirmSort", recId, payload),
	metaListProjects: () => ipcRenderer.invoke("pi:metaListProjects"),
	metaGetInbox: (cwd) => ipcRenderer.invoke("pi:metaGetInbox", cwd),
	metaInboxAction: (cwd, action, index) => ipcRenderer.invoke("pi:metaInboxAction", cwd, action, index),
	metaListIdeas: () => ipcRenderer.invoke("pi:metaListIdeas"),
	metaIdeaAction: (action, index, cwd) => ipcRenderer.invoke("pi:metaIdeaAction", action, index, cwd),
	metaGetConfig: () => ipcRenderer.invoke("pi:metaGetConfig"),
	metaSetWorkspace: (path) => ipcRenderer.invoke("pi:metaSetWorkspace", path),
	metaExportHtml: (html, name) => ipcRenderer.invoke("pi:metaExportHtml", html, name),
	metaExportPng: (html, name) => ipcRenderer.invoke("pi:metaExportPng", html, name),
	metaShareLink: (html) => ipcRenderer.invoke("pi:metaShareLink", html),

	pickDirectory: () => ipcRenderer.invoke("pi:pickDirectory"),
	getHome: () => ipcRenderer.invoke("pi:getHome"),

	onEvent: (cb: (e: StreamEvent) => void) => {
		const listener = (_e: unknown, payload: StreamEvent) => cb(payload);
		ipcRenderer.on("pi:event", listener);
		return () => ipcRenderer.removeListener("pi:event", listener);
	},
};

contextBridge.exposeInMainWorld("pi", api);
