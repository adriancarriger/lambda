/**
 * Agent Context - Check Claude Code context/token usage
 *
 * This command reads Claude Code JSONL files directly to get token usage,
 * without requiring tmux interaction (works even when agent is busy).
 *
 * Usage:
 *   lambda agent context --window lambda:dev
 *   lambda agent context --window lambda:dev --warn-at 90000
 *   lambda agent context --window lambda:dev --map /path/to/window-map.json
 *
 * Sessions come from a window map: a JSON file of
 * `{ "<session>:<window>": { sessionId, cwd, updatedAt } }`, kept up to date
 * by something the project runs (a Claude Code hook, say). Lambda doesn't
 * write it.
 */
import { existsSync, readFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { WINDOW_MAP_ENV, windowMapPath } from './windows';

const MAX_TOKENS = 200000; // Claude's context window
const SYSTEM_OVERHEAD_TOKENS = 4000; // Approximate overhead from system prompt, tools, etc.

export interface ContextOptions {
  window: string;
  warnAt?: number;
  /** The window map; see windowMapPath for the default. */
  map?: string;
  json?: boolean;
}

export interface ContextResult {
  contextTokens: number | null;
  maxTokens: number;
  percentage: number | null;
  shouldCompact: boolean;
  sessionId: string | null;
  lastUpdated: string | null;
}

interface WindowSessionMap {
  [windowName: string]: {
    sessionId: string;
    cwd: string;
    updatedAt: string;
  };
}

interface UsageData {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

/**
 * Get the encoded project directory name for JSONL path.
 * Converts /home/foo/bar to -home-foo-bar
 */
function encodeProjectPath(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

/**
 * Read window-to-session mapping file
 */
function readWindowMap(mapPath: string): WindowSessionMap | null {
  try {
    if (!existsSync(mapPath)) {
      return null;
    }

    return JSON.parse(readFileSync(mapPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Get the JSONL file path for a session
 */
function getJsonlPath(cwd: string, sessionId: string): string {
  const encodedPath = encodeProjectPath(cwd);

  return path.join(
    os.homedir(),
    '.claude/projects',
    encodedPath,
    `${sessionId}.jsonl`
  );
}

/**
 * Read JSONL file and find the last assistant message with usage data
 */
function getLastUsage(
  jsonlPath: string
): { usage: UsageData; timestamp: string } | null {
  try {
    if (!existsSync(jsonlPath)) {
      return null;
    }

    const content = readFileSync(jsonlPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);

    // Find last assistant message with usage (iterate from end)
    const parseEntry = (
      line: string
    ): {
      type?: string;
      message?: { usage?: unknown };
      timestamp?: string;
    } | null => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    };

    const lastAssistantWithUsage = [...lines].reverse().find((line) => {
      const entry = parseEntry(line);

      return entry?.type === 'assistant' && entry?.message?.usage;
    });

    if (lastAssistantWithUsage) {
      const entry = parseEntry(lastAssistantWithUsage);

      if (entry?.message?.usage) {
        return {
          usage: entry.message.usage,
          timestamp: entry.timestamp || new Date().toISOString(),
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Calculate total context tokens from usage data.
 * Context = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
 */
function calculateContextTokens(usage: UsageData): number {
  const inputTokens = usage.input_tokens || 0;
  const cacheCreation = usage.cache_creation_input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;

  return inputTokens + cacheCreation + cacheRead;
}

export async function runContext(options: ContextOptions): Promise<void> {
  const target = options.window;
  const warnThreshold = options.warnAt || 90000;

  if (!target) {
    console.error('Error: --window parameter is required.');
    console.error('');
    console.error('Usage: lambda agent context --window lambda:dev');
    process.exit(1);
  }

  const mapPath = windowMapPath({ map: options.map });

  if (mapPath === null) {
    console.error(
      `Error: No window map: pass --map <file> or set ${WINDOW_MAP_ENV}, or run inside a project.`
    );
    process.exit(1);
  }

  // Read window-to-session mapping
  const windowMap = readWindowMap(mapPath);

  if (!windowMap) {
    console.error('Error: No Claude sessions tracked yet.');
    console.error('');
    console.error(
      `Sessions are read from ${mapPath}. Lambda doesn't write it: keep it up to`
    );
    console.error(
      'date with something that records each tmux window and its Claude session id'
    );
    console.error('(a Claude Code hook, say), or point --map at one.');
    process.exit(1);
  }

  const windowData = windowMap[target];

  if (!windowData) {
    const availableWindows = Object.keys(windowMap);

    console.error(`Error: No session found for window "${target}"`);
    console.error('');
    console.error("The agent in this window hasn't received any prompts yet.");
    console.error('Send a message to the agent first, then try again.');

    if (availableWindows.length > 0) {
      console.error('');
      console.error('Available windows with sessions:');
      availableWindows.forEach((w) => console.error(`  - ${w}`));
    }
    process.exit(1);
  }

  const { sessionId, cwd, updatedAt } = windowData;

  // Get JSONL file path
  const jsonlPath = getJsonlPath(cwd, sessionId);

  if (!existsSync(jsonlPath)) {
    console.error(`Error: Session file not found: ${jsonlPath}`);
    console.error('');
    console.error('The session may have been cleared or the file was deleted.');
    process.exit(1);
  }

  // Get last usage data
  const lastUsageData = getLastUsage(jsonlPath);

  const result: ContextResult = {
    contextTokens: null,
    maxTokens: MAX_TOKENS,
    percentage: null,
    shouldCompact: false,
    sessionId,
    lastUpdated: lastUsageData?.timestamp || updatedAt,
  };

  if (lastUsageData) {
    result.contextTokens =
      calculateContextTokens(lastUsageData.usage) + SYSTEM_OVERHEAD_TOKENS;
    result.percentage = Math.round((result.contextTokens / MAX_TOKENS) * 100);
    result.shouldCompact = result.contextTokens >= warnThreshold;
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.shouldCompact ? 1 : 0);
  }

  // Human-readable output
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Window: ${target}`);
  console.log(`Session: ${sessionId.slice(0, 8)}...`);

  if (result.contextTokens !== null) {
    const tokenStr = result.contextTokens.toLocaleString();
    const maxStr = MAX_TOKENS.toLocaleString();
    const pctStr = `${result.percentage}%`;

    console.log(`Context: ${tokenStr} / ${maxStr} tokens (${pctStr})`);

    if (result.shouldCompact) {
      console.log('');
      console.log('\x1b[33m⚠️  WARNING: Context is high!\x1b[0m');
      console.log(
        `\x1b[33m   Consider running: lambda agent compact -w ${target}\x1b[0m`
      );
    }
  } else {
    console.log('Context: No usage data yet (waiting for first response)');
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  process.exit(result.shouldCompact ? 1 : 0);
}
