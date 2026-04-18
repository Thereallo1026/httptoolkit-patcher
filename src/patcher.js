import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import * as asar from "@electron/asar";
import chalk from "chalk";

import * as mac from "./patches/mac.js";
import * as winLinux from "./patches/win-linux.js";

const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";

export function rm(dirPath) {
	if (!fs.existsSync(dirPath)) return;
	if (!fs.lstatSync(dirPath).isDirectory()) {
		fs.rmSync(dirPath, { force: true });
		return;
	}
	for (const entry of fs.readdirSync(dirPath)) {
		const p = path.join(dirPath, entry);
		fs.lstatSync(p).isDirectory() ? rm(p) : fs.rmSync(p, { force: true });
	}
	fs.rmdirSync(dirPath);
}

export function isElevated() {
	if (isWin) {
		try {
			execSync("net session", { stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	}
	return !!(process.getuid && process.getuid() === 0);
}

export async function requestElevation(scriptPath) {
	const isBundled = process.pkg;
	if (isWin) {
		const script = isBundled
			? `Start-Process -FilePath "${scriptPath}" -Verb RunAs`
			: `Start-Process -FilePath "node" -ArgumentList "${scriptPath}" -Verb RunAs`;
		try {
			execSync(`powershell -Command "${script}"`, { stdio: "inherit" });
			process.exit(0);
		} catch (e) {
			console.error(chalk.redBright(`[-] Failed to elevate: ${e.message}`));
			process.exit(1);
		}
	} else if (process.platform === "linux") {
		console.log(
			chalk.yellowBright(
				`[!] Please re-run with sudo: sudo ${isBundled ? scriptPath : `node ${scriptPath}`}`,
			),
		);
		process.exit(1);
	} else {
		const child = spawn(
			"sudo",
			isBundled ? [scriptPath] : ["node", scriptPath],
			{ stdio: "inherit" },
		);
		child.on("exit", (code) => process.exit(code || 0));
	}
}

export function checkPermissions(filePath) {
	try {
		fs.accessSync(filePath, fs.constants.W_OK);
		const testDir = path.join(path.dirname(filePath), `.test_${Date.now()}`);
		fs.mkdirSync(testDir, { recursive: true });
		fs.rmdirSync(testDir);
		console.log(
			chalk.greenBright(`[+] Permissions check passed for ${filePath}`),
		);
		return true;
	} catch (e) {
		console.error(
			chalk.redBright(
				`[-] Permissions check failed for ${filePath}: ${e.message}`,
			),
		);
		return false;
	}
}

export async function killHttpToolkit() {
	console.log(
		chalk.yellowBright("[+] Checking for running HTTP Toolkit processes..."),
	);
	try {
		if (isWin) {
			const out = execSync(
				'tasklist /FI "IMAGENAME eq HTTP Toolkit.exe" /FO CSV /NH',
				{ encoding: "utf-8" },
			);
			if (out.includes("HTTP Toolkit.exe")) {
				console.log(
					chalk.yellowBright(
						"[!] HTTP Toolkit is running, attempting to close it...",
					),
				);
				execSync('taskkill /F /IM "HTTP Toolkit.exe" /T', { stdio: "ignore" });
				console.log(chalk.greenBright("[+] HTTP Toolkit processes terminated"));
				await new Promise((r) => setTimeout(r, 2000));
			} else {
				console.log(chalk.greenBright("[+] HTTP Toolkit is not running"));
			}
		} else {
			try {
				execSync('pgrep -f "HTTP Toolkit"', { stdio: "ignore" });
				console.log(
					chalk.yellowBright(
						"[!] HTTP Toolkit is running, attempting to close it...",
					),
				);
				execSync('pkill -f "HTTP Toolkit"', { stdio: "ignore" });
				console.log(chalk.greenBright("[+] HTTP Toolkit processes terminated"));
				await new Promise((r) => setTimeout(r, 2000));
			} catch {
				console.log(chalk.greenBright("[+] HTTP Toolkit is not running"));
			}
		}
	} catch (e) {
		console.log(
			chalk.yellowBright(`[!] Could not check/kill processes: ${e.message}`),
		);
	}
}

export async function findAppPath(prompt) {
	const candidates = isWin
		? [
				path.join("C:", "Program Files", "HTTP Toolkit", "resources"),
				path.join("C:", "Program Files (x86)", "HTTP Toolkit", "resources"),
				path.join(
					process.env.LOCALAPPDATA ||
						path.join(process.env.USERPROFILE || "", "AppData", "Local"),
					"Programs",
					"HTTP Toolkit",
					"resources",
				),
			]
		: isMac
			? ["/Applications/HTTP Toolkit.app/Contents/Resources"]
			: ["/opt/HTTP Toolkit/resources", "/opt/httptoolkit/resources"];

	for (const p of candidates) {
		if (fs.existsSync(path.join(p, "app.asar"))) return p;
	}

	console.log(
		chalk.yellowBright("[!] HTTP Toolkit not found in default locations"),
	);
	const userPath = await prompt(
		"Please enter the path to HTTP Toolkit executable/app: ",
	);
	if (!userPath) {
		console.error(chalk.redBright("[-] No path provided"));
		process.exit(1);
	}

	let resourcesPath = userPath.trim().replace(/['"]/g, "");
	if (resourcesPath.endsWith(".exe") || resourcesPath.endsWith(".app"))
		resourcesPath = path.dirname(resourcesPath);
	if (!resourcesPath.endsWith("resources"))
		resourcesPath = path.join(resourcesPath, "resources");

	if (!fs.existsSync(path.join(resourcesPath, "app.asar"))) {
		console.error(
			chalk.redBright(`[-] app.asar not found at ${resourcesPath}`),
		);
		process.exit(1);
	}
	return resourcesPath;
}

export function getExecutablePath(resourcesPath) {
	const base = resourcesPath.replace(/[\\/]+$/, "");
	const dir = base.toLowerCase().endsWith("resources")
		? path.dirname(base)
		: base;
	const candidates = isWin
		? [path.join(dir, "HTTP Toolkit.exe"), path.join(dir, "httptoolkit.exe")]
		: isMac
			? [
					path.join(dir, "MacOS", "HTTP Toolkit"),
					path.join(dir, "MacOS", "HTTP Toolkit Preview"),
				]
			: [path.join(dir, "httptoolkit"), path.join(dir, "HTTP Toolkit")];
	const found = candidates.find((c) => fs.existsSync(c));
	if (!found)
		throw new Error(
			`Could not locate HTTP Toolkit executable near ${resourcesPath}`,
		);
	return found;
}

export async function patchApp({ prompt, scriptPath, injectJsPath }) {
	console.log(chalk.blueBright("[+] HTTP Toolkit Patcher Started"));

	const appPath = await findAppPath(prompt);
	console.log(chalk.greenBright(`[+] HTTP Toolkit found at ${appPath}`));

	await killHttpToolkit();

	const asarPath = path.join(appPath, "app.asar");

	if (!checkPermissions(appPath) || !checkPermissions(asarPath)) {
		if (isElevated()) {
			console.error(
				chalk.redBright(
					"[-] Still no permissions even with elevated privileges",
				),
			);
			process.exit(1);
		}
		console.log(
			chalk.yellowBright(
				"[!] Administrator/sudo privileges required for patching",
			),
		);
		await requestElevation(scriptPath);
	}

	const backupPath = path.join(appPath, "app.asar.bak");
	if (!fs.existsSync(backupPath)) {
		fs.copyFileSync(asarPath, backupPath);
		console.log(chalk.greenBright(`[+] Backup created at ${backupPath}`));
	}

	const extractPath = path.join(appPath, "app.asar_extracted");
	console.log(chalk.yellowBright("[+] Extracting app.asar..."));
	rm(extractPath);
	asar.extractAll(asarPath, extractPath);
	console.log(chalk.greenBright(`[+] Extracted to ${extractPath}`));

	const preloadPath = path.join(extractPath, "build", "preload.cjs");
	if (!fs.existsSync(preloadPath)) {
		rm(extractPath);
		console.error(
			chalk.redBright(
				"[-] preload.cjs not found. Is this the right HTTP Toolkit version?",
			),
		);
		process.exit(1);
	}

	if (!fs.existsSync(injectJsPath)) {
		rm(extractPath);
		console.error(
			chalk.redBright(`[-] inject.js not found at ${injectJsPath}`),
		);
		process.exit(1);
	}
	const injectCode = fs.readFileSync(injectJsPath, "utf-8");
	if (!injectCode.includes("PAGE-INJECT")) {
		rm(extractPath);
		console.error(chalk.redBright("[-] Invalid inject.js"));
		process.exit(1);
	}

	let preloadContent = fs.readFileSync(preloadPath, "utf-8");
	const electronVar = preloadContent.includes("electron_1")
		? "electron_1"
		: "electron";

	const patchCode = `
(function loadInjectScript() {
	const injectCode = ${JSON.stringify(injectCode)};
	function injectViaWebFrame() {
		try {
			const { webFrame } = ${electronVar};
			if (webFrame && webFrame.executeJavaScript) {
				webFrame.executeJavaScript(injectCode)
					.then(() => console.log("[PRELOAD] Injected via webFrame.executeJavaScript"))
					.catch(err => console.error("[PRELOAD] webFrame injection failed:", err));
				return true;
			}
		} catch (e) { console.error("[PRELOAD] webFrame not available:", e); }
		return false;
	}
	if (!injectViaWebFrame()) {
		const tryInject = () => { if (!injectViaWebFrame()) console.error("[PRELOAD] All injection methods failed"); };
		if (document.readyState === "complete" || document.readyState === "interactive") tryInject();
		else document.addEventListener("DOMContentLoaded", tryInject, { once: true });
	}
})();
`;

	if (preloadContent.includes("loadInjectScript")) {
		console.log(chalk.yellowBright("[!] Files already patched"));
		const answer = await prompt("Do you want to repatch? (y/n): ");
		if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
			console.log(chalk.blueBright("[+] Patching cancelled"));
			rm(extractPath);
			process.exit(0);
		}
		preloadContent = preloadContent.replace(
			/\n?\(function loadInjectScript\(\) \{[\s\S]*?\}\)\(\);/,
			"",
		);
		console.log(chalk.yellowBright("[+] Replacing existing patch..."));
	}

	const lines = preloadContent.split("\n");
	const insertAt = lines.findIndex(
		(l) =>
			l.includes('require("electron")') ||
			l.includes("require('electron')") ||
			l.includes("electron_1"),
	);
	if (insertAt === -1) {
		rm(extractPath);
		console.error(
			chalk.redBright("[-] Could not find electron import in preload.cjs"),
		);
		process.exit(1);
	}
	lines.splice(insertAt + 1, 0, patchCode);
	fs.writeFileSync(preloadPath, lines.join("\n"), "utf-8");
	console.log(chalk.greenBright("[+] preload.cjs patched"));

	console.log(chalk.yellowBright("[+] Repackaging app.asar..."));
	await asar.createPackage(extractPath, asarPath);
	console.log(chalk.greenBright("[+] app.asar repackaged"));
	rm(extractPath);

	const executablePath = getExecutablePath(appPath);
	console.log(
		chalk.yellowBright(
			"[+] Launching HTTP Toolkit to capture integrity hashes...",
		),
	);
	let hashes;
	try {
		hashes = isMac
			? await mac.captureIntegrityHashes(executablePath, appPath)
			: await winLinux.captureIntegrityHashes(executablePath);
	} catch (e) {
		console.error(
			chalk.redBright(`[-] Failed to capture integrity hashes: ${e.message}`),
		);
		process.exit(1);
	}
	console.log(chalk.greenBright("[+] Integrity hashes captured"));
	console.log(chalk.white(`    original: ${hashes.originalHash}`));
	console.log(chalk.white(`    new:      ${hashes.newHash}`));

	if (isMac) {
		mac.patchInfoPlist(appPath, hashes);
	} else {
		winLinux.patchBinary(executablePath, appPath, hashes);
	}

	console.log(chalk.greenBright("[+] Successfully patched!"));

	try {
		const child = spawn(executablePath, {
			stdio: "ignore",
			shell: false,
			detached: true,
		});
		child.unref();
		console.log(chalk.greenBright("[+] HTTP Toolkit launched"));
	} catch (e) {
		console.log(chalk.yellowBright(`[!] Could not auto-launch: ${e.message}`));
	}
}

export async function unpatchApp({ prompt, scriptPath }) {
	console.log(chalk.blueBright("[+] HTTP Toolkit Unpatcher Started"));

	await killHttpToolkit();

	const appPath = await findAppPath(prompt);
	console.log(chalk.greenBright(`[+] HTTP Toolkit found at ${appPath}`));

	const asarPath = path.join(appPath, "app.asar");
	const extractPath = path.join(appPath, "app.asar_extracted");

	if (!checkPermissions(appPath) || !checkPermissions(asarPath)) {
		if (isElevated()) {
			console.error(
				chalk.redBright(
					"[-] Still no permissions even with elevated privileges",
				),
			);
			process.exit(1);
		}
		console.log(
			chalk.yellowBright(
				"[!] Administrator/sudo privileges required for unpatching",
			),
		);
		await requestElevation(scriptPath);
	}

	if (isMac) {
		mac.unpatch(appPath, asarPath);
	} else {
		const executablePath = getExecutablePath(appPath);
		winLinux.unpatch(executablePath, appPath, asarPath);
	}
	rm(extractPath);

	console.log(chalk.greenBright("[+] Successfully unpatched!"));
}
