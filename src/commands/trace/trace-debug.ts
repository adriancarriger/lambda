/**
 * E2E Trace Debug Tool
 *
 * LLM-friendly tool to inspect Playwright trace files for debugging E2E test failures.
 *
 * Usage:
 *   lambda trace <command> [trace-path] [options]
 *
 * Commands:
 *   summary       - Overview + assertion expected/received
 *   errors        - Errors with 2 screenshots before/after
 *   actions       - High-level action sequence (goto, click, fill)
 *   screenshots   - List all screenshots with index numbers
 *   screenshot    - Get specific screenshot + neighbors
 *   console       - Filter console logs
 *   around        - Events around a timestamp
 *   timeline      - Condensed chronological view
 *   diagnose      - Comprehensive error scan (catches ALL known error patterns)
 *   diagnose-all  - Diagnose traces in test-results/ (use --verbose for details)
 */
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

import type {
  ActionResult,
  AfterEvent,
  BeforeEvent,
  BrowserEvent,
  ConsoleEvent,
  ContextOptionsEvent,
  ErrorResult,
  LogEvent,
  ScreencastFrameEvent,
  ScreenshotResult,
  TraceCommandOutput,
  TraceContext,
  TraceEvent,
} from "./trace-types";

// Configuration
const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Find the test-results directory using a heuristic:
 * 1. Check process.cwd()/test-results
 * 2. Search upward for a directory containing test-results/
 */
function findTestResultsDir(): string {
  // 1. Check current working directory
  const cwdPath = path.join(process.cwd(), "test-results");

  if (fs.existsSync(cwdPath)) {
    return cwdPath;
  }

  // 2. Search upward for test-results/
  const searchUpward = (startDir: string): string | null => {
    if (startDir === path.dirname(startDir)) {
      return null;
    }

    const testResultsPath = path.join(startDir, "test-results");

    if (fs.existsSync(testResultsPath)) {
      return testResultsPath;
    }

    return searchUpward(path.dirname(startDir));
  };

  const result = searchUpward(process.cwd());

  if (result) {
    return result;
  }

  throw new Error(
    "Could not find test-results directory.\n" +
      "Run from a directory with test-results/, or a parent directory containing it.",
  );
}

// Lazy-loaded test results directory - using closure for memoization
const getTestResultsDir = (() => {
  // eslint-disable-next-line no-restricted-syntax -- let needed for memoization closure
  let cached: string | null = null;

  return (): string => {
    if (!cached) {
      cached = findTestResultsDir();
    }

    return cached;
  };
})();

