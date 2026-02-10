/**
 * Wait command - Peek-then-block waiting for tmux pane output.
 *
 * First call (peek): Returns after ~1s with current output. Creates receipt.
 * Second call (same args): Blocks until pattern/idle/exit. Deletes receipt.
 */
import { execSync } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

import { RECEIPT_DIR } from "../../config";
import { getPaneStatusTag, isShellIdle } from "../tmux/pane-status";

import chalk from "chalk";

const RECEIPT_EXPIRY_MS = 2 * 60 * 1000; // 2 minutes
const POLL_INTERVAL_MS = 1000;

function ensureReceiptDir(): void {
  if (!fs.existsSync(RECEIPT_DIR)) {
    fs.mkdirSync(RECEIPT_DIR, { recursive: true });
  }
}

function receiptKey(pattern: string | undefined, pane: string): string {
  const data = `${pattern ?? ""}:${pane}`;
  const hash = createHash("md5").update(data).digest("hex");

  return `${paneHash(pane)}_${hash}`;
}

function paneHash(pane: string): string {
  return createHash("md5").update(pane).digest("hex").slice(0, 8);
}

function receiptPath(key: string): string {
  return path.join(RECEIPT_DIR, `${key}.receipt`);
}

function hasValidReceipt(key: string): boolean {
  const rPath = receiptPath(key);

  if (!fs.existsSync(rPath)) {
    return false;
  }

  const stat = fs.statSync(rPath);
  const age = Date.now() - stat.mtimeMs;

  if (age > RECEIPT_EXPIRY_MS) {
    fs.unlinkSync(rPath);

    return false;
  }

  return true;
}

function createReceipt(key: string): void {
  ensureReceiptDir();
  fs.writeFileSync(receiptPath(key), Date.now().toString());
}

function deleteReceipt(key: string): void {
  const rPath = receiptPath(key);

  if (fs.existsSync(rPath)) {
    fs.unlinkSync(rPath);
  }
}

function sendReceiptPath(pane: string): string {
  return path.join(RECEIPT_DIR, `${paneHash(pane)}_send.receipt`);
}

/**
 * Create a send receipt for a pane.
 * This records that `sendText` already captured output (the "peek"),
 * so the next `wait` call can skip peek and go straight to blocking.
 */
export function createSendReceipt(pane: string): void {
  ensureReceiptDir();
  fs.writeFileSync(sendReceiptPath(pane), Date.now().toString());
}

/**
 * Check if a valid (non-expired) send receipt exists for a pane.
 */
export function hasSendReceipt(pane: string): boolean {
  const rPath = sendReceiptPath(pane);

  if (!fs.existsSync(rPath)) {
    return false;
  }

  const stat = fs.statSync(rPath);
  const age = Date.now() - stat.mtimeMs;

  if (age > RECEIPT_EXPIRY_MS) {
    fs.unlinkSync(rPath);

    return false;
  }

  return true;
}

/**
 * Remove the send receipt for a pane.
 */
export function deleteSendReceipt(pane: string): void {
  const rPath = sendReceiptPath(pane);

  if (fs.existsSync(rPath)) {
    fs.unlinkSync(rPath);
  }
}

/**
 * Clear all wait receipts for a given pane.
 * Called when a new command is sent to a pane so the next wait starts fresh (peek).
 */
export function clearReceiptsForPane(pane: string): void {
  if (!fs.existsSync(RECEIPT_DIR)) {
    return;
  }

  const prefix = paneHash(pane);
  const files = fs.readdirSync(RECEIPT_DIR);

  files.forEach((file) => {
    if (file.startsWith(prefix) && file.endsWith(".receipt")) {
      fs.unlinkSync(path.join(RECEIPT_DIR, file));
    }
  });
}

export function capturePaneOutput(pane: string): string {
  try {
    return execSync(`tmux capture-pane -t "${pane}" -p`, {
      encoding: "utf-8",
      timeout: 5000,
    }).trimEnd();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);

    if (msg.includes("can't find") || msg.includes("no such")) {
      console.error(chalk.red(`Error: Pane "${pane}" not found.`));
      listAvailablePanes();
      process.exit(1);
    }

    throw e;
  }
}

