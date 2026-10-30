/**
 * Types for Playwright trace file events, the JSONL lines found in trace files.
 * Each event the reader uses has a zod schema, so a line is parsed, not cast:
 * `TraceEventSchema` keeps the events it knows and drops the rest. Schemas pass
 * unknown fields through, since Playwright adds fields between versions.
 */
import { z } from 'zod';

const StackFrameSchema = z.object({
  file: z.string(),
  line: z.number(),
  column: z.number(),
  function: z.string().optional(),
});

// Context options (first line of trace)
export const ContextOptionsEventSchema = z
  .object({
    type: z.literal('context-options'),
    version: z.number().optional(),
    origin: z.string().optional(),
    browserName: z.string().optional(),
    platform: z.string().optional(),
    wallTime: z.number().optional(),
    monotonicTime: z.number().optional(),
    sdkLanguage: z.string().optional(),
    title: z.string().optional(), // Test title (in library origin)
    contextId: z.string().optional(),
    testIdAttributeName: z.string().optional(),
    options: z
      .object({
        viewport: z
          .object({ width: z.number(), height: z.number() })
          .optional(),
        baseURL: z.string().optional(),
        userAgent: z.string().optional(),
        isMobile: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

// Before event - action starting
export const BeforeEventSchema = z
  .object({
    type: z.literal('before'),
    callId: z.string(),
    startTime: z.number(),
    // Legacy Playwright traces carry a single `apiName` (e.g. "locator.click").
    // Newer traces drop it in favour of `class` + `method` (+ a human `title`).
    apiName: z.string().optional(),
    title: z.string().optional(),
    class: z.string(),
    method: z.string(),
    params: z.record(z.unknown()).default({}),
    stepId: z.string().optional(),
    pageId: z.string().optional(),
    parentId: z.string().optional(),
    beforeSnapshot: z.string().optional(),
    stack: z.array(StackFrameSchema).optional(),
  })
  .passthrough();

// After event - action completed
export const AfterEventSchema = z
  .object({
    type: z.literal('after'),
    callId: z.string(),
    endTime: z.number(),
    result: z.record(z.unknown()).optional(),
    error: z
      .object({ message: z.string(), stack: z.string().optional() })
      .passthrough()
      .optional(),
    afterSnapshot: z.string().optional(),
    annotations: z.array(z.unknown()).optional(),
  })
  .passthrough();

// Screenshot frame
export const ScreencastFrameEventSchema = z
  .object({
    type: z.literal('screencast-frame'),
    pageId: z.string(),
    sha1: z.string(), // Filename in resources/
    width: z.number(),
    height: z.number(),
    timestamp: z.number(), // Monotonic time
    frameSwapWallTime: z.number().optional(),
  })
  .passthrough();

// Console message
export const ConsoleEventSchema = z
  .object({
    type: z.literal('console'),
    /** log, info, warning, error, debug, and any other kind the browser sends. */
    messageType: z.string(),
    text: z.string(),
    args: z
      .array(z.object({ preview: z.string().optional(), value: z.unknown() }))
      .optional(),
    location: z
      .object({
        url: z.string(),
        lineNumber: z.number(),
        columnNumber: z.number(),
      })
      .optional(),
    time: z.number(),
    pageId: z.string().optional(),
  })
  .passthrough();

// Playwright log message
export const LogEventSchema = z
  .object({
    type: z.literal('log'),
    callId: z.string(),
    time: z.number(),
    message: z.string(),
  })
  .passthrough();

// Browser event (includes page errors)
export const BrowserEventSchema = z
  .object({
    type: z.literal('event'),
    time: z.number(),
    class: z.string(),
    method: z.string(), // 'pageError', 'page', etc.
    params: z
      .object({
        // Playwright serializes a thrown Error as `{ error: {…} }` and any
        // other thrown value (`throw 'boom'`) as `{ value }`.
        error: z
          .object({
            error: z
              .object({
                message: z.string(),
                stack: z.string().optional(),
                name: z.string().optional(),
              })
              .passthrough()
              .optional(),
            value: z.unknown().optional(),
          })
          .passthrough()
          .optional(),
        pageId: z.string().optional(),
      })
      .passthrough()
      .default({}),
    pageId: z.string().optional(),
  })
  .passthrough();

/** A page error's message: the Error's own, else the thrown value as text. */
export const pageErrorMessage = (event: BrowserEvent): string | undefined => {
  const thrown = event.params.error;

  if (thrown === undefined) {
    return undefined;
  }

  if (thrown.error !== undefined) {
    return thrown.error.message;
  }

  if (thrown.value === undefined) {
    return undefined;
  }

  return typeof thrown.value === 'string'
    ? thrown.value
    : JSON.stringify(thrown.value);
};

// Input event (click/type coordinates)
export const InputEventSchema = z
  .object({
    type: z.literal('input'),
    callId: z.string(),
    point: z.object({ x: z.number(), y: z.number() }).optional(),
    inputSnapshot: z.string().optional(),
  })
  .passthrough();

// Frame snapshot (DOM state); the reader never looks inside it.
export const FrameSnapshotEventSchema = z
  .object({
    type: z.literal('frame-snapshot'),
    snapshot: z.record(z.unknown()),
  })
  .passthrough();

// Stdout from test runner
export const StdoutEventSchema = z
  .object({
    type: z.literal('stdout'),
    timestamp: z.number(),
    text: z.string().default(''),
  })
  .passthrough();

// Stderr from test runner
export const StderrEventSchema = z
  .object({
    type: z.literal('stderr'),
    timestamp: z.number(),
    text: z.string().default(''),
  })
  .passthrough();

// Test error event (Playwright test failures, Node.js errors in test code)
export const TestErrorEventSchema = z
  .object({
    type: z.literal('error'),
    message: z.string().default(''),
    stack: z.array(StackFrameSchema).optional(),
  })
  .passthrough();

export const TraceEventSchema = z.discriminatedUnion('type', [
  ContextOptionsEventSchema,
  BeforeEventSchema,
  AfterEventSchema,
  ScreencastFrameEventSchema,
  ConsoleEventSchema,
  LogEventSchema,
  BrowserEventSchema,
  InputEventSchema,
  FrameSnapshotEventSchema,
  StdoutEventSchema,
  StderrEventSchema,
  TestErrorEventSchema,
]);

export type ContextOptionsEvent = z.infer<typeof ContextOptionsEventSchema>;
export type BeforeEvent = z.infer<typeof BeforeEventSchema>;
export type AfterEvent = z.infer<typeof AfterEventSchema>;
export type ScreencastFrameEvent = z.infer<typeof ScreencastFrameEventSchema>;
export type ConsoleEvent = z.infer<typeof ConsoleEventSchema>;
export type LogEvent = z.infer<typeof LogEventSchema>;
export type BrowserEvent = z.infer<typeof BrowserEventSchema>;
export type InputEvent = z.infer<typeof InputEventSchema>;
export type FrameSnapshotEvent = z.infer<typeof FrameSnapshotEventSchema>;
export type StdoutEvent = z.infer<typeof StdoutEventSchema>;
export type StderrEvent = z.infer<typeof StderrEventSchema>;
export type TestErrorEvent = z.infer<typeof TestErrorEventSchema>;
export type TraceEvent = z.infer<typeof TraceEventSchema>;

// Stack frame from stacks file
export interface StackFrame {
  file: string;
  line: number;
  column: number;
  function?: string;
}

// Stacks file structure
export interface StacksFile {
  files: string[];
  stacks: Array<[number, Array<[number, number, number, string]>]>;
}

// Network resource snapshot
export interface ResourceSnapshot {
  type: 'resource-snapshot';
  snapshot: {
    _frameref: string;
    _monotonicTime: number;
    startedDateTime: string;
    time: number;
    request: {
      method: string;
      url: string;
      httpVersion: string;
      headers: Array<{ name: string; value: string }>;
      queryString: Array<{ name: string; value: string }>;
      headersSize: number;
      bodySize: number;
    };
    response: {
      status: number;
      statusText: string;
      httpVersion: string;
      headers: Array<{ name: string; value: string }>;
      content: {
        size: number;
        mimeType: string;
        _sha1?: string;
      };
      headersSize: number;
      bodySize: number;
    };
    timings: {
      dns: number;
      connect: number;
      ssl: number;
      send: number;
      wait: number;
      receive: number;
    };
    pageref: string;
  };
}

// Parsed trace context (our internal representation)
export interface TraceContext {
  tracePath: string;
  testName: string;
  duration?: number;
  status: 'passed' | 'failed' | 'unknown';
  errorTime?: number;
  errorMessage?: string;
  expectedValue?: string;
  receivedValue?: string;
  screenshots: ScreencastFrameEvent[];
  consoleMessages: ConsoleEvent[];
  errors: BrowserEvent[];
  // `apiName` is always populated (from the trace's title / class.method) when
  // building the actions list, so it narrows back to a required string here.
  actions: Array<
    BeforeEvent & { apiName: string; endTime?: number; error?: string }
  >;
  logs: LogEvent[];
}

// Command output format
export interface TraceCommandOutput<T = unknown> {
  command: string;
  tracePath: string;
  results: T;
  error?: string;
}

// Screenshot result with context
export interface ScreenshotResult {
  target: string;
  targetIndex: number;
  timestamp: number;
  action?: string;
  before: Array<{ index: number; path: string; timestamp: number }>;
  after: Array<{ index: number; path: string; timestamp: number }>;
}

// Error result with context
export interface ErrorResult {
  timestamp: number;
  message: string;
  stack?: string;
  screenshots: {
    before: Array<{ index: number; path: string; timestamp: number }>;
    target: { index: number; path: string; timestamp: number } | null;
    after: Array<{ index: number; path: string; timestamp: number }>;
  };
  consoleContext: ConsoleEvent[];
}

// Action result for timeline/actions command
export interface ActionResult {
  timestamp: number;
  endTime?: number;
  duration?: number;
  apiName: string;
  selector?: string;
  url?: string;
  value?: string;
  error?: string;
}

// Console filter options
export interface ConsoleFilterOptions {
  type?: 'log' | 'info' | 'warning' | 'error' | 'debug';
  filter?: string; // Regex pattern
  limit?: number;
}
