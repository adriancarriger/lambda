/**
 * Playwright trace reader
 *
 * Agent-friendly tool to inspect Playwright trace files when an E2E test fails.
 *
 * Usage:
 *   lambda trace <command> [trace-path] [options]
 *
 * Commands:
 *   summary       - Overview: status, failed action, console errors, screenshot
 *   errors        - Errors with 2 screenshots before/after
 *   actions       - High-level action sequence (goto, click, fill)
 *   screenshots   - List all screenshots with index numbers
 *   screenshot    - Get specific screenshot + neighbors
 *   console       - Filter console logs
 *   around        - Events around a timestamp
 *   timeline      - Condensed chronological view
 *   diagnose      - Error scan against known patterns (plus a project's own)
 *   diagnose-all  - Diagnose every trace in test-results/
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { z } from 'zod';

import {
  type ActionResult,
  type AfterEvent,
  type BeforeEvent,
  type BrowserEvent,
  type ConsoleEvent,
  type ContextOptionsEvent,
  type ErrorResult,
  type LogEvent,
  type ScreencastFrameEvent,
  type ScreenshotResult,
  type StderrEvent,
  type StdoutEvent,
  type TraceCommandOutput,
  type TraceContext,
  type TraceEvent,
  TraceEventSchema,
  pageErrorMessage,
} from './trace-types';

// Configuration
const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

const PLAYWRIGHT_CONFIGS = [
  'playwright.config.ts',
  'playwright.config.js',
  'playwright.config.mjs',
  'playwright.config.cjs',
];

/** The nearest folder, from `startDir` upward, holding a Playwright config. */
export function findPlaywrightConfigDir(startDir: string): string | null {
  const hasConfig = PLAYWRIGHT_CONFIGS.some((name) =>
    fs.existsSync(path.join(startDir, name))
  );

  if (hasConfig) {
    return startDir;
  }

  const parent = path.dirname(startDir);

  return parent === startDir ? null : findPlaywrightConfigDir(parent);
}

/**
 * `test-results/` sits next to the Playwright config. Without a config, the
 * current folder's `test-results/` is used.
 */
export function findTestResultsDir(startDir: string = process.cwd()): string {
  const configDir = findPlaywrightConfigDir(startDir);

  return path.join(configDir ?? startDir, 'test-results');
}

const getTestResultsDir = (): string => findTestResultsDir();

// Format relative time (e.g., "2 minutes ago")
function formatRelativeTime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }

  if (minutes > 0) {
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }

  return `${seconds} second${seconds === 1 ? '' : 's'} ago`;
}

// Get trace info (path, age, staleness)
function getTraceInfo(traceZipPath: string): {
  age: number;
  ageFormatted: string;
  isStale: boolean;
  mtime: Date;
} {
  const stat = fs.statSync(traceZipPath);
  const age = Date.now() - stat.mtimeMs;

  return {
    age,
    ageFormatted: formatRelativeTime(age),
    isStale: age > STALE_THRESHOLD_MS,
    mtime: stat.mtime,
  };
}

// Find all trace.zip files with metadata
function findAllTraces(): Array<{
  testName: string;
  tracePath: string;
  mtime: Date;
  age: number;
  ageFormatted: string;
  isStale: boolean;
}> {
  if (!fs.existsSync(getTestResultsDir())) {
    return [];
  }

  const dirs = fs.readdirSync(getTestResultsDir());
  const traces = dirs
    .map((dir) => {
      const traceZip = path.join(getTestResultsDir(), dir, 'trace.zip');

      if (!fs.existsSync(traceZip)) {
        return null;
      }

      const info = getTraceInfo(traceZip);

      return {
        testName: dir,
        tracePath: traceZip,
        ...info,
      };
    })
    .filter(
      (
        trace
      ): trace is {
        testName: string;
        tracePath: string;
        mtime: Date;
        age: number;
        ageFormatted: string;
        isStale: boolean;
      } => trace !== null
    )
    // Sort by mtime descending (newest first)
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  return traces;
}

