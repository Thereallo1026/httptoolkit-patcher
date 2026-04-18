import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import chalk from "chalk";

import { patchApp, unpatchApp } from "./patcher.js";

const __filename = (() => {
	if (process.pkg) return process.execPath;
	return fileURLToPath(import.meta.url);
})();

const GITHUB_REPO = "xenos1337/httptoolkit-patcher";
const LOCAL_VERSION = (() => {
	try {
		const pkg = JSON.parse(
			fs.readFileSync(
				path.join(path.dirname(__filename), "..", "package.json"),
				"utf-8",
			),
		);
		return pkg.version || "0.0.0";
	} catch {
		return "0.0.0";
	}
})();

function prompt(question) {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	return new Promise((resolve) =>
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer);
		}),
	);
}

function fetchJson(url) {
	return new Promise((resolve, reject) => {
		https
			.get(
				url,
				{
					headers: {
						"User-Agent": "httptoolkit-patcher",
						Accept: "application/vnd.github.v3+json",
					},
				},
				(res) => {
					if (res.statusCode !== 200) {
						reject(new Error(`HTTP ${res.statusCode}`));
						return;
					}
					let data = "";
					res.on("data", (chunk) => (data += chunk));
					res.on("end", () => {
						try {
							resolve(JSON.parse(data));
						} catch (e) {
							reject(e);
						}
					});
				},
			)
			.on("error", reject);
	});
}

function compareVersions(v1, v2) {
	const norm = (v) => v.replace(/^v/, "").split(".").map(Number);
	const [a, b] = [norm(v1), norm(v2)];
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		if ((a[i] || 0) > (b[i] || 0)) return 1;
		if ((a[i] || 0) < (b[i] || 0)) return -1;
	}
	return 0;
}

async function checkForUpdates() {
	try {
		const tags = await fetchJson(
			`https://api.github.com/repos/${GITHUB_REPO}/tags`,
		);
		if (!tags?.length) return;
		const latest = tags[0].name.replace(/^v/, "");
		if (compareVersions(latest, LOCAL_VERSION) > 0) {
			console.log(
				chalk.yellowBright(
					"\n╔════════════════════════════════════════════════════════════╗",
				),
			);
			console.log(
				chalk.yellowBright("║") +
					chalk.white("   A new version is available: ") +
					chalk.greenBright(`v${latest}`) +
					chalk.white(" (current: ") +
					chalk.gray(`v${LOCAL_VERSION}`) +
					chalk.white(")  ") +
					chalk.yellowBright("  ║"),
			);
			console.log(
				chalk.yellowBright("║") +
					chalk.white("  Update: ") +
					chalk.cyanBright(`https://github.com/${GITHUB_REPO}`) +
					chalk.white("  ") +
					chalk.yellowBright("║"),
			);
			console.log(
				chalk.yellowBright(
					"╚════════════════════════════════════════════════════════════╝\n",
				),
			);
		}
	} catch {
		/* ignore network errors */
	}
}

const args = process.argv.slice(2);
const command = args[0];

const commandName = process.pkg
	? path.basename(__filename)
	: `node ${process.argv[1]}`;
const injectJsPath = path.join(path.dirname(__filename), "inject.js");
const ctx = { prompt, scriptPath: __filename, injectJsPath };

(async () => {
	try {
		await checkForUpdates();

		if (command === "unpatch" || command === "restore") {
			await unpatchApp(ctx);
		} else if (command === "help" || command === "-h" || command === "--help") {
			console.log(chalk.blueBright("HTTP Toolkit Patcher"));
			console.log(chalk.white(`\nUsage: ${commandName} [command]`));
			console.log(chalk.white("\nCommands:"));
			console.log(
				chalk.white(`  patch    ${chalk.gray("Patch HTTP Toolkit (default)")}`),
			);
			console.log(
				chalk.white(
					`  unpatch  ${chalk.gray("Restore original HTTP Toolkit from backup")}`,
				),
			);
			console.log(chalk.white(`  restore  ${chalk.gray("Alias for unpatch")}`));
			console.log(chalk.white(`  help     ${chalk.gray("Show this help")}`));
		} else if (!command || command === "patch") {
			const answer = await prompt("Do you want to patch HTTP Toolkit? [Y/n]: ");
			if (answer.toLowerCase() === "n" || answer.toLowerCase() === "no") {
				console.log(chalk.blueBright("[+] Patching cancelled"));
				process.exit(0);
			}
			await patchApp(ctx);
		} else {
			console.error(chalk.redBright(`[-] Unknown command: ${command}`));
			process.exit(1);
		}
	} catch (error) {
		console.error(chalk.redBright(`[-] Error: ${error.message}`));
		process.exit(1);
	}
})();