// Format relative time (e.g., "2 minutes ago")
function formatRelativeTime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }

  if (minutes > 0) {
    return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }

  return `${seconds} second${seconds === 1 ? "" : "s"} ago`;
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
      const traceZip = path.join(getTestResultsDir(), dir, "trace.zip");

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
        trace,
      ): trace is {
        testName: string;
        tracePath: string;
        mtime: Date;
        age: number;
        ageFormatted: string;
        isStale: boolean;
      } => trace !== null,
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
      `No trace.zip files found in ${getTestResultsDir()}. Run an E2E test first.`,
    );
  }

  console.error("\n💡 No trace path provided - entering interactive mode.");
  console.error(
    "   Tip: Pass a path directly: lambda trace <command> <path-to-trace.zip>\n",
  );
  console.error("📋 Available traces:\n");

  traces.forEach((trace, i) => {
    const staleMarker = trace.isStale ? " ⚠️  STALE" : "";
    const timeStr = trace.mtime.toLocaleTimeString();
    console.error(
      `  ${i + 1}. ${trace.testName}\n     ${
        trace.ageFormatted
      } (${timeStr})${staleMarker}\n`,
    );
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  return new Promise((resolve, reject) => {
    rl.question("Select trace number: ", (answer) => {
      rl.close();

      const selection = parseInt(answer, 10);

      if (isNaN(selection) || selection < 1 || selection > traces.length) {
        reject(
          new Error(
            `Invalid selection. Enter a number between 1 and ${traces.length}`,
          ),
        );

        return;
      }

      const selected = traces[selection - 1];

      if (!selected) {
        reject(new Error("Invalid selection"));

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
      `⚠️  WARNING: This trace is ${info.ageFormatted}. Run a fresh E2E test for current results.`,
    );
  }

  console.error("");
}

// Unzip trace to sibling directory with caching
function unzipTrace(traceZipPath: string): string {
  const traceDir = path.dirname(traceZipPath);
  const outputDir = path.join(traceDir, "unzipped");

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

  // Unzip fresh
  fs.mkdirSync(outputDir, { recursive: true });
  execSync(`unzip -q "${traceZipPath}" -d "${outputDir}"`);

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
  if (resolvedTracePath.endsWith(".zip")) {
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
    const parentZip = path.join(path.dirname(resolvedTracePath), "trace.zip");
    const traceZipPath = fs.existsSync(parentZip) ? parentZip : null;

    if (traceZipPath) {
      printTraceHeader(traceZipPath);
    }

    return { traceDir: resolvedTracePath, traceZipPath };
  }

  throw new Error(`Invalid trace path: ${resolvedTracePath}`);
}

// Sync version for diagnose-all (which provides explicit paths)
function getTraceDir(inputPath: string): string {
  // Resolve relative paths
  const tracePath = path.isAbsolute(inputPath)
    ? inputPath
    : path.join(process.cwd(), inputPath);

  // If it's a zip file, unzip it
  if (tracePath.endsWith(".zip")) {
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

// Parse JSONL file
function parseJsonlFile<T = TraceEvent>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter((line) => line.trim());

  return lines
    .map((line) => {
      try {
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- JSONL line parsed to generic trace event type
        return JSON.parse(line) as T;
      } catch {
        console.error(`Failed to parse line: ${line.slice(0, 100)}...`);

        return null;
      }
    })
    .filter((event): event is T => event !== null);
}

// Parse trace files into context
function parseTrace(traceDir: string): TraceContext {
  const testTrace = parseJsonlFile(path.join(traceDir, "test.trace"));

  // Load ALL numbered trace files (0-trace.trace, 1-trace.trace, etc.)
  // This ensures we capture errors from all browser contexts/pages
  const traceFiles = fs
    .readdirSync(traceDir)
    .filter((f) => /^\d+-trace\.trace$/.test(f))
    .sort(); // Ensure consistent order

  const browserTrace = traceFiles.flatMap((f) =>
    parseJsonlFile(path.join(traceDir, f)),
  );

  // Extract context options
  const contextOptions = browserTrace.find(
    (e): e is ContextOptionsEvent => e.type === "context-options",
  );

  // Extract screenshots
  const screenshots = browserTrace.filter(
    (e): e is ScreencastFrameEvent => e.type === "screencast-frame",
  );

  // Extract console messages
  const consoleMessages = browserTrace.filter(
    (e): e is ConsoleEvent => e.type === "console",
  );

  // Extract errors (pageError events)
  const errors = browserTrace.filter(
    (e): e is BrowserEvent => e.type === "event" && e.method === "pageError",
  );

  // Extract actions (before/after pairs for key API calls)
  const beforeEvents = browserTrace.filter(
    (e): e is BeforeEvent => e.type === "before",
  );
  const afterEvents = browserTrace.filter(
    (e): e is AfterEvent => e.type === "after",
  );

  const afterMap = new Map(afterEvents.map((e) => [e.callId, e]));

  const actions = beforeEvents
    .filter((e) => isKeyAction(e.apiName))
    .map((before) => {
      const after = afterMap.get(before.callId);

      return {
        ...before,
        endTime: after?.endTime,
        error: after?.error?.message,
      };
    });

  // Extract logs
  const logs = browserTrace.filter((e): e is LogEvent => e.type === "log");

  // Determine test status - find first assertion error in test.trace stdout
  const assertionError = testTrace.find((event) => {
    if (event.type !== "stdout" && event.type !== "stderr") {
      return false;
    }

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- stdout/stderr trace events have untyped text field
    const { text } = event as { text: string };

    return text.includes("Error:") || text.includes("Expected");
  });

  // Check for page errors
  const [firstError] = errors;

  // Determine status and error info
  const statusInfo = (() => {
    if (assertionError) {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- stdout/stderr trace events have untyped text/timestamp fields
      const { text, timestamp } = assertionError as {
        text: string;
        timestamp: number;
      };

      return {
        status: "failed" as const,
        errorMessage: text,
        errorTime: timestamp,
      };
    }

    if (firstError) {
      return {
        status: "failed" as const,
        errorMessage: firstError.params.error?.error.message,
        errorTime: firstError.time,
      };
    }

    return {
      status: "passed" as const,
      errorMessage: undefined,
      errorTime: undefined,
    };
  })();

  const { status, errorMessage, errorTime } = statusInfo;

  // Calculate duration
  const startTime = contextOptions?.monotonicTime || 0;
  const lastEvent = browserTrace[browserTrace.length - 1];
  const endTime =
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- trace events are a union type, need to try each variant
    (lastEvent as BeforeEvent)?.startTime ||
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- trace events are a union type, need to try each variant
    (lastEvent as AfterEvent)?.endTime ||
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- trace events are a union type, need to try each variant
    (lastEvent as ScreencastFrameEvent)?.timestamp ||
    startTime;
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
function isKeyAction(apiName: string): boolean {
  const keyActions = [
    "page.goto",
    "page.click",
    "locator.click",
    "locator.fill",
    "locator.type",
    "locator.press",
    "page.fill",
    "page.type",
    "expect.toHaveValue",
    "expect.toBeVisible",
    "expect.toHaveText",
    "expect.toHaveURL",
    "expect.toHaveTitle",
    "expect.not.toBeVisible",
  ];

  return keyActions.some((action) => apiName.includes(action));
}

// Get screenshot path from sha1
function getScreenshotPath(traceDir: string, sha1: string): string {
  return path.join(traceDir, "resources", sha1);
}

// Find screenshots around a timestamp
function getScreenshotsAround(
  screenshots: ScreencastFrameEvent[],
  timestamp: number,
  contextCount: number,
  traceDir: string,
): ScreenshotResult {
  // Sort screenshots by timestamp
  const sorted = [...screenshots].sort((a, b) => a.timestamp - b.timestamp);

  // Handle empty array
  if (sorted.length === 0) {
    return {
      target: "",
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
      target: "",
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
  const errorContextPath = path.join(testResultsDir, "error-context.md");

  if (!fs.existsSync(errorContextPath)) {
    return null;
  }

  const content = fs.readFileSync(errorContextPath, "utf-8");

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
    testName: nameMatch?.[1]?.trim() || "Unknown test",
    errorMessage: errorMatch[1]?.trim() || "Unknown error",
    errorLocation: locationMatch?.[1]?.trim() || "Unknown location",
  };
}

// Command: summary
function commandSummary(ctx: TraceContext): void {
  // Check for error-context.md which Playwright writes for failed tests
  const errorContext = loadErrorContext(ctx.tracePath);

  // If error-context.md exists, the test failed (even if trace says "passed")
  const actualStatus = errorContext ? "failed" : ctx.status;
  const actualErrorMessage = errorContext?.errorMessage || ctx.errorMessage;

  const result = {
    testName: ctx.testName,
    duration: ctx.duration ? `${(ctx.duration / 1000).toFixed(2)}s` : "unknown",
    status: actualStatus,
    errorTime: ctx.errorTime,
    errorMessage: actualErrorMessage?.slice(0, 500),
    errorLocation: errorContext?.errorLocation,
    counts: {
      screenshots: ctx.screenshots.length,
      consoleMessages: ctx.consoleMessages.length,
      errors: ctx.errors.length,
      actions: ctx.actions.length,
    },
  };
  output("summary", ctx.tracePath, result);
}

// Command: errors
function commandErrors(ctx: TraceContext): void {
  // Check for error-context.md which has the actual assertion failure
  const errorContext = loadErrorContext(ctx.tracePath);

  const errorResults = ctx.errors.map((error) => {
    const errorInfo = error.params.error?.error;
    const screenshotResult = getScreenshotsAround(
      ctx.screenshots,
      error.time,
      2,
      ctx.tracePath,
    );

    // Get console messages around the error (+/-1000ms)
    const consoleContext = ctx.consoleMessages.filter(
      (c) => Math.abs(c.time - error.time) < 1000,
    );

    return {
      timestamp: error.time,
      message: errorInfo?.message || "Unknown error",
      stack: errorInfo?.stack,
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
        ctx.tracePath,
      );

      return [
        {
          timestamp: lastScreenshotTime,
          message: errorContext.errorMessage,
          location: errorContext.errorLocation,
          source: "error-context.md" as const,
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
        ctx.tracePath,
      );

      const consoleContext = ctx.consoleMessages.filter(
        (c) => Math.abs(c.time - ctx.errorTime!) < 1000,
      );

      return [
        {
          timestamp: ctx.errorTime,
          message: ctx.errorMessage || "Test failed",
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

  output("errors", ctx.tracePath, results);
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
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- action params are untyped in trace format
    const params = action.params as Record<string, unknown>;

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

  output("actions", ctx.tracePath, results);
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

  output("screenshots", ctx.tracePath, results);
}

// Command: screenshot
function commandScreenshot(
  ctx: TraceContext,
  options: Record<string, string | boolean | number>,
): void {
  const at = options.at || "error";
  const contextCount = Number(options.context) || (at === "error" ? 2 : 0);

  const getTimestamp = (): number => {
    if (at === "error") {
      return (
        ctx.errorTime ||
        ctx.screenshots[ctx.screenshots.length - 1]?.timestamp ||
        0
      );
    }

    if (typeof at === "number" || !isNaN(Number(at))) {
      const index = Number(at);
      const sorted = [...ctx.screenshots].sort(
        (a, b) => a.timestamp - b.timestamp,
      );
      const screenshot = sorted[index];

      if (!screenshot) {
        throw new Error(
          `Screenshot index ${index} out of range (0-${sorted.length - 1})`,
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
    ctx.tracePath,
  );
  output("screenshot", ctx.tracePath, result);
}

// Command: console
function commandConsole(
  ctx: TraceContext,
  options: Record<string, string | boolean | number>,
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
        const regex = new RegExp(String(options.filter), "i");

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
      ? `${m.location.url.split("/").pop()}:${m.location.lineNumber}`
      : undefined,
  }));

  output("console", ctx.tracePath, results);
}

// Command: around
function commandAround(
  ctx: TraceContext,
  options: Record<string, string | boolean | number>,
): void {
  const time = Number(options.time);

  if (isNaN(time)) {
    throw new Error("--time is required for around command");
  }

  const window = Number(options.window) || 500;

  // Get events within window
  const consoleInWindow = ctx.consoleMessages.filter(
    (c) => Math.abs(c.time - time) <= window,
  );

  const actionsInWindow = ctx.actions.filter(
    (a) => Math.abs(a.startTime - time) <= window,
  );

  const logsInWindow = ctx.logs.filter(
    (l) => Math.abs(l.time - time) <= window,
  );

  const errorsInWindow = ctx.errors.filter(
    (e) => Math.abs(e.time - time) <= window,
  );

  // Get nearest screenshot
  const screenshotResult = getScreenshotsAround(
    ctx.screenshots,
    time,
    1,
    ctx.tracePath,
  );

  output("around", ctx.tracePath, {
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
        message: e.params.error?.error.message,
      })),
    },
  });
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
    action: TraceContext["actions"][0],
  ): string => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- action params are untyped in trace format
    const params = action.params as Record<string, unknown>;
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
    type: "start",
    description: `Test started: ${ctx.testName}`,
  };

  const actionEvents: TimelineEvent[] = ctx.actions.map((action) => ({
    time: action.startTime,
    type: "action",
    description: buildActionDescription(action),
  }));

  const consoleErrorEvents: TimelineEvent[] = ctx.consoleMessages
    .filter((m) => m.messageType === "error")
    .map((msg) => ({
      time: msg.time,
      type: "console.error",
      description: msg.text.slice(0, 100),
    }));

  const pageErrorEvents: TimelineEvent[] = ctx.errors.map((error) => ({
    time: error.time,
    type: "pageError",
    description: error.params.error?.error.message || "Unknown error",
  }));

  const endEvent: TimelineEvent[] = ctx.duration
    ? [
        {
          time: ctx.duration,
          type: "end",
          description: `Test ${ctx.status}: ${(ctx.duration / 1000).toFixed(
            2,
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

  output("timeline", ctx.tracePath, events);
}

// Diagnose results type
interface DiagnoseResults {
  summary: string;
  issueCount: number;
  recoveredCount?: number; // Count of issues that were recovered (hidden unless verbose)
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
    recovered?: boolean; // True if this issue was recovered (only shown in verbose mode)
  }>;
}

// Get diagnose results (shared by diagnose and diagnose-all)
function getDiagnoseResults(
  ctx: TraceContext,
  options?: { verbose?: boolean },
): DiagnoseResults {
  const verbose = options?.verbose ?? false;
  // Known error patterns with explanations and solutions (generic patterns only)
  const errorPatterns: Array<{
    pattern: RegExp;
    category: string;
    explanation: string;
    solution: string;
  }> = [
    // Timeout errors
    {
      pattern: /Timed out.*waiting for/i,
      category: "Timeout",
      explanation:
        "A Playwright assertion or wait timed out. The expected element/state did not appear in time.",
      solution:
        "Check screenshots to see actual UI state. May indicate a backend error preventing the UI from updating.",
    },
    // Element not found
    {
      pattern: /element.*not found|locator.*not found/i,
      category: "Element Not Found",
      explanation:
        "The selector did not match any element in the DOM at the time of the action.",
      solution:
        "Verify the selector is correct and the element exists. Check if a wait is needed.",
    },
    // Navigation errors
    {
      pattern: /navigation.*failed|net::ERR_/i,
      category: "Navigation Error",
      explanation: "Page navigation failed due to network or server error.",
      solution:
        "Check if the URL is correct and the server is running. Look for network errors in console.",
    },
    // Console errors
    {
      pattern: /console\.error|Uncaught Error|Unhandled Promise/i,
      category: "Console Error",
      explanation: "JavaScript error logged to browser console.",
      solution:
        "Check the error message and stack trace to identify the source of the error.",
    },
    // Network errors
    {
      pattern: /status of 4\d\d/i,
      category: "HTTP 4xx Error",
      explanation: "Client error response from server (400-499).",
      solution: "Check the specific status code and request details.",
    },
    {
      pattern: /status of 5\d\d/i,
      category: "HTTP 5xx Error",
      explanation:
        "Server error response (500-599). Backend crashed or unavailable.",
      solution: "Check server logs for the actual error.",
    },
    {
      pattern: /ECONNREFUSED|ETIMEDOUT/i,
      category: "Connection Error",
      explanation: "Failed to connect to a service (database, API, etc.).",
      solution: "Verify all services are running and accessible.",
    },
    // Strict mode violations
    {
      pattern: /strict mode violation|multiple elements/i,
      category: "Strict Mode Violation",
      explanation:
        "Selector matched multiple elements when Playwright expected exactly one.",
      solution:
        "Use a more specific selector to match only the intended element.",
    },
    // Frame issues
    {
      pattern: /frame.*detached|frame.*navigated/i,
      category: "Frame Detached",
      explanation:
        "The frame was removed from the DOM or navigated while an action was in progress.",
      solution:
        "Wait for frame to be stable before interacting, or handle frame lifecycle explicitly.",
    },
    // Dialog handling
    {
      pattern: /dialog.*not handled|unexpected dialog/i,
      category: "Unhandled Dialog",
      explanation:
        "A browser dialog (alert/confirm/prompt) appeared but was not handled.",
      solution:
        'Add page.on("dialog") handler before triggering the action that shows the dialog.',
    },
  ];

  interface DiagnosticIssue {
    category: string;
    timestamp: number;
    source: "console" | "pageError" | "testOutput";
    text: string;
    explanation: string;
    solution: string;
    recovered?: boolean;
  }

  const issues: DiagnosticIssue[] = [];

  // Patterns to ignore (noise that doesn't help debugging)
  const ignorePatterns = [
    /sentry/i, // Sentry errors are typically not test-relevant
    /ingest\..*sentry/i,
  ];

  const shouldIgnore = (text: string, location?: string): boolean => {
    const combined = `${text} ${location || ""}`;

    return ignorePatterns.some((pattern) => pattern.test(combined));
  };

  // Helper to find pattern info
  const findPatternInfo = (
    text: string,
  ): (typeof errorPatterns)[0] | undefined =>
    errorPatterns.find((patternInfo) => patternInfo.pattern.test(text));

  // Search all console messages
  ctx.consoleMessages.forEach((msg) => {
    // Skip noise
    if (shouldIgnore(msg.text, msg.location?.url)) {
      return;
    }

    const patternInfo = findPatternInfo(msg.text);

    if (patternInfo) {
      // eslint-disable-next-line no-restricted-syntax -- building arrays imperatively for diagnostic output
      issues.push({
        category: patternInfo.category,
        timestamp: msg.time,
        source: "console",
        text: msg.text.slice(0, 800),
        explanation: patternInfo.explanation,
        solution: patternInfo.solution,
      });
    }
  });

  // Search page errors
  ctx.errors.forEach((error) => {
    const errorMsg = error.params.error?.error.message || "";
    const patternInfo = findPatternInfo(errorMsg);

    if (patternInfo) {
      // eslint-disable-next-line no-restricted-syntax -- building arrays imperatively for diagnostic output
      issues.push({
        category: patternInfo.category,
        timestamp: error.time,
        source: "pageError",
        text: errorMsg.slice(0, 800),
        explanation: patternInfo.explanation,
        solution: patternInfo.solution,
      });
    }
  });

  // CRITICAL: Also search test.trace stdout/stderr/error for errors
  const testTracePath = path.join(ctx.tracePath, "test.trace");

  if (fs.existsSync(testTracePath)) {
    const testTrace = parseJsonlFile<TraceEvent>(testTracePath);

    testTrace.forEach((event) => {
      // Handle stdout/stderr events
      if (event.type === "stdout" || event.type === "stderr") {
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- stdout/stderr trace events have untyped text/timestamp fields
        const { text, timestamp } = event as {
          text: string;
          timestamp: number;
        };

        const patternInfo = findPatternInfo(text);

        if (patternInfo) {
          // eslint-disable-next-line no-restricted-syntax -- building arrays imperatively for diagnostic output
          issues.push({
            category: patternInfo.category,
            timestamp,
            source: "testOutput",
            text: text.slice(0, 800),
            explanation: patternInfo.explanation,
            solution: patternInfo.solution,
          });
        }
      }

      // Handle error events (Playwright test failures, Node.js errors)
      if (event.type === "error") {
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- error trace events have untyped message field
        const { message } = event as { message: string };

        if (message) {
          const patternInfo = findPatternInfo(message);

          if (patternInfo) {
            // eslint-disable-next-line no-restricted-syntax -- building arrays imperatively for diagnostic output
            issues.push({
              category: patternInfo.category,
              timestamp: 0, // error events don't have timestamps
              source: "testOutput",
              text: message.slice(0, 800),
              explanation: patternInfo.explanation,
              solution: patternInfo.solution,
            });
          }
        }
      }
    });
  }

  // Check error-context.md for test assertion failures (Playwright writes this for failed tests)
  const errorContext = loadErrorContext(ctx.tracePath);

  if (errorContext) {
    const errorPatternInfo = findPatternInfo(errorContext.errorMessage);

    // eslint-disable-next-line no-restricted-syntax -- building arrays imperatively for diagnostic output
    issues.push({
      category: errorPatternInfo?.category || "Test Assertion Failed",
      timestamp: 0,
      source: "testOutput",
      text: errorContext.errorMessage.slice(0, 800),
      explanation:
        errorPatternInfo?.explanation ||
        "A Playwright assertion (expect) timed out or failed. The expected element or state was not found.",
      solution:
        errorPatternInfo?.solution ||
        "Check the screenshots to see the actual UI state. The element may not have appeared due to a backend error or timing issue.",
    });
  }

  // Sort by timestamp
  issues.sort((a, b) => a.timestamp - b.timestamp);

  // Deduplicate issues (same category + similar text within 1 second)
  const uniqueIssues = issues.reduce<DiagnosticIssue[]>((acc, issue) => {
    const isDuplicate = acc.some(
      (existing) =>
        existing.category === issue.category &&
        Math.abs(existing.timestamp - issue.timestamp) < 1000,
    );

    return isDuplicate ? acc : [...acc, issue];
  }, []);

  // Separate recovered issues from non-recovered issues
  const recoveredIssues = uniqueIssues.filter((issue) => issue.recovered);
  const nonRecoveredIssues = uniqueIssues.filter((issue) => !issue.recovered);
  const activeIssues = verbose ? uniqueIssues : nonRecoveredIssues;

  // Group by category for summary
  const byCategory: Record<string, number> = {};

  nonRecoveredIssues.forEach((issue) => {
    byCategory[issue.category] = (byCategory[issue.category] || 0) + 1;
  });

  // Determine severity
  const hasCritical =
    byCategory["Test Assertion Failed"] || byCategory["HTTP 5xx Error"];

  // Build primary recommendation based on most critical active issue
  const { primaryRecommendation, primaryExplanation } = (() => {
    if (activeIssues.length === 0) {
      const recoveryNote =
        recoveredIssues.length > 0
          ? ` (${recoveredIssues.length} recovered issue(s) hidden, use --verbose to see)`
          : "";

      return {
        primaryRecommendation: `Trace looks clean.${recoveryNote} If test still fails, check server logs.`,
        primaryExplanation:
          "No known error patterns were detected in the trace.",
      };
    }

    const criticalIssue = activeIssues.find(
      (i) =>
        !i.recovered &&
        (i.category === "Test Assertion Failed" ||
          i.category === "HTTP 5xx Error"),
    );
    const primaryIssue = criticalIssue || activeIssues[0];

    return {
      primaryRecommendation: primaryIssue?.solution || "",
      primaryExplanation: primaryIssue?.explanation || "",
    };
  })();

  // Build summary message
  const recoveryNote =
    recoveredIssues.length > 0
      ? verbose
        ? ` (+${recoveredIssues.length} recovered)`
        : ` (${recoveredIssues.length} recovered issue(s) hidden)`
      : "";

  const summary =
    nonRecoveredIssues.length === 0
      ? `✅ No known error patterns detected${recoveryNote}`
      : hasCritical
        ? `🚨 CRITICAL ISSUES FOUND - ${nonRecoveredIssues.length} unique error(s) detected${recoveryNote}`
        : `⚠️  ${nonRecoveredIssues.length} potential issue(s) detected${recoveryNote}`;

  const results: DiagnoseResults = {
    summary,
    issueCount: nonRecoveredIssues.length,
    recoveredCount:
      recoveredIssues.length > 0 ? recoveredIssues.length : undefined,
    byCategory,
    primaryDiagnosis: {
      explanation: primaryExplanation,
      recommendation: primaryRecommendation,
    },
    issues: activeIssues.slice(0, 10).map((issue) => ({
      category: issue.category,
      timestamp: issue.timestamp,
      source: issue.source,
      explanation: issue.explanation,
      solution: issue.solution,
      snippet:
        issue.text.slice(0, 200) + (issue.text.length > 200 ? "..." : ""),
      recovered: issue.recovered,
    })),
  };

  return results;
}

// Command: diagnose (comprehensive error scan)
function commandDiagnose(
  ctx: TraceContext,
  options: Record<string, string | boolean | number>,
): void {
  const verbose = options.verbose === true;
  const results = getDiagnoseResults(ctx, { verbose });
  output("diagnose", ctx.tracePath, results);
}

// Command: diagnose-all (diagnose all traces in test-results)
function commandDiagnoseAll(
  options: Record<string, string | boolean | number>,
): void {
  if (!fs.existsSync(getTestResultsDir())) {
    console.log(JSON.stringify({ error: "No test-results directory found" }));

    return;
  }

  const verbose = options.verbose === true;
  const dirs = fs.readdirSync(getTestResultsDir());

  // Find all trace.zip files
  const traces = dirs
    .map((dir) => {
      const traceZip = path.join(getTestResultsDir(), dir, "trace.zip");

      return fs.existsSync(traceZip)
        ? { testName: dir, tracePath: traceZip }
        : null;
    })
    .filter(
      (trace): trace is { testName: string; tracePath: string } =>
        trace !== null,
    );

  if (traces.length === 0) {
    console.log(
      JSON.stringify({ error: "No trace.zip files found in test-results/" }),
    );

    return;
  }

  console.log(`\n🔍 Analyzing ${traces.length} trace(s)...\n`);

  // Diagnose each trace and count skipped
  const skippedCount = traces.reduce((count, { testName, tracePath }) => {
    try {
      const traceDir = getTraceDir(tracePath);
      const ctx = parseTrace(traceDir);
      const results = getDiagnoseResults(ctx, { verbose });

      // Skip traces with no issues unless --verbose flag is set
      if (!verbose && results.issueCount === 0) {
        return count + 1;
      }

      console.log(`\n━━━ ${testName} ━━━`);
      output("diagnose", ctx.tracePath, results);

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
      `\n✅ ${skippedCount} trace(s) with no issues (use --verbose to show)`,
    );
  }
}

/**
 * Run a trace command with the given options.
 * Exported for use with Commander.js integration.
 */
export async function runTraceCommand(
  command: string,
  tracePath: string | undefined,
  options: Record<string, string | boolean | number>,
): Promise<void> {
  try {
    // Handle diagnose-all specially (it finds its own traces)
    if (command === "diagnose-all") {
      commandDiagnoseAll(options);

      return;
    }

    // Get trace directory (interactive if no path provided)
    const { traceDir } = await getTraceDirAsync(tracePath);

    // Parse trace
    const ctx = parseTrace(traceDir);

    // Execute command
    switch (command) {
      case "summary":
        commandSummary(ctx);

        break;
      case "errors":
        commandErrors(ctx);

        break;
      case "actions":
        commandActions(ctx);

        break;
      case "screenshots":
        commandScreenshots(ctx);

        break;
      case "screenshot":
        commandScreenshot(ctx, options);

        break;
      case "console":
        commandConsole(ctx, options);

        break;
      case "around":
        commandAround(ctx, options);

        break;
      case "timeline":
        commandTimeline(ctx);

        break;
      case "diagnose":
        commandDiagnose(ctx, options);

        break;
      default:
        console.error(`Unknown command: ${command}`);
        console.error(
          "Available commands: summary, errors, actions, screenshots, screenshot, console, around, timeline, diagnose, diagnose-all",
        );
        process.exit(1);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ error: message }));
    process.exit(1);
  }
}