// Interactive trace selection
async function selectTraceInteractively(): Promise<string> {
  const traces = findAllTraces();

  if (traces.length === 0) {
    throw new Error(
      `No trace.zip files found in ${getTestResultsDir()}. Run an E2E test first.`
    );
  }

  console.error('\n💡 No trace path provided - entering interactive mode.');
  console.error(
    '   Tip: Pass a path directly: lambda trace <command> <path-to-trace.zip>\n'
  );
  console.error('📋 Available traces:\n');

  traces.forEach((trace, i) => {
    const staleMarker = trace.isStale ? ' ⚠️  STALE' : '';
    const timeStr = trace.mtime.toLocaleTimeString();
    console.error(
      `  ${i + 1}. ${trace.testName}\n     ${
        trace.ageFormatted
      } (${timeStr})${staleMarker}\n`
    );
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  return new Promise((resolve, reject) => {
    rl.question('Select trace number: ', (answer) => {
      rl.close();

      const selection = parseInt(answer, 10);

      if (isNaN(selection) || selection < 1 || selection > traces.length) {
        reject(
          new Error(
            `Invalid selection. Enter a number between 1 and ${traces.length}`
          )
        );

        return;
      }

      const selected = traces[selection - 1];

      if (!selected) {
        reject(new Error('Invalid selection'));

        return;
      }

      resolve(selected.tracePath);
    });
  });
}

// Print trace info header
function printTraceHeader(traceZipPath: string): void {
  const info = getTraceInfo(traceZipPath);
  const timeStr = info.mtime.toLocaleString();

  console.error(`\n📂 Analyzing: ${traceZipPath}`);
  console.error(`⏰ Created: ${info.ageFormatted} (${timeStr})`);

  if (info.isStale) {
    console.error(
      `⚠️  WARNING: This trace is ${info.ageFormatted}. Run a fresh E2E test for current results.`
    );
  }

  console.error('');
}

// Unzip trace to sibling directory with caching
function unzipTrace(traceZipPath: string): string {
  const traceDir = path.dirname(traceZipPath);
  const outputDir = path.join(traceDir, 'unzipped');

  // Check cache: if unzipped/ exists and is newer than trace.zip, reuse it
  if (fs.existsSync(outputDir)) {
    const zipStat = fs.statSync(traceZipPath);
    const unzippedStat = fs.statSync(outputDir);

    if (unzippedStat.mtimeMs > zipStat.mtimeMs) {
      // Cache hit - unzipped is newer than zip
      return outputDir;
    }

    // Cache stale - remove and re-unzip
    fs.rmSync(outputDir, { recursive: true });
  }

  // Unzip into a temp folder and move it into place only once it worked, so
  // a failed unzip never leaves an unzipped/ the cache above would trust.
  const partialDir = fs.mkdtempSync(path.join(traceDir, 'unzipping-'));

  try {
    execFileSync('unzip', ['-q', traceZipPath, '-d', partialDir]);
  } catch (error) {
    fs.rmSync(partialDir, { recursive: true, force: true });

    throw error;
  }

  fs.renameSync(partialDir, outputDir);

  return outputDir;
}

// Get trace directory (unzip if needed) - async for interactive selection
async function getTraceDirAsync(inputPath?: string): Promise<{
  traceDir: string;
  traceZipPath: string | null;
}> {
  // Interactive selection if not provided
  const tracePath = inputPath
    ? path.isAbsolute(inputPath)
      ? inputPath
      : path.join(process.cwd(), inputPath)
    : await selectTraceInteractively();

  // Resolve relative paths for interactive selection result
  const resolvedTracePath = path.isAbsolute(tracePath)
    ? tracePath
    : path.join(process.cwd(), tracePath);

  // If it's a zip file, unzip it
  if (resolvedTracePath.endsWith('.zip')) {
    if (!fs.existsSync(resolvedTracePath)) {
      throw new Error(`Trace file not found: ${resolvedTracePath}`);
    }

    printTraceHeader(resolvedTracePath);

    return {
      traceDir: unzipTrace(resolvedTracePath),
      traceZipPath: resolvedTracePath,
    };
  }

  // If it's a directory, use it directly
  if (
    fs.existsSync(resolvedTracePath) &&
    fs.statSync(resolvedTracePath).isDirectory()
  ) {
    // Try to find the parent trace.zip for header info
    const parentZip = path.join(path.dirname(resolvedTracePath), 'trace.zip');
    const traceZipPath = fs.existsSync(parentZip) ? parentZip : null;

    if (traceZipPath) {
      printTraceHeader(traceZipPath);
    }

    return { traceDir: resolvedTracePath, traceZipPath };
  }

  throw new Error(`Invalid trace path: ${resolvedTracePath}`);
}

// Sync version for diagnose-all (which provides explicit paths)
export function getTraceDir(inputPath: string): string {
  // Resolve relative paths
  const tracePath = path.isAbsolute(inputPath)
    ? inputPath
    : path.join(process.cwd(), inputPath);

  // If it's a zip file, unzip it
  if (tracePath.endsWith('.zip')) {
    if (!fs.existsSync(tracePath)) {
      throw new Error(`Trace file not found: ${tracePath}`);
    }

    return unzipTrace(tracePath);
  }

  // If it's a directory, use it directly
  if (fs.existsSync(tracePath) && fs.statSync(tracePath).isDirectory()) {
    return tracePath;
  }

  throw new Error(`Invalid trace path: ${tracePath}`);
}

// Read a JSONL file: one JSON value per line, unparseable lines reported and skipped
function readJsonlFile(filePath: string): unknown[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter((line) => line.trim());

  return lines.flatMap((line): unknown[] => {
    try {
      const value: unknown = JSON.parse(line);

      return [value];
    } catch {
      console.error(`Failed to parse line: ${line.slice(0, 100)}...`);

      return [];
    }
  });
}

/** Any line's `type`, to tell a known kind that failed from one never read. */
const LineTypeSchema = z.object({ type: z.string() });

/**
 * The lines this reader knows, parsed; lines of other kinds (resource
 * snapshots…) are left out. A line of a known kind that fails its schema is
 * reported, as an unparseable line is, rather than vanishing from the trace.
 */
const toTraceEvents = (values: unknown[]): TraceEvent[] =>
  values.flatMap((value) => {
    const parsed = TraceEventSchema.safeParse(value);

    if (parsed.success) {
      return [parsed.data];
    }

    const line = LineTypeSchema.safeParse(value);

    if (line.success && TraceEventSchema.optionsMap.has(line.data.type)) {
      console.error(
        `Failed to read a "${line.data.type}" line: ${JSON.stringify(
          value
        ).slice(0, 100)}...`
      );
    }

    return [];
  });

const parseJsonlFile = (filePath: string): TraceEvent[] =>
  toTraceEvents(readJsonlFile(filePath));

/** Whichever time the last line of a trace carries, whatever its kind. */
const LastLineTimeSchema = z
  .object({
    startTime: z.number().optional(),
    endTime: z.number().optional(),
    timestamp: z.number().optional(),
  })
  .passthrough();

const lastLineTime = (value: unknown): number | undefined => {
  const parsed = LastLineTimeSchema.safeParse(value);

  if (!parsed.success) {
    return undefined;
  }

  const { startTime, endTime, timestamp } = parsed.data;

  return startTime || endTime || timestamp || undefined;
};

// Parse trace files into context
export function parseTrace(traceDir: string): TraceContext {
  const testTrace = parseJsonlFile(path.join(traceDir, 'test.trace'));

  // Load ALL numbered trace files (0-trace.trace, 1-trace.trace, etc.)
  // This ensures we capture errors from all browser contexts/pages
  const traceFiles = fs
    .readdirSync(traceDir)
    .filter((f) => /^\d+-trace\.trace$/.test(f))
    .sort(); // Ensure consistent order

  const browserLines = traceFiles.flatMap((f) =>
    readJsonlFile(path.join(traceDir, f))
  );
  const browserTrace = toTraceEvents(browserLines);

  // Extract context options
  const contextOptions = browserTrace.find(
    (e): e is ContextOptionsEvent => e.type === 'context-options'
  );

  // Extract screenshots
  const screenshots = browserTrace.filter(
    (e): e is ScreencastFrameEvent => e.type === 'screencast-frame'
  );

  // Extract console messages
  const consoleMessages = browserTrace.filter(
    (e): e is ConsoleEvent => e.type === 'console'
  );

  // Extract errors (pageError events)
  const errors = browserTrace.filter(
    (e): e is BrowserEvent => e.type === 'event' && e.method === 'pageError'
  );

  // Extract actions (before/after pairs for key API calls)
  const beforeEvents = browserTrace.filter(
    (e): e is BeforeEvent => e.type === 'before'
  );
  const afterEvents = browserTrace.filter(
    (e): e is AfterEvent => e.type === 'after'
  );

  const afterMap = new Map(afterEvents.map((e) => [e.callId, e]));

  const actions = beforeEvents
    .filter((e) => isKeyAction(actionApiName(e)))
    .map((before) => {
      const after = afterMap.get(before.callId);

      return {
        ...before,
        // Populate `apiName` from the human title / class.method so downstream
        // display works regardless of the source trace format.
        apiName: actionLabel(before),
        endTime: after?.endTime,
        error: after?.error?.message,
      };
    });

  // Extract logs
  const logs = browserTrace.filter((e): e is LogEvent => e.type === 'log');

  // Determine test status - find first assertion error in test.trace stdout
  const assertionError = testTrace.find(
    (event): event is StdoutEvent | StderrEvent =>
      (event.type === 'stdout' || event.type === 'stderr') &&
      (event.text.includes('Error:') || event.text.includes('Expected'))
  );

  // Check for page errors
  const [firstError] = errors;

  // Determine status and error info
  const statusInfo = (() => {
    if (assertionError) {
      const { text, timestamp } = assertionError;

      return {
        status: 'failed' as const,
        errorMessage: text,
        errorTime: timestamp,
      };
    }

    if (firstError) {
      return {
        status: 'failed' as const,
        errorMessage: pageErrorMessage(firstError),
        errorTime: firstError.time,
      };
    }

    return {
      status: 'passed' as const,
      errorMessage: undefined,
      errorTime: undefined,
    };
  })();

  const { status, errorMessage, errorTime } = statusInfo;

  // Calculate duration
  const startTime = contextOptions?.monotonicTime || 0;
  const endTime = lastLineTime(browserLines.at(-1)) ?? startTime;
  const duration = endTime - startTime;

  return {
    tracePath: traceDir,
    testName: contextOptions?.title || path.basename(traceDir),
    duration,
    status,
    errorTime,
    errorMessage,
    screenshots,
    consoleMessages,
    errors,
    actions,
    logs,
  };
}

// Check if an API name is a key action
// Newer Playwright traces (~1.44+) drop the single `apiName` on `before` events
// in favour of `class` + `method` (e.g. class "Frame", method "click") plus a
// human-readable `title`. Normalize so filtering/display work on both formats.
function actionApiName(e: BeforeEvent): string {
  if (e.apiName) {
    return e.apiName;
  }

  return [e.class, e.method].filter(Boolean).join('.');
}

function actionLabel(e: BeforeEvent): string {
  return e.title ?? actionApiName(e);
}

function isKeyAction(apiName: string | undefined): boolean {
  if (!apiName) {
    return false;
  }

  const normalized = apiName.toLowerCase();
  // The method is the segment after the last dot ("frame.click" → "click";
  // legacy "locator.click" → "click"), or the whole string if there's no dot.
  const method = normalized.includes('.')
    ? normalized.slice(normalized.lastIndexOf('.') + 1)
    : normalized;

  const keyMethods = [
    'goto',
    'click',
    'fill',
    'type',
    'press',
    'check',
    'uncheck',
    'selectoption',
    'setinputfiles',
  ];

  if (keyMethods.includes(method)) {
    return true;
  }

  // Assertions: legacy apiName is "expect.toBeVisible"; new format is method
  // "expect" (the matcher lives in `title`), so treat any expect as a key action.
  return method === 'expect' || normalized.startsWith('expect');
}

// Get screenshot path from sha1
function getScreenshotPath(traceDir: string, sha1: string): string {
  return path.join(traceDir, 'resources', sha1);
}

// Find screenshots around a timestamp
function getScreenshotsAround(
  screenshots: ScreencastFrameEvent[],
  timestamp: number,
  contextCount: number,
  traceDir: string
): ScreenshotResult {
  // Sort screenshots by timestamp
  const sorted = [...screenshots].sort((a, b) => a.timestamp - b.timestamp);

  // Handle empty array
  if (sorted.length === 0) {
    return {
      target: '',
      targetIndex: -1,
      timestamp: 0,
      before: [],
      after: [],
    };
  }

  // Find closest screenshot using reduce
  const closestIndex = sorted.reduce((bestIndex, screenshot, currentIndex) => {
    const currentDiff = Math.abs(screenshot.timestamp - timestamp);
    const bestScreenshot = sorted[bestIndex];
    const bestDiff = bestScreenshot
      ? Math.abs(bestScreenshot.timestamp - timestamp)
      : Infinity;

    return currentDiff < bestDiff ? currentIndex : bestIndex;
  }, 0);

  const target = sorted[closestIndex];

  if (!target) {
    return {
      target: '',
      targetIndex: -1,
      timestamp: 0,
      before: [],
      after: [],
    };
  }

  // Get screenshots before using slice and map
  const before = sorted
    .slice(Math.max(0, closestIndex - contextCount), closestIndex)
    .map((screenshot, idx) => ({
      index: Math.max(0, closestIndex - contextCount) + idx,
      path: getScreenshotPath(traceDir, screenshot.sha1),
      timestamp: screenshot.timestamp,
    }));

  // Get screenshots after using slice and map
  const after = sorted
    .slice(closestIndex + 1, closestIndex + 1 + contextCount)
    .map((screenshot, idx) => ({
      index: closestIndex + 1 + idx,
      path: getScreenshotPath(traceDir, screenshot.sha1),
      timestamp: screenshot.timestamp,
    }));

  return {
    target: getScreenshotPath(traceDir, target.sha1),
    targetIndex: closestIndex,
    timestamp: target.timestamp,
    before,
    after,
  };
}

// Output JSON result
function output<T>(command: string, tracePath: string, results: T): void {
  const result: TraceCommandOutput<T> = {
    command,
    tracePath,
    results,
  };
  console.log(JSON.stringify(result, null, 2));
}

// Load error-context.md from test results directory (Playwright writes this for failed tests)
function loadErrorContext(traceDir: string): {
  testName: string;
  errorMessage: string;
  errorLocation: string;
} | null {
  const testResultsDir = path.dirname(traceDir);
  const errorContextPath = path.join(testResultsDir, 'error-context.md');

  if (!fs.existsSync(errorContextPath)) {
    return null;
  }

  const content = fs.readFileSync(errorContextPath, 'utf-8');

  // Parse the markdown file
  // Format:
  // # Test info
  // - Name: <test name>
  // - Location: <file:line>
  // # Error details
  // ```
  // <error message>
  // ```

  const nameMatch = content.match(/- Name:\s*(.+)/);
  const locationMatch = content.match(/- Location:\s*(.+)/);
  const errorMatch = content.match(/# Error details\s*```\s*([\s\S]*?)```/);

  if (!errorMatch) {
    return null;
  }

  return {
    testName: nameMatch?.[1]?.trim() || 'Unknown test',
    errorMessage: errorMatch[1]?.trim() || 'Unknown error',
    errorLocation: locationMatch?.[1]?.trim() || 'Unknown location',
  };
}

export interface TraceSummary {
  testName: string;
  duration: string;
  status: TraceContext['status'];
  errorTime?: number;
  errorMessage?: string;
  errorLocation?: string;
  /** The first action that failed, with its error. */
  failedAction?: { apiName: string; error: string };
  /** Console errors, oldest first. */
  consoleErrors: string[];
  /** The screenshot nearest the failure (or the last one). */
  screenshot?: string;
  counts: {
    screenshots: number;
    consoleMessages: number;
    errors: number;
    actions: number;
  };
}

/** The summary of a parsed trace. */
export function buildSummary(ctx: TraceContext): TraceSummary {
  // Check for error-context.md which Playwright writes for failed tests
  const errorContext = loadErrorContext(ctx.tracePath);

  // If error-context.md exists, the test failed (even if trace says "passed")
  const actualStatus = errorContext ? 'failed' : ctx.status;
  const actualErrorMessage = errorContext?.errorMessage || ctx.errorMessage;

  const failed = ctx.actions.find((action) => action.error);
  const failedAction =
    failed?.error !== undefined
      ? { apiName: failed.apiName, error: failed.error }
      : undefined;

  const lastScreenshotTime =
    ctx.screenshots.length > 0
      ? Math.max(...ctx.screenshots.map((s) => s.timestamp))
      : 0;
  const errorTime = ctx.errorTime ?? failed?.endTime ?? lastScreenshotTime;
  const { target } = getScreenshotsAround(
    ctx.screenshots,
    errorTime,
    0,
    ctx.tracePath
  );

  return {
    testName: ctx.testName,
    duration: ctx.duration ? `${(ctx.duration / 1000).toFixed(2)}s` : 'unknown',
    status: actualStatus,
    errorTime: ctx.errorTime,
    errorMessage: actualErrorMessage?.slice(0, 500),
    errorLocation: errorContext?.errorLocation,
    failedAction,
    consoleErrors: ctx.consoleMessages
      .filter((m) => m.messageType === 'error')
      .map((m) => m.text.slice(0, 500)),
    screenshot: target || undefined,
    counts: {
      screenshots: ctx.screenshots.length,
      consoleMessages: ctx.consoleMessages.length,
      errors: ctx.errors.length,
      actions: ctx.actions.length,
    },
  };
}

// Command: summary
function commandSummary(ctx: TraceContext): void {
  output('summary', ctx.tracePath, buildSummary(ctx));
}

// Command: errors
function commandErrors(ctx: TraceContext): void {
  // Check for error-context.md which has the actual assertion failure
  const errorContext = loadErrorContext(ctx.tracePath);

  const errorResults = ctx.errors.map((error) => {
    const errorMessage = pageErrorMessage(error);
    const screenshotResult = getScreenshotsAround(
      ctx.screenshots,
      error.time,
      2,
      ctx.tracePath
    );

    // Get console messages around the error (+/-1000ms)
    const consoleContext = ctx.consoleMessages.filter(
      (c) => Math.abs(c.time - error.time) < 1000
    );

    return {
      timestamp: error.time,
      message: errorMessage || 'Unknown error',
      stack: error.params.error?.error?.stack,
      screenshots: {
        before: screenshotResult.before,
        target: {
          index: screenshotResult.targetIndex,
          path: screenshotResult.target,
          timestamp: screenshotResult.timestamp,
        },
        after: screenshotResult.after,
      },
      consoleContext,
    };
  });

  // If no pageError events, check for error-context.md or failed assertions via timing
  const fallbackResult = (() => {
    if (errorResults.length > 0) {
      return [];
    }

    // First check error-context.md (most reliable for assertion failures)
    if (errorContext) {
      // Use the last screenshot timestamp as the error time (assertion failed at end)
      const lastScreenshotTime =
        ctx.screenshots.length > 0
          ? Math.max(...ctx.screenshots.map((s) => s.timestamp))
          : 0;

      const screenshotResult = getScreenshotsAround(
        ctx.screenshots,
        lastScreenshotTime,
        2,
        ctx.tracePath
      );

      return [
        {
          timestamp: lastScreenshotTime,
          message: errorContext.errorMessage,
          location: errorContext.errorLocation,
          source: 'error-context.md' as const,
          screenshots: {
            before: screenshotResult.before,
            target: {
              index: screenshotResult.targetIndex,
              path: screenshotResult.target,
              timestamp: screenshotResult.timestamp,
            },
            after: screenshotResult.after,
          },
          consoleContext: [],
        },
      ];
    }

    // Fallback to ctx.errorTime if available
    if (ctx.errorTime) {
      const screenshotResult = getScreenshotsAround(
        ctx.screenshots,
        ctx.errorTime,
        2,
        ctx.tracePath
      );

      const consoleContext = ctx.consoleMessages.filter(
        (c) => Math.abs(c.time - ctx.errorTime!) < 1000
      );

      return [
        {
          timestamp: ctx.errorTime,
          message: ctx.errorMessage || 'Test failed',
          screenshots: {
            before: screenshotResult.before,
            target: {
              index: screenshotResult.targetIndex,
              path: screenshotResult.target,
              timestamp: screenshotResult.timestamp,
            },
            after: screenshotResult.after,
          },
          consoleContext,
        },
      ];
    }

    return [];
  })();

  const results: ErrorResult[] = [...errorResults, ...fallbackResult];

  output('errors', ctx.tracePath, results);
}

// Command: actions
function commandActions(ctx: TraceContext): void {
  const results: ActionResult[] = ctx.actions.map((action) => {
    const result: ActionResult = {
      timestamp: action.startTime,
      endTime: action.endTime,
      duration: action.endTime ? action.endTime - action.startTime : undefined,
      apiName: action.apiName,
    };

    // Extract selector/url/value from params
    const { params } = action;

    if (params.selector) {
      result.selector = String(params.selector);
    }

    if (params.url) {
      result.url = String(params.url);
    }

    if (params.value) {
      result.value = String(params.value);
    }

    if (action.error) {
      result.error = action.error;
    }

    return result;
  });

  output('actions', ctx.tracePath, results);
}

// Command: screenshots
function commandScreenshots(ctx: TraceContext): void {
  const sorted = [...ctx.screenshots].sort((a, b) => a.timestamp - b.timestamp);

  const results = sorted.map((s, index) => ({
    index,
    timestamp: s.timestamp,
    path: getScreenshotPath(ctx.tracePath, s.sha1),
    width: s.width,
    height: s.height,
  }));

  output('screenshots', ctx.tracePath, results);
}

// Command: screenshot
function commandScreenshot(
  ctx: TraceContext,
  options: Record<string, string | boolean | number>
): void {
  const at = options.at || 'error';
  const contextCount = Number(options.context) || (at === 'error' ? 2 : 0);

  const getTimestamp = (): number => {
    if (at === 'error') {
      return (
        ctx.errorTime ||
        ctx.screenshots[ctx.screenshots.length - 1]?.timestamp ||
        0
      );
    }

    if (typeof at === 'number' || !isNaN(Number(at))) {
      const index = Number(at);
      const sorted = [...ctx.screenshots].sort(
        (a, b) => a.timestamp - b.timestamp
      );
      const screenshot = sorted[index];

      if (!screenshot) {
        throw new Error(
          `Screenshot index ${index} out of range (0-${sorted.length - 1})`
        );
      }

      return screenshot.timestamp;
    }

    return Number(at);
  };

  const timestamp = getTimestamp();

  const result = getScreenshotsAround(
    ctx.screenshots,
    timestamp,
    contextCount,
    ctx.tracePath
  );
  output('screenshot', ctx.tracePath, result);
}

// Command: console
function commandConsole(
  ctx: TraceContext,
  options: Record<string, string | boolean | number>
): void {
  const limit = Number(options.limit) || 100;

  // Apply filters using chained operations
  const filteredMessages = ctx.consoleMessages
    .filter((m) => {
      // Filter by type if specified
      if (options.type) {
        return m.messageType === String(options.type);
      }

      return true;
    })
    .filter((m) => {
      // Filter by regex if specified
      if (options.filter) {
        const regex = new RegExp(String(options.filter), 'i');

        return regex.test(m.text);
      }

      return true;
    })
    .slice(0, limit);

  const results = filteredMessages.map((m) => ({
    timestamp: m.time,
    type: m.messageType,
    text: m.text,
    location: m.location
      ? `${m.location.url.split('/').pop()}:${m.location.lineNumber}`
      : undefined,
  }));

  output('console', ctx.tracePath, results);
}

// Command: around
function commandAround(
  ctx: TraceContext,
  options: Record<string, string | boolean | number>
): void {
  const time = Number(options.time);

  if (isNaN(time)) {
    throw new Error('--time is required for around command');
  }

  const window = Number(options.window) || 500;

  // Get events within window
  const consoleInWindow = ctx.consoleMessages.filter(
    (c) => Math.abs(c.time - time) <= window
  );

  const actionsInWindow = ctx.actions.filter(
    (a) => Math.abs(a.startTime - time) <= window
  );

  const logsInWindow = ctx.logs.filter(
    (l) => Math.abs(l.time - time) <= window
  );

  const errorsInWindow = ctx.errors.filter(
    (e) => Math.abs(e.time - time) <= window
  );

  // Get nearest screenshot
  const screenshotResult = getScreenshotsAround(
    ctx.screenshots,
    time,
    1,
    ctx.tracePath
  );

  output('around', ctx.tracePath, {
    targetTime: time,
    window: `±${window}ms`,
    nearestScreenshot: screenshotResult.target,
    events: {
      console: consoleInWindow.map((c) => ({
        time: c.time,
        type: c.messageType,
        text: c.text.slice(0, 200),
      })),
      actions: actionsInWindow.map((a) => ({
        time: a.startTime,
        apiName: a.apiName,
      })),
      logs: logsInWindow.map((l) => ({
        time: l.time,
        message: l.message,
      })),
      errors: errorsInWindow.map((e) => ({
        time: e.time,
        message: pageErrorMessage(e),
      })),
    },
  });
}

/** A known error and what to do about it. `diagnose` reports every match. */
export interface ErrorPattern {
  pattern: RegExp;
  category: string;
  explanation: string;
  solution: string;
}

/**
 * The patterns every project gets. A project adds its own through
 * `registerTraceCommand(program, { extraPatterns })`; they are checked after
 * these, so a project pattern only claims text these don't. lambda.json's
 * `trace.patterns` can also put one ahead of a category here.
 *
 * Each piece of text gets the first pattern that matches it, so the order
 * counts: the specific ones come before the generic ones they overlap.
 */
export const DEFAULT_ERROR_PATTERNS: ErrorPattern[] = [
  // Access errors
  {
    pattern: /permission denied|\bforbidden\b/i,
    category: 'Permission Denied',
    explanation:
      'The server refused this operation: the user may not have access to it.',
    solution:
      "Check what the signed-in user is allowed to do, and the server's access checks.",
  },
  {
    pattern: /\bunauthori[sz]ed\b|\bunauthenticated\b|not signed in/i,
    category: 'Auth Error',
    explanation: 'The request needed a signed-in user, and had none.',
    solution:
      'Make sure the test signs in before this step, and that the session has not expired.',
  },
  // Timeout errors
  {
    pattern: /Timed out.*waiting for/i,
    category: 'Timeout',
    explanation:
      'A Playwright assertion or wait timed out. The expected element/state did not appear in time.',
    solution:
      'Check screenshots to see actual UI state. May indicate a backend error preventing the UI from updating.',
  },
  // Network errors
  {
    pattern: /status of 4\d\d/i,
    category: 'HTTP 4xx Error',
    explanation: 'Client error response from server (400-499).',
    solution: 'Check the specific status code and request details.',
  },
  {
    pattern: /status of 5\d\d/i,
    category: 'HTTP 5xx Error',
    explanation:
      'Server error response (500-599). Backend crashed or unavailable.',
    solution: "Check the server's logs for the actual error.",
  },
  // Generic errors
  {
    pattern: /Something went wrong/i,
    category: 'UI Error',
    explanation: 'The UI displayed a generic error message to the user.',
    solution:
      'Check the console and backend logs for the actual error that caused this.',
  },
  {
    pattern: /Unhandled error|unhandledRejection/i,
    category: 'Unhandled Exception',
    explanation: 'An unhandled exception occurred.',
    solution: 'Check the stack trace for the source of the error.',
  },
  {
    pattern: /ECONNREFUSED|ETIMEDOUT/i,
    category: 'Connection Error',
    explanation: 'Failed to connect to a service (database, API, etc.).',
    solution: 'Verify all services are running and accessible.',
  },
];

// Diagnose results type
export interface DiagnoseResults {
  summary: string;
  issueCount: number;
  byCategory: Record<string, number>;
  primaryDiagnosis: {
    explanation: string;
    recommendation: string;
  };
  issues: Array<{
    category: string;
    timestamp: number;
    source: string;
    explanation: string;
    solution: string;
    snippet: string;
  }>;
}

interface DiagnosticIssue {
  category: string;
  timestamp: number;
  source: 'console' | 'pageError' | 'testOutput';
  text: string;
  explanation: string;
  solution: string;
}

/** The categories that make a diagnosis critical. */
const CRITICAL_CATEGORIES = ['Permission Denied', 'Test Assertion Failed'];

/** One issue per piece of text a pattern matches. */
const matchIssue = (
  patterns: ErrorPattern[],
  text: string,
  timestamp: number,
  source: DiagnosticIssue['source']
): DiagnosticIssue[] => {
  const patternInfo = patterns.find(({ pattern }) => pattern.test(text));

  if (!patternInfo) {
    return [];
  }

  return [
    {
      category: patternInfo.category,
      timestamp,
      source,
      text: text.slice(0, 800),
      explanation: patternInfo.explanation,
      solution: patternInfo.solution,
    },
  ];
};

/** stdout/stderr/error events from test.trace, as text. */
const testOutputTexts = (
  tracePath: string
): Array<{ text: string; timestamp: number }> => {
  const testTracePath = path.join(tracePath, 'test.trace');

  if (!fs.existsSync(testTracePath)) {
    return [];
  }

  return parseJsonlFile(testTracePath).flatMap((event) => {
    if (event.type === 'stdout' || event.type === 'stderr') {
      const { text, timestamp } = event;

      return text ? [{ text, timestamp }] : [];
    }

    if (event.type === 'error') {
      const { message } = event;

      // error events don't have timestamps
      return message ? [{ text: message, timestamp: 0 }] : [];
    }

    return [];
  });
};

/** Scan a parsed trace for known error patterns (shared by diagnose and diagnose-all). */
export function getDiagnoseResults(
  ctx: TraceContext,
  options?: { patterns?: ErrorPattern[] }
): DiagnoseResults {
  const patterns = options?.patterns ?? DEFAULT_ERROR_PATTERNS;

  const consoleIssues = ctx.consoleMessages.flatMap((msg) =>
    matchIssue(patterns, msg.text, msg.time, 'console')
  );

  const pageErrorIssues = ctx.errors.flatMap((error) =>
    matchIssue(patterns, pageErrorMessage(error) || '', error.time, 'pageError')
  );

  // test.trace stdout/stderr/error catches what never reaches the browser console
  const testOutputIssues = testOutputTexts(ctx.tracePath).flatMap(
    ({ text, timestamp }) => matchIssue(patterns, text, timestamp, 'testOutput')
  );

  // Check error-context.md for test assertion failures (Playwright writes this for failed tests)
  const errorContext = loadErrorContext(ctx.tracePath);
  const errorContextIssues: DiagnosticIssue[] = errorContext
    ? [
        (() => {
          const errorPatternInfo = patterns.find(({ pattern }) =>
            pattern.test(errorContext.errorMessage)
          );

          return {
            category: errorPatternInfo?.category || 'Test Assertion Failed',
            timestamp: 0, // error-context.md doesn't have a timestamp
            source: 'testOutput' as const,
            text: errorContext.errorMessage.slice(0, 800),
            explanation:
              errorPatternInfo?.explanation ||
              'A Playwright assertion (expect) timed out or failed. The expected element or state was not found.',
            solution:
              errorPatternInfo?.solution ||
              'Check the screenshots to see the actual UI state. The element may not have appeared due to a backend error or timing issue.',
          };
        })(),
      ]
    : [];

  // Sort by timestamp
  const issues = [
    ...consoleIssues,
    ...pageErrorIssues,
    ...testOutputIssues,
    ...errorContextIssues,
  ].sort((a, b) => a.timestamp - b.timestamp);

  // Deduplicate issues (same category within 1 second)
  const uniqueIssues = issues.reduce<DiagnosticIssue[]>((acc, issue) => {
    const isDuplicate = acc.some(
      (existing) =>
        existing.category === issue.category &&
        Math.abs(existing.timestamp - issue.timestamp) < 1000
    );

    return isDuplicate ? acc : [...acc, issue];
  }, []);

  const byCategory = uniqueIssues.reduce<Record<string, number>>(
    (acc, issue) => ({
      ...acc,
      [issue.category]: (acc[issue.category] || 0) + 1,
    }),
    {}
  );

  const criticalIssue = uniqueIssues.find((i) =>
    CRITICAL_CATEGORIES.includes(i.category)
  );
  const primaryIssue = criticalIssue || uniqueIssues[0];

  const summary =
    uniqueIssues.length === 0
      ? '✅ No known error patterns detected'
      : criticalIssue
      ? `🚨 CRITICAL ISSUES FOUND - ${uniqueIssues.length} unique error(s) detected`
      : `⚠️  ${uniqueIssues.length} potential issue(s) detected`;

  return {
    summary,
    issueCount: uniqueIssues.length,
    byCategory,
    primaryDiagnosis: primaryIssue
      ? {
          explanation: primaryIssue.explanation,
          recommendation: primaryIssue.solution,
        }
      : {
          explanation: 'No known error patterns were detected in the trace.',
          recommendation:
            "Trace looks clean. If the test still fails, check the app's own logs.",
        },
    issues: uniqueIssues.slice(0, 10).map((issue) => ({
      category: issue.category,
      timestamp: issue.timestamp,
      source: issue.source,
      explanation: issue.explanation,
      solution: issue.solution,
      // Truncate text for readability
      snippet:
        issue.text.slice(0, 200) + (issue.text.length > 200 ? '...' : ''),
    })),
  };
}

// Command: diagnose (comprehensive error scan)
function commandDiagnose(ctx: TraceContext, patterns: ErrorPattern[]): void {
  output('diagnose', ctx.tracePath, getDiagnoseResults(ctx, { patterns }));
}

// Command: timeline
function commandTimeline(ctx: TraceContext): void {
  type TimelineEvent = {
    time: number;
    type: string;
    description: string;
  };

  // Build description for an action
  const buildActionDescription = (
    action: TraceContext['actions'][0]
  ): string => {
    const { params } = action;
    const parts = [action.apiName];

    if (params.url) {
      parts[0] = `${parts[0]} → ${params.url}`;
    }

    if (params.selector) {
      parts[0] = `${parts[0]} → ${String(params.selector).slice(0, 50)}`;
    }

    if (action.error) {
      parts[0] = `${parts[0]} [FAILED: ${action.error}]`;
    }

    return parts[0];
  };

  // Build all events using functional composition
  const startEvent: TimelineEvent = {
    time: 0,
    type: 'start',
    description: `Test started: ${ctx.testName}`,
  };

  const actionEvents: TimelineEvent[] = ctx.actions.map((action) => ({
    time: action.startTime,
    type: 'action',
    description: buildActionDescription(action),
  }));

  const consoleErrorEvents: TimelineEvent[] = ctx.consoleMessages
    .filter((m) => m.messageType === 'error')
    .map((msg) => ({
      time: msg.time,
      type: 'console.error',
      description: msg.text.slice(0, 100),
    }));

  const pageErrorEvents: TimelineEvent[] = ctx.errors.map((error) => ({
    time: error.time,
    type: 'pageError',
    description: pageErrorMessage(error) || 'Unknown error',
  }));

  const endEvent: TimelineEvent[] = ctx.duration
    ? [
        {
          time: ctx.duration,
          type: 'end',
          description: `Test ${ctx.status}: ${(ctx.duration / 1000).toFixed(
            2
          )}s`,
        },
      ]
    : [];

  // Combine all events and sort by time
  const events = [
    startEvent,
    ...actionEvents,
    ...consoleErrorEvents,
    ...pageErrorEvents,
    ...endEvent,
  ].sort((a, b) => a.time - b.time);

  output('timeline', ctx.tracePath, events);
}

// Command: diagnose-all (diagnose all traces in test-results)
function commandDiagnoseAll(
  options: Record<string, string | boolean | number>,
  patterns: ErrorPattern[]
): void {
  if (!fs.existsSync(getTestResultsDir())) {
    console.log(JSON.stringify({ error: 'No test-results directory found' }));

    return;
  }

  const verbose = options.verbose === true;
  const dirs = fs.readdirSync(getTestResultsDir());

  // Find all trace.zip files
  const traces = dirs
    .map((dir) => {
      const traceZip = path.join(getTestResultsDir(), dir, 'trace.zip');

      return fs.existsSync(traceZip)
        ? { testName: dir, tracePath: traceZip }
        : null;
    })
    .filter(
      (trace): trace is { testName: string; tracePath: string } =>
        trace !== null
    );

  if (traces.length === 0) {
    console.log(
      JSON.stringify({ error: 'No trace.zip files found in test-results/' })
    );

    return;
  }

  console.log(`\n🔍 Analyzing ${traces.length} trace(s)...\n`);

  // Diagnose each trace and count skipped
  const skippedCount = traces.reduce((count, { testName, tracePath }) => {
    try {
      const traceDir = getTraceDir(tracePath);
      const ctx = parseTrace(traceDir);
      const results = getDiagnoseResults(ctx, { patterns });

      // Skip traces with no issues unless --verbose flag is set
      if (!verbose && results.issueCount === 0) {
        return count + 1;
      }

      console.log(`\n━━━ ${testName} ━━━`);
      output('diagnose', ctx.tracePath, results);

      return count;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`\n━━━ ${testName} ━━━`);
      console.log(JSON.stringify({ error: message }));

      return count;
    }
  }, 0);

  if (skippedCount > 0) {
    console.log(
      `\n✅ ${skippedCount} trace(s) with no issues (use --verbose to show)`
    );
  }
}

export const TRACE_COMMANDS = [
  'summary',
  'errors',
  'actions',
  'screenshots',
  'screenshot',
  'console',
  'around',
  'timeline',
  'diagnose',
  'diagnose-all',
] as const;

/**
 * Run a trace command with the given options.
 * Exported for use with Commander.js integration.
 */
export async function runTraceCommand(
  command: string,
  tracePath: string | undefined,
  options: Record<string, string | boolean | number>,
  patterns: ErrorPattern[] = DEFAULT_ERROR_PATTERNS
): Promise<void> {
  try {
    // Handle diagnose-all specially (it finds its own traces)
    if (command === 'diagnose-all') {
      commandDiagnoseAll(options, patterns);

      return;
    }

    // Get trace directory (interactive if no path provided)
    const { traceDir } = await getTraceDirAsync(tracePath);

    // Parse trace
    const ctx = parseTrace(traceDir);

    // Execute command
    switch (command) {
      case 'summary':
        commandSummary(ctx);

        break;
      case 'errors':
        commandErrors(ctx);

        break;
      case 'actions':
        commandActions(ctx);

        break;
      case 'screenshots':
        commandScreenshots(ctx);

        break;
      case 'screenshot':
        commandScreenshot(ctx, options);

        break;
      case 'console':
        commandConsole(ctx, options);

        break;
      case 'around':
        commandAround(ctx, options);

        break;
      case 'timeline':
        commandTimeline(ctx);

        break;
      case 'diagnose':
        commandDiagnose(ctx, patterns);

        break;
      default:
        console.error(`Unknown command: ${command}`);
        console.error(`Available commands: ${TRACE_COMMANDS.join(', ')}`);
        process.exit(1);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // Opt-in full stack for diagnosing trace-parser crashes (the plain
    // `{ error: message }` alone hides where a bad trace event blew up).
    if (process.env.LAMBDA_TRACE_DEBUG === '1' && error instanceof Error) {
      console.error(error.stack);
    }

    console.error(JSON.stringify({ error: message }));
    process.exit(1);
  }
}
