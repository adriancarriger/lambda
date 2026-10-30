/**
 * The runner socket: JSON messages with a `type`, one outgoing WebSocket per
 * runner (`/api/runner/socket`). Either side logs and ignores a type it
 * doesn't know, rather than closing the socket, so the set can grow.
 *
 * Handshake: the mothership sends `challenge` (32 random bytes, base64); the
 * runner answers `auth` with its id and an Ed25519 signature of them.
 *
 * Every mothership request carries an `id`, echoed by the runner's `result`.
 * The runner's own writes (`project-link`, `leave`, and the outbox's
 * `pod-state` and `event`) carry an `id` too, and the mothership answers each
 * with a `result` of that id: that's how the outbox learns what arrived.
 */

export const HANDSHAKE_TYPES = ['challenge', 'auth'] as const;

/** What the mothership sends after the handshake. */
export const MOTHERSHIP_TYPES = [
  'pod-new',
  'pod-action',
  'term-read',
  'term-keys',
  'process-read',
  'process-switch',
  // Settings → Design system: the page, read from the default branch on the
  // runner holding the project, and Make it (the setup ticket).
  'design-system-read',
  'design-system-make',
  'project-add',
  'project-new',
  'owner',
  // A file from a pod's folder on its runner: `{ podId, folder, path }`,
  // answered by `result` ({ base64, headers } or null). See POD_FILE_FOLDERS.
  'pod-file',
  // The Tickets screen and building pods: the runner holding the
  // project answers from its ticket source, so tracker keys never leave it.
  'tickets-list',
  // Settings-free: the codebase's tracker projects, `{ folder }`.
  'tracker-projects',
  // Import from Linear: the tracker's views and its key's favorites.
  'tracker-views',
  'ticket-get',
  'ticket-talk',
  'building-start',
  // The Tickets screen's own edits: a change, a new ticket, a move in order.
  'ticket-update',
  'ticket-create',
  'ticket-move',
  // "Plan more" on a Lambda past planning: reopen its planning pod.
  'plan-more',
  // `lambda computer <name> <action>`: a fixed read about the computer
  // itself (status, pod, log, git), never a command line. See diagnose.ts.
  'diagnose',
] as const;

/**
 * The folders of a pod a runner serves through `pod-file`. Anything else is
 * refused by the runner.
 */
export const POD_FILE_FOLDERS = [
  'screenshots',
  'designs',
  'shots',
  'prototype',
  // The visual check's rounds: `visual/<ticket>/<round>/`.
  'visual',
] as const;

export type PodFileFolder = (typeof POD_FILE_FOLDERS)[number];

/** What a runner sends after the handshake. */
export const RUNNER_TYPES = [
  'result',
  'pod-state',
  'event',
  'runner-state',
  'project-link',
  'leave',
  // Ticket claims. `ticket-claim` and `ticket-claims` wait for a
  // `result`; `ticket-release` and `ticket-shipped` are outbox items.
  'ticket-claim',
  'ticket-claims',
  'ticket-release',
  'ticket-shipped',
  // Who this computer is in each tracker it has a key for, sent on every
  // connect: `{ identities: [{ tracker, who, name }] }` (an outbox item).
  'tracker-identity',
] as const;

export type MothershipType = (typeof MOTHERSHIP_TYPES)[number];
export type RunnerType = (typeof RUNNER_TYPES)[number];

export interface Message {
  type: string;
  id?: string;
  [key: string]: unknown;
}

export interface ResultMessage extends Message {
  type: 'result';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** The parsed message, or `null` for anything without a string `type`. */
const isMessage = (value: unknown): value is Message =>
  typeof value === 'object' &&
  value !== null &&
  'type' in value &&
  typeof value.type === 'string';

export const parseMessage = (raw: string): Message | null => {
  try {
    const parsed: unknown = JSON.parse(raw);

    return isMessage(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export const isResult = (
  message: Message
): message is Message & ResultMessage =>
  message.type === 'result' &&
  typeof message.id === 'string' &&
  typeof message.ok === 'boolean';

export const resultOf = (
  id: string,
  outcome: { ok: true; result?: unknown } | { ok: false; error: string }
): ResultMessage => ({ type: 'result', id, ...outcome });

/** The data a challenge signs: the mothership's 32 bytes. */
export const CHALLENGE_BYTES = 32;

/** A request with no `result` within this long answers 504. */
export const REQUEST_TIMEOUT_MS = 60_000;
