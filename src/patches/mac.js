import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import chalk from "chalk";

function getBundleDir(resourcesPath) {
	const base = resourcesPath.replace(/[\\/]+$/, "");
	return base.toLowerCase().endsWith("resources") ? path.dirname(base) : base;
}

function patchInfoPlistHash(resourcesPath, originalHash, newHash) {
	const plistPath = path.join(getBundleDir(resourcesPath), "Info.plist");
	const content = fs.readFileSync(plistPath, "utf-8");
	if (!content.includes(originalHash))
		throw new Error("Original hash not found in Info.plist");
	fs.writeFileSync(
		plistPath,
		content.replaceAll(originalHash, newHash),
		"utf-8",
	);
}

// Re-sign the bundle ad-hoc after modifying the asar/Info.plist.
// Without this, Gatekeeper shows "app is damaged" dialog.
function resignBundle(appBundle) {
	const entitlementsPath = "/tmp/.httptoolkit-patch-entitlements.plist";
	fs.writeFileSync(
		entitlementsPath,
		`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
  <key>com.apple.security.cs.allow-dyld-environment-variables</key><true/>
</dict></plist>`,
	);
	try {
		execSync(
			`codesign --force --deep --sign - --entitlements "${entitlementsPath}" "${appBundle}"`,
			{ stdio: "pipe" },
		);
		execSync(`xattr -dr com.apple.quarantine "${appBundle}"`, {
			stdio: "pipe",
		});
		console.log(
			chalk.greenBright("[+] Re-signed app bundle and removed quarantine"),
		);
	} catch (e) {
		console.log(chalk.yellowBright(`[!] codesign/xattr failed: ${e.message}`));
	} finally {
		try {
			fs.unlinkSync(entitlementsPath);
		} catch {}
	}
}

// Launch the patched app once, capture the integrity check error from stderr,
// and extract both hashes. Same approach as Windows
// version-agnostic
// resourcesPath is needed to resign before launching so macOS allows execution.
export function captureIntegrityHashes(executablePath, resourcesPath) {
	// Must resign after asar repackage so macOS lets the process run at all.
	// The app will still crash on integrity mismatch
	const appBundle = path.dirname(getBundleDir(resourcesPath));
	resignBundle(appBundle);

	// Temporarily unload the crash reporter so the intentional integrity-check
	// crash doesn't trigger the "app can't be opened" dialog.
	try {
		execSync("launchctl unload -w /System/Library/LaunchAgents/com.apple.ReportCrash.plist", { stdio: "ignore" });
	} catch {}

	const restoreCrashReporter = () => {
		try {
			execSync("launchctl load -w /System/Library/LaunchAgents/com.apple.ReportCrash.plist", { stdio: "ignore" });
		} catch {}
	};

	return new Promise((resolve, reject) => {
		let output = "";
		let finished = false;

		const child = spawn(executablePath, {
			stdio: ["ignore", "pipe", "pipe"],
		});

		const timeout = setTimeout(() => {
			if (!finished) {
				finished = true;
				child.kill();
				restoreCrashReporter();
				reject(new Error("Timed out waiting for integrity check output"));
			}
		}, 20000);

		const handleData = (data) => {
			output += data.toString();
			const match = output.match(
				/Integrity check failed for asar archive\s*\(\s*([0-9a-f]{64})\s*vs\s*([0-9a-f]{64})\s*\)/i,
			);
			if (match && !finished) {
				finished = true;
				clearTimeout(timeout);
				child.kill();
				restoreCrashReporter();
				resolve({ originalHash: match[1], newHash: match[2] });
			}
		};

		child.stdout.on("data", handleData);
		child.stderr.on("data", handleData);

		child.on("error", (err) => {
			if (!finished) {
				finished = true;
				clearTimeout(timeout);
				restoreCrashReporter();
				reject(err);
			}
		});

		child.on("exit", (code) => {
			if (!finished) {
				clearTimeout(timeout);
				restoreCrashReporter();
				const match = output.match(
					/Integrity check failed for asar archive\s*\(\s*([0-9a-f]{64})\s*vs\s*([0-9a-f]{64})\s*\)/i,
				);
				if (match) {
					resolve({ originalHash: match[1], newHash: match[2] });
				} else {
					reject(
						new Error(`Could not find integrity hashes in HTTP Toolkit output (exit ${code}):\n${output.slice(-2000)}`),
					);
				}
			}
		});
	});
}

/**
 * Apply macOS-specific patches after the asar has been repackaged.
 * Captures the integrity hashes by launching the app once, then patches
 * Info.plist and re-signs the bundle. No binary patching required.
 * @param {string} resourcesPath  path to the Resources directory
 * @param {string} hashes         { originalHash, newHash } from captureIntegrityHashes
 */
export function patchInfoPlist(resourcesPath, hashes) {
	const { originalHash, newHash } = hashes;
	const appBundle = path.dirname(path.dirname(resourcesPath));

	// Save original hash sidecar for unpatch
	const hashSidecar = path.join(resourcesPath, "app.asar.bak.hash");
	if (!fs.existsSync(hashSidecar)) {
		fs.writeFileSync(hashSidecar, `${originalHash}\n${newHash}`, "utf-8");
	}

	console.log(chalk.white(`    ${originalHash} → ${newHash}`));
	patchInfoPlistHash(resourcesPath, originalHash, newHash);
	console.log(chalk.greenBright("[+] Updated Info.plist hash"));

	resignBundle(appBundle);
}

/**
 * Restore macOS to original state: restore asar, restore Info.plist hash, re-sign.
 * @param {string} resourcesPath
 * @param {string} asarPath
 */
export function unpatch(resourcesPath, asarPath) {
	const appBundle = path.dirname(path.dirname(resourcesPath));
	const asarBak = `${asarPath}.bak`;
	const hashSidecar = path.join(resourcesPath, "app.asar.bak.hash");

	if (!fs.existsSync(asarBak)) {
		console.error(
			chalk.redBright("[-] app.asar.bak not found, cannot unpatch"),
		);
		process.exit(1);
	}
	if (!fs.existsSync(hashSidecar)) {
		console.error(
			chalk.redBright(
				"[-] app.asar.bak.hash not found, cannot restore Info.plist hash",
			),
		);
		process.exit(1);
	}

	const [originalHash, patchedHash] = fs
		.readFileSync(hashSidecar, "utf-8")
		.trim()
		.split("\n");

	fs.copyFileSync(asarBak, asarPath);
	console.log(chalk.greenBright("[+] Restored app.asar from backup"));

	patchInfoPlistHash(resourcesPath, patchedHash, originalHash);
	console.log(chalk.greenBright("[+] Restored Info.plist hash"));

	resignBundle(appBundle);

	fs.rmSync(asarBak, { force: true });
	fs.rmSync(hashSidecar, { force: true });
	console.log(chalk.greenBright("[+] Cleaned up backup files"));
}