function listAvailablePanes(): void {
  try {
    const panes = execSync(
      'tmux list-panes -a -F "#{session_name}:#{window_name}.#{pane_index}"',
      { encoding: "utf-8", timeout: 5000 },
    ).trim();
    console.error(chalk.yellow("\nAvailable panes:"));

    panes.split("\n").forEach((p) => {
      console.error(`  ${p}`);
    });
  } catch {
    // tmux not running — nothing to list
  }
}

function cleanPattern(raw: string): string {
  // Remove backslash-escaped pipes — common mistake from shell escaping
  return raw.replace(/\\\|/g, "|");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tailLines(output: string, n: number): string {
  const lines = output.split("\n");

  return lines.slice(-n).join("\n");
}

async function runPeek(
  pane: string,
  lines: number,
  key: string,
): Promise<void> {
  // Brief delay to capture fresh output
  await sleep(1000);
  const output = capturePaneOutput(pane);
  createReceipt(key);
  const status = getPaneStatusTag(pane);
  console.log(
    `=== PEEK (${new Date().toLocaleTimeString()}) ${status} — Run same command again to block until done ===`,
  );
  console.log(tailLines(output, lines));
}

function buildRegex(pattern: string | undefined): RegExp | undefined {
  if (!pattern) {
    return undefined;
  }

  const cleaned = cleanPattern(pattern);

  try {
    return new RegExp(cleaned);
  } catch {
    console.error(chalk.red(`Invalid regex pattern: "${cleaned}"`));
    process.exit(1);
  }
}

async function runWait(
  pattern: string | undefined,
  pane: string,
  timeoutSec: number,
  idleSec: number,
  lines: number,
  key: string,
): Promise<void> {
  const regex = buildRegex(pattern);

  // eslint-disable-next-line no-restricted-syntax -- reassigned in poll loop
  let elapsed = 0;
  // eslint-disable-next-line no-restricted-syntax -- reassigned in poll loop
  let lastOutput = "";
  // eslint-disable-next-line no-restricted-syntax -- reassigned in poll loop
  let idleCount = 0;

  while (elapsed < timeoutSec * 1000) {
    const output = capturePaneOutput(pane);

    // Pattern match check
    if (regex && regex.test(output)) {
      deleteReceipt(key);

      console.log(
        `=== COMPLETED (found pattern at ${new Date().toLocaleTimeString()}) ===`,
      );
      console.log(tailLines(output, lines));
      process.exit(0);
    }

    // Check if the shell is idle (command finished)
    if (isShellIdle(pane)) {
      deleteReceipt(key);

      console.log(
        `=== COMPLETED (command exited at ${new Date().toLocaleTimeString()}) ===`,
      );
      console.log(tailLines(output, lines));
      process.exit(0);
    }

    // Idle detection
    if (output === lastOutput) {
      idleCount += POLL_INTERVAL_MS;

      if (idleCount >= idleSec * 1000) {
        deleteReceipt(key);
        console.log(
          `=== IDLE (no new output for ${idleSec}s at ${new Date().toLocaleTimeString()}) ===`,
        );
        console.log(tailLines(output, lines));
        process.exit(0);
      }
    } else {
      idleCount = 0;
      lastOutput = output;
    }

    await sleep(POLL_INTERVAL_MS);
    elapsed += POLL_INTERVAL_MS;
  }

  // Timeout — keep receipt so next call blocks immediately instead of peeking
  createReceipt(key);
  console.log(
    `=== STILL RUNNING (timeout at ${new Date().toLocaleTimeString()}) ===`,
  );
  const output = capturePaneOutput(pane);
  console.log(tailLines(output, lines));
  process.exit(1);
}

export interface RunWaitOptions {
  pattern?: string;
  pane: string;
  timeoutSec?: number;
  idleSec?: number;
  lines?: number;
}

export async function runWaitCommand(opts: RunWaitOptions): Promise<void> {
  const { pattern, pane, timeoutSec = 120, idleSec = 15, lines = 40 } = opts;
  const key = receiptKey(pattern, pane);

  const sendReceiptValid = hasSendReceipt(pane);

  if (sendReceiptValid) {
    deleteSendReceipt(pane);
  }

  if (!hasValidReceipt(key) && !sendReceiptValid) {
    await runPeek(pane, lines, key);
  } else {
    await runWait(pattern, pane, timeoutSec, idleSec, lines, key);
  }
}
