/**
 * Agent interaction logging utility for tracking multi-agent orchestration
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { loadProjectConfig } from '../../config/projectConfig';

export type AgentType = 'manager' | 'dev' | 'qa' | 'unknown';

const AGENT_TYPES: readonly string[] = ['manager', 'dev', 'qa', 'unknown'];

export function isAgentType(value: unknown): value is AgentType {
  return typeof value === 'string' && AGENT_TYPES.includes(value);
}

/**
 * One logged command. There is no exit code or run outcome: no lambda
 * command has a run outcome to record, so they would always be absent.
 */
export interface LogEntry {
  ts: string;
  agent: AgentType;
  cmd: string;
  args: string[];
  outcome: 'success' | 'failure';
  error?: string;
  ticketId?: string;
  duration?: number;
}

function hasKey<K extends string>(
  obj: object,
  key: K
): obj is object & Record<K, unknown> {
  return key in obj;
}

function isLogEntry(value: unknown): value is LogEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  return (
    hasKey(value, 'ts') &&
    typeof value.ts === 'string' &&
    hasKey(value, 'agent') &&
    isAgentType(value.agent) &&
    hasKey(value, 'cmd') &&
    typeof value.cmd === 'string' &&
    hasKey(value, 'args') &&
    Array.isArray(value.args) &&
    hasKey(value, 'outcome') &&
    (value.outcome === 'success' || value.outcome === 'failure')
  );
}

const LOG_FILE = path.join('.lambda', 'agent-log.jsonl');
const MAX_LINES = 500;
const KEEP_LINES = 250;

/**
 * The log file: `<project>/.lambda/agent-log.jsonl`. Undefined outside a
 * project (or when its lambda.json can't be read), and then nothing is logged.
 *
 * The log lives under the project, next to the rest of its `.lambda/` state.
 * Outside a project there is no project folder to put it in, and writing
 * `.lambda/` into whatever folder `lambda tmux` happens to run from would
 * scatter logs (and a stray `.lambda/`) across unrelated folders. A broken
 * lambda.json is treated the same so a log write never turns a working
 * `lambda tmux` into a failure.
 */
export function getLogFilePath(
  cwd: string = process.cwd()
): string | undefined {
  try {
    const project = loadProjectConfig(cwd);

    return project === null ? undefined : path.join(project.root, LOG_FILE);
  } catch {
    return undefined;
  }
}

/**
 * Detect the calling agent based on environment and context
 * Priority: LAMBDA_WINDOW > TMUX_PANE query > unknown
 */
export function detectAgent(): AgentType {
  // 1. Check LAMBDA_WINDOW env var (set on each agent window)
  const lambdaWindow = process.env.LAMBDA_WINDOW;

  if (lambdaWindow) {
    if (lambdaWindow.includes('manager')) {
      return 'manager';
    }

    if (lambdaWindow.includes('dev')) {
      return 'dev';
    }

    if (lambdaWindow.includes('qa')) {
      return 'qa';
    }
  }

  // 2. Check TMUX_PANE and query tmux for window name
  const tmuxPane = process.env.TMUX_PANE;

  if (tmuxPane) {
    try {
      const windowName = execSync(
        `tmux display-message -t "${tmuxPane}" -p '#{window_name}'`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }
      ).trim();

      if (windowName.includes('manager')) {
        return 'manager';
      }

      if (windowName.includes('dev')) {
        return 'dev';
      }

      if (windowName.includes('qa')) {
        return 'qa';
      }
    } catch {
      // Ignore tmux errors
    }
  }

  // 3. Default to unknown
  return 'unknown';
}

/**
 * Extract ticket ID from current git branch (any `ABC-123` pattern)
 */
export function extractTicketId(
  cwd: string = process.cwd()
): string | undefined {
  try {
    const branch = execSync('git branch --show-current', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();

    const match = branch.match(/[A-Z][A-Z0-9]+-\d+/i);

    return match ? match[0].toUpperCase() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Rotate log file if it exceeds MAX_LINES
 * Keeps the last KEEP_LINES entries
 */
function rotateLogIfNeeded(logPath: string): void {
  if (!fs.existsSync(logPath)) {
    return;
  }

  const content = fs.readFileSync(logPath, 'utf-8');
  const lines = content.split('\n').filter((line) => line.trim());

  if (lines.length > MAX_LINES) {
    const keepLines = lines.slice(-KEEP_LINES);
    fs.writeFileSync(logPath, keepLines.join('\n') + '\n');
  }
}

/**
 * Append a log entry to the log file
 */
export function logCommand(
  entry: Omit<LogEntry, 'ts'>,
  cwd: string = process.cwd()
): void {
  const logPath = getLogFilePath(cwd);

  if (logPath === undefined) {
    return;
  }

  const dir = path.dirname(logPath);

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Rotate if needed
  rotateLogIfNeeded(logPath);

  // Create full entry with timestamp
  const fullEntry: LogEntry = {
    ts: new Date().toISOString(),
    ...entry,
  };

  // Append to file
  fs.appendFileSync(logPath, JSON.stringify(fullEntry) + '\n');
}

/**
 * Read log entries from the log file
 */
export function readLogEntries(options?: {
  tail?: number;
  agent?: AgentType;
}): LogEntry[] {
  const logPath = getLogFilePath();

  if (logPath === undefined || !fs.existsSync(logPath)) {
    return [];
  }

  const content = fs.readFileSync(logPath, 'utf-8');
  const parsed = content
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(isLogEntry);

  const filtered = options?.agent
    ? parsed.filter((e) => e.agent === options.agent)
    : parsed;

  const entries = options?.tail ? filtered.slice(-options.tail) : filtered;

  return entries;
}

/**
 * Wrapper for async command handlers that logs execution
 */
export function withLogging<T extends unknown[]>(
  cmd: string,
  handler: (...args: T) => Promise<void>
): (...args: T) => Promise<void> {
  return async (...args: T): Promise<void> => {
    const startTime = Date.now();
    const agent = detectAgent();
    const ticketId = extractTicketId();

    // Extract string args for logging (filter out complex objects)
    const stringArgs = args
      .filter((arg): arg is string => typeof arg === 'string')
      .slice(0, 5); // Limit to first 5 string args

    try {
      await handler(...args);

      logCommand({
        agent,
        cmd,
        args: stringArgs,
        outcome: 'success',
        ticketId,
        duration: Date.now() - startTime,
      });
    } catch (error) {
      logCommand({
        agent,
        cmd,
        args: stringArgs,
        outcome: 'failure',
        error: error instanceof Error ? error.message : String(error),
        ticketId,
        duration: Date.now() - startTime,
      });

      throw error;
    }
  };
}
