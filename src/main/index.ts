import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, dialog, nativeImage, net, shell } from "electron";
import { Driver } from "./driver.js";
import { registerIpc } from "./ipc.js";
import { installProviderFetch } from "./provider-compat.js";

// Chromium uses the system proxy even when a Finder launch has no shell proxy variables.
installProviderFetch((input, init) => net.fetch(input instanceof URL ? input.href : input, {
	...init,
	bypassCustomProtocolHandlers: true,
}));

function iconPath(): string | undefined {
	for (const p of [join(__dirname, "../../build/icon.png"), join(process.resourcesPath, "icon.png")]) {
		if (existsSync(p)) return p;
	}
	return undefined;
}

let mainWindow: BrowserWindow | null = null;

// Only one HEIPANG at a time. A second launch hands off to the running one
// (focus it) and quits, so you never get two Dock icons / two GUIs.
if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on("second-instance", () => {
		if (mainWindow) {
			if (mainWindow.isMinimized()) mainWindow.restore();
			mainWindow.show();
			mainWindow.focus();
		}
	});
}

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
	let quitting = false;
	let canQuit = false;
	app.on("before-quit", (event) => {
		if (canQuit) return;
		event.preventDefault();
		if (quitting) return;
		quitting = true;
		const finish = () => { canQuit = true; app.quit(); };
		void driver.shutdown().then(finish, (error) => {
			console.error("Session cleanup failed during application shutdown", error);
			dialog.showErrorBox("Could not save all session state", error instanceof Error ? error.message : String(error));
			finish();
		});
	});

	createWindow();

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});
