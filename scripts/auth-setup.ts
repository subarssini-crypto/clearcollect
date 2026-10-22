/**
 * Generates the single-owner sign-in settings and saves them to .env:
 *
 *   npm run auth:setup
 *
 * Prompts for the owner password twice, then writes AUTH_SECRET (random) and
 * OWNER_PASSWORD_HASH (scrypt) into .env, replacing existing lines for those
 * two variables or appending them. Nothing secret is printed, and the
 * password itself is never written anywhere. Updating .env in place avoids
 * shell redirection, which in Windows PowerShell 5.1 would write UTF-16.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { hashPassword, MAX_PASSWORD_LENGTH, MIN_SECRET_LENGTH } from "../src/lib/auth";

const ENV_FILE = ".env";
const MIN_PASSWORD_LENGTH = 12;

/**
 * Line reader that never echoes what is typed: readline's echo goes to a
 * discarding stream, and prompts are written to stdout directly. Lines are
 * queued as they arrive, so piped input is not lost between questions.
 */
function createPrompter() {
  const silent = new Writable({ write: (_chunk, _encoding, callback) => callback() });
  const rl = createInterface({ input: process.stdin, output: silent, terminal: process.stdin.isTTY === true });
  const lines: string[] = [];
  const waiting: ((line: string | null) => void)[] = [];
  rl.on("line", (line) => (waiting.length ? waiting.shift()!(line) : lines.push(line)));
  rl.on("close", () => waiting.splice(0).forEach((resolve) => resolve(null)));
  return {
    async ask(question: string): Promise<string> {
      process.stdout.write(question);
      const line = lines.length ? lines.shift()! : await new Promise<string | null>((resolve) => waiting.push(resolve));
      process.stdout.write("\n");
      if (line === null) throw new Error("No input received");
      return line;
    },
    close: () => rl.close(),
  };
}

/** Sets `name="value"` in .env text, replacing an existing assignment or appending one. */
export function setEnvVar(text: string, name: string, value: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const line = `${name}="${value}"`;
  const pattern = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=.*$`, "gm");
  if (pattern.test(text)) return text.replace(pattern, () => line);
  const sep = text === "" || text.endsWith("\n") ? "" : eol;
  return `${text}${sep}${line}${eol}`;
}

async function main() {
  if (!process.stdin.isTTY) {
    // e.g. Git Bash/mintty, where the terminal itself may echo what is typed.
    console.warn("Note: stdin is not an interactive terminal; your terminal may display the password as you type.");
  }
  const prompter = createPrompter();
  let password: string;
  try {
    password = await prompter.ask(`Owner password (${MIN_PASSWORD_LENGTH}+ characters): `);
    if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
      throw new Error(`Password must be ${MIN_PASSWORD_LENGTH}–${MAX_PASSWORD_LENGTH} characters`);
    }
    if ((await prompter.ask("Repeat password: ")) !== password) {
      throw new Error("Passwords do not match");
    }
  } finally {
    prompter.close();
  }

  const secret = randomBytes(MIN_SECRET_LENGTH).toString("base64url");
  const hash = await hashPassword(password);

  let env = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
  env = setEnvVar(env, "AUTH_SECRET", secret);
  env = setEnvVar(env, "OWNER_PASSWORD_HASH", hash);
  writeFileSync(ENV_FILE, env, "utf8");
  console.log(`Saved AUTH_SECRET and OWNER_PASSWORD_HASH to ${ENV_FILE}. Restart the server to apply them.`);
}

if (process.argv[1]?.endsWith("auth-setup.ts")) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
