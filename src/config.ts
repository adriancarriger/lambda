/**
 * Lambda CLI configuration constants.
 *
 * Centralized config so all commands use the same session name,
 * agent pane list, and environment variable names.
 */

/** Tmux session name for the lambda environment */
export const SESSION_NAME = "lambda";

/** Panes that are Claude Code agent windows requiring mode switching */
export const AGENT_PANES = ["john", "sam", "james"];

/** Directory for wait/send receipts (peek-then-block system) */
export const RECEIPT_DIR = "/tmp/lambda-wait-receipts";

/** Environment variable set on each agent window to identify itself */
export const WINDOW_ENV_VAR = "LAMBDA_WINDOW";

/**
 * When true, `lambda ship` defaults to dry-run (prints what would happen).
 * Set to false or pass --no-dry-run for real git operations.
 */
export const DEMO_MODE = true;
