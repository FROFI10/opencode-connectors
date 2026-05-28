#!/usr/bin/env node
/**
 * Interactive CLI to encrypt a GitHub token with a master passphrase.
 *
 * Usage:
 *   node connectors/github/dist/encrypt-token-cli.js
 *
 * Prompts (with masked input) for the GitHub token and the master passphrase,
 * then prints the encrypted string to copy into opencode.json.
 */
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { encryptToken } from "./crypto.js";

function ask(prompt: string, mask: boolean): Promise<string> {
  return new Promise((resolve) => {
    let muted = false;
    const mutedStdout = new Writable({
      write(chunk, _enc, cb) {
        if (!muted) process.stdout.write(chunk);
        else process.stdout.write("*");
        cb();
      },
    });
    const rl = createInterface({
      input: process.stdin,
      output: mutedStdout,
      terminal: true,
    });
    process.stdout.write(prompt);
    if (mask) muted = true;
    rl.question("", (answer) => {
      if (mask) process.stdout.write("\n");
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main(): Promise<void> {
  console.log("Encrypt a GitHub token for use with the github MCP connector.\n");

  const token = await ask("GitHub token (ghp_...): ", true);
  if (!token) {
    console.error("Token cannot be empty.");
    process.exit(1);
  }
  if (!/^gh[ps]_[A-Za-z0-9]{30,}$/.test(token)) {
    console.error(
      "Warning: token doesn't look like a standard GitHub PAT (ghp_/ghs_). Continuing anyway.",
    );
  }

  const pass1 = await ask("Master passphrase: ", true);
  if (pass1.length < 8) {
    console.error("Passphrase must be at least 8 characters.");
    process.exit(1);
  }
  const pass2 = await ask("Confirm passphrase: ", true);
  if (pass1 !== pass2) {
    console.error("Passphrases do not match.");
    process.exit(1);
  }

  const encrypted = encryptToken(token, pass1);

  console.log("\nDone. Paste this into opencode.json under environment.GITHUB_TOKEN_ENCRYPTED:\n");
  console.log(encrypted);
  console.log(
    "\nThen set OPENCODE_PASSPHRASE in your shell before launching OpenCode:",
  );
  console.log('  PowerShell:  $env:OPENCODE_PASSPHRASE = "<your passphrase>"');
  console.log('  bash / zsh:  export OPENCODE_PASSPHRASE="<your passphrase>"');
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
