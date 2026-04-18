import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import chalk from "chalk";

// Launch the patched app once, capture its integrity check crash output,
// and extract both hashes from the error message. This is version-agnostic
// no need to know where the hash is stored in the binary.
export function captureIntegrityHashes(executablePath) {
	return new Promise((resolve, reject) => {
		let output = "";
		let finished = false;

		const child = spawn(executablePath, {
			cwd: path.dirname(executablePath),
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});

		const timeout = setTimeout(() => {
			if (!finished) {
				finished = true;
				child.kill();
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
				resolve({ originalHash: match[1], newHash: match[2] });
			}
		};

		child.stdout.on("data", handleData);
		child.stderr.on("data", handleData);

		child.on("error", (err) => {
			if (!finished) {
				finished = true;
				clearTimeout(timeout);
				reject(err);
			}
		});

		child.on("exit", () => {
			if (!finished) {
				clearTimeout(timeout);
				const match = output.match(
					/Integrity check failed for asar archive\s*\(\s*([0-9a-f]{64})\s*vs\s*([0-9a-f]{64})\s*\)/i,
				);
				if (match) {
					resolve({ originalHash: match[1], newHash: match[2] });
				} else {
					reject(
						new Error("Could not find integrity hashes in HTTP Toolkit output"),
					);
				}
			}
		});
	});
}

function swapHashInBinary(executablePath, originalHash, newHash) {
	if (originalHash.length !== newHash.length)
		throw new Error("Hash lengths do not match");
	const binary = fs.readFileSync(executablePath);
	const orig = Buffer.from(originalHash, "utf-8");
	const next = Buffer.from(newHash, "utf-8");
	let count = 0;
	let idx = binary.indexOf(orig);
	while (idx !== -1) {
		next.copy(binary, idx);
		count++;
		idx = binary.indexOf(orig, idx + orig.length);
	}
	if (count === 0)
		throw new Error(`Hash "${originalHash.slice(0, 8)}…" not found in binary`);
	fs.writeFileSync(executablePath, binary);
	return count;
}

/**
 * Patch the exe hash after capturing it from the app's crash output.
 * Also saves a sidecar so unpatch can reverse it.
 * @param {string} executablePath
 * @param {string} resourcesPath
 * @param {{ originalHash: string, newHash: string }} hashes
 */
export function patchBinary(executablePath, resourcesPath, hashes) {
	const { originalHash, newHash } = hashes;

	const hashSidecar = path.join(resourcesPath, "app.asar.bak.hash");
	if (!fs.existsSync(hashSidecar)) {
		fs.writeFileSync(hashSidecar, `${originalHash}\n${newHash}`, "utf-8");
	}

	const count = swapHashInBinary(executablePath, originalHash, newHash);
	console.log(
		chalk.greenBright(
			`[+] Patched binary hash (${count} replacement${count === 1 ? "" : "s"})`,
		),
	);
}

/**
 * Restore Windows/Linux to original state by restoring app.asar and reversing the hash swap.
 * @param {string} executablePath
 * @param {string} resourcesPath
 * @param {string} asarPath
 */
export function unpatch(executablePath, resourcesPath, asarPath) {
	const hashSidecar = path.join(resourcesPath, "app.asar.bak.hash");
	const asarBak = `${asarPath}.bak`;

	if (!fs.existsSync(asarBak)) {
		console.error(
			chalk.redBright("[-] app.asar.bak not found, cannot unpatch"),
		);
		process.exit(1);
	}
	if (!fs.existsSync(hashSidecar)) {
		console.error(
			chalk.redBright(
				"[-] app.asar.bak.hash not found, cannot restore binary hash",
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

	const count = swapHashInBinary(executablePath, patchedHash, originalHash);
	console.log(
		chalk.greenBright(
			`[+] Restored binary hash (${count} replacement${count === 1 ? "" : "s"})`,
		),
	);

	fs.rmSync(asarBak, { force: true });
	fs.rmSync(hashSidecar, { force: true });
	console.log(chalk.greenBright("[+] Cleaned up backup files"));
}
