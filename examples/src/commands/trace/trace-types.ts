/**
 * TypeScript types for Playwright trace file events.
 * These types represent the JSONL events found in trace files.
 */

// Base event with discriminator
export type TraceEvent =
  | ContextOptionsEvent
  | BeforeEvent
  | AfterEvent
  | ScreencastFrameEvent
  | ConsoleEvent
  | LogEvent
  | BrowserEvent
  | InputEvent
  | FrameSnapshotEvent
  | StdoutEvent
  | StderrEvent
  | TestErrorEvent;

// Context options (first line of trace)
export interface ContextOptionsEvent {
  type: "context-options";
  version: number;
  origin: "testRunner" | "library";
  browserName: string;
  platform: string;
  wallTime: number;
  monotonicTime: number;
  sdkLanguage: string;
  title?: string;
  contextId?: string;
  testIdAttributeName?: string;
  options?: {
    viewport?: { width: number; height: number };
    baseURL?: string;
    userAgent?: string;
    isMobile?: boolean;
    [key: string]: unknown;
  };
}

// Before event - action starting
export interface BeforeEvent {
  type: "before";
  callId: string;
  startTime: number;
  apiName: string;
  class: string;
  method: string;
  params: Record<string, unknown>;
  stepId?: string;
  pageId?: string;
  parentId?: string;
  beforeSnapshot?: string;
  stack?: StackFrame[];
}

// After event - action completed
export interface AfterEvent {
  type: "after";
  callId: string;
  endTime: number;
  result?: Record<string, unknown>;
  error?: { message: string; stack?: string };
  afterSnapshot?: string;
  annotations?: unknown[];
}

// Screenshot frame
export interface ScreencastFrameEvent {
  type: "screencast-frame";
  pageId: string;
  sha1: string;
  width: number;
  height: number;
  timestamp: number;
  frameSwapWallTime: number;
}

// Console message
export interface ConsoleEvent {
  type: "console";
  messageType: "log" | "info" | "warning" | "error" | "debug";
  text: string;
  args?: Array<{ preview?: string; value: unknown }>;
  location?: {
    url: string;
    lineNumber: number;
    columnNumber: number;
  };
  time: number;
  pageId: string;
}

// Playwright log message
export interface LogEvent {
  type: "log";
  callId: string;
  time: number;
  message: string;
}

// Browser event (includes page errors)
export interface BrowserEvent {
  type: "event";
  time: number;
  class: string;
  method: string;
  params: {
    error?: {
      error: {
        message: string;
        stack?: string;
        name?: string;
      };
    };
    pageId?: string;
    [key: string]: unknown;
  };
  pageId?: string;
}

// Input event (click/type coordinates)
export interface InputEvent {
  type: "input";
  callId: string;
  point?: { x: number; y: number };
  inputSnapshot?: string;
}

// Frame snapshot (DOM state)
export interface FrameSnapshotEvent {
  type: "frame-snapshot";
  snapshot: {
    callId: string;
    snapshotName: string;
    pageId: string;
    frameId: string;
    frameUrl: string;
    html: unknown;
    viewport: { width: number; height: number };
    timestamp: number;
    wallTime: number;
    collectionTime: number;
    resourceOverrides: unknown[];
    isMainFrame: boolean;
  };
}

// Stdout from test runner
export interface StdoutEvent {
  type: "stdout";
  timestamp: number;
  text: string;
}

// Stderr from test runner
export interface StderrEvent {
  type: "stderr";
  timestamp: number;
  text: string;
}

// Test error event
export interface TestErrorEvent {
  type: "error";
  message: string;
  stack?: Array<{
    file: string;
    line: number;
    column: number;
    function?: string;
  }>;
}

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

// Parsed trace context (our internal representation)
export interface TraceContext {
  tracePath: string;
  testName: string;
  duration?: number;
  status: "passed" | "failed" | "unknown";
  errorTime?: number;
  errorMessage?: string;
  expectedValue?: string;
  receivedValue?: string;
  screenshots: ScreencastFrameEvent[];
  consoleMessages: ConsoleEvent[];
  errors: BrowserEvent[];
  actions: Array<BeforeEvent & { endTime?: number; error?: string }>;
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
  type?: "log" | "info" | "warning" | "error" | "debug";
  filter?: string;
  limit?: number;
}
