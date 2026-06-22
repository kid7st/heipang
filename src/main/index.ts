import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, nativeImage, shell } from "electron";
import { Driver } from "./driver.js";
import { registerIpc } from "./ipc.js";

function iconPath(): string | undefined {
	for (const p of [join(__dirname, "../../build/icon.png"), join(process.resourcesPath, "icon.png")]) {
		if (existsSync(p)) return p;
	}
	return undefined;
}

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
	mainWindow = new BrowserWindow({
		width: 1280,
		height: 860,
		minWidth: 720,
		minHeight: 480,
		show: false,
		titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
		backgroundColor: "#ffffff",
		icon: iconPath(),
		webPreferences: {
			preload: join(__dirname, "../preload/index.mjs"),
			sandbox: false,
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	mainWindow.on("ready-to-show", () => mainWindow?.show());

	mainWindow.webContents.setWindowOpenHandler((details) => {
		shell.openExternal(details.url);
		return { action: "deny" };
	});

	if (process.env.ELECTRON_RENDERER_URL) {
		mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
	} else {
		mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
	}
}

app.whenReady().then(() => {
	if (process.platform === "darwin" && app.dock) {
		const p = iconPath();
		if (p) app.dock.setIcon(nativeImage.createFromPath(p));
	}
	const driver = new Driver();
	registerIpc(driver, () => mainWindow);

	createWindow();

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});
