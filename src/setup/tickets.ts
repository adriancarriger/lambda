import * as fs from 'fs';
import * as path from 'path';

import { type MachineConfig } from '../config/machineConfig';
import { PROJECT_CONFIG_FILE, type TicketState } from '../config/projectConfig';
import { HttpError } from '../mothership/relay';
import { LINEAR_API_URL } from '../tickets/linear';
import { markProject, updateMachineConfig } from './firstRun';

/**
 * The Tickets step (and `lambda connect linear|jira`): where a project's
 * tickets live, and the key for it. A key is checked with one read before
 * anything is saved, and goes only into `~/.lambda/config.json`.
 */

type Env = Record<string, string | undefined>;

export type TicketsChoice =
  | { source: 'markdown' }
  | { source: 'linear'; apiKey: string }
  | { source: 'jira'; site: string; email: string; apiToken: string };

/** Whose key it is, as the tracker says: its name, and its email when shown. */
export interface TrackerLogin {
  name: string;
  email: string | null;
}

export type KeyCheck =
  | ({ ok: true } & TrackerLogin)
  | { ok: false; error: string };

export const KEY_DIDNT_WORK = "That key didn't work";

export const CHECK_TIMEOUT_MS = 10_000;

export const JIRA_SITE_HTTPS = 'The Jira site must be an https:// address.';

/**
 * The status names a project gets when setup first points it at Linear or
 * Jira. A tracker that names them differently says so on first use, with
 * its own list, and lambda.json is edited to match.
 */
export const DEFAULT_STATUSES: Record<
  'linear' | 'jira',
  // No Inbox by default: it reads and writes as Planning until named.
  Record<Exclude<TicketState, 'inbox'>, string>
> = {
  linear: {
    planning: 'Backlog',
    ready: 'Todo',
    building: 'In Progress',
    blocked: 'Blocked',
    done: 'Done',
    canceled: 'Canceled',
  },
  jira: {
    planning: 'Backlog',
    ready: 'To Do',
    building: 'In Progress',
    blocked: 'Blocked',
    done: 'Done',
    canceled: 'Canceled',
  },
};

const isHttps = (site: string): boolean => {
  try {
    return new URL(site).protocol === 'https:';
  } catch {
    return false;
  }
};

const serviceName = (source: 'linear' | 'jira'): string =>
  source === 'linear' ? 'Linear' : 'Jira';

/** Why a request never got an answer: ECONNREFUSED, timed out, … */
const failureCode = (error: unknown): string => {
  // By name, not `instanceof Error`: the timeout is a DOMException.
  const name =
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    typeof error.name === 'string'
      ? error.name
      : 'request failed';

  if (name === 'TimeoutError' || name === 'AbortError') {
    return 'timed out';
  }

  const cause =
    typeof error === 'object' && error !== null && 'cause' in error
      ? error.cause
      : undefined;
  const code = [cause, error].find(
    (one) => typeof one === 'object' && one !== null && 'code' in one
  );

  if (typeof code === 'object' && code !== null && 'code' in code) {
    return String(code.code);
  }

  // Never the message: fetch builds it from the request, key included (an
  // invalid header value is quoted whole).
  return name;
};

const unreachable = (source: 'linear' | 'jira', why: string): KeyCheck => ({
  ok: false,
  error: `Couldn't reach ${serviceName(source)} (${why})`,
});

const nameFrom = (body: unknown, keys: string[]): string | null => {
  const found = keys.reduce<unknown>(
    (value, key) =>
      typeof value === 'object' && value !== null && key in value
        ? Reflect.get(value, key)
        : undefined,
    body
  );

  return typeof found === 'string' && found !== '' ? found : null;
};

/** A GraphQL answer refusing the key (Linear answers 400 for that). */
const isAuthError = (body: unknown): boolean =>
  typeof body === 'object' &&
  body !== null &&
  'errors' in body &&
  Array.isArray(body.errors) &&
  body.errors.some(
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      'extensions' in error &&
      typeof error.extensions === 'object' &&
      error.extensions !== null &&
      'code' in error.extensions &&
      error.extensions.code === 'AUTHENTICATION_ERROR'
  );

/** One read with the key: Linear's `viewer`, Jira's `myself`, name and email. */
export const checkTicketsKey = async (
  choice: Exclude<TicketsChoice, { source: 'markdown' }>,
  doFetch: typeof fetch = globalThis.fetch
): Promise<KeyCheck> => {
  if (choice.source === 'jira' && !isHttps(choice.site)) {
    return { ok: false, error: JIRA_SITE_HTTPS };
  }

  const request: {
    url: string;
    init: RequestInit;
    name: string[];
    email: string[];
  } =
    choice.source === 'linear'
      ? {
          url: LINEAR_API_URL,
          init: {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: choice.apiKey,
            },
            body: JSON.stringify({ query: '{ viewer { name email } }' }),
          },
          name: ['data', 'viewer', 'name'],
          email: ['data', 'viewer', 'email'],
        }
      : {
          url: `${choice.site.replace(/\/+$/, '')}/rest/api/3/myself`,
          init: {
            method: 'GET',
            headers: {
              accept: 'application/json',
              authorization: `Basic ${Buffer.from(
                `${choice.email}:${choice.apiToken}`
              ).toString('base64')}`,
            },
          },
          name: ['displayName'],
          email: ['emailAddress'],
        };

  const response = await doFetch(request.url, {
    ...request.init,
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  }).catch((error: unknown) => failureCode(error));

  if (typeof response === 'string') {
    return unreachable(choice.source, response);
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, error: KEY_DIDNT_WORK };
  }

  const body: unknown = await response.json().catch(() => null);

  if (isAuthError(body)) {
    return { ok: false, error: KEY_DIDNT_WORK };
  }

  if (!response.ok) {
    return unreachable(choice.source, String(response.status));
  }

  const name = nameFrom(body, request.name);

  return name === null
    ? unreachable(choice.source, 'an answer without a name')
    : { ok: true, name, email: nameFrom(body, request.email) };
};

const readJson = (file: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} isn't a JSON object.`);
  }

  return Object.fromEntries(Object.entries(parsed));
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};

/** Used when a project's name has no letters or digits to make one from. */
export const FALLBACK_PREFIX = 'TICKET';

/**
 * Markdown ticket ids' prefix, from the project's name: its first word in
 * capitals (`pawnee-parks-app` → `PAWNEE-1`). Without one, planning can't
 * create a ticket at all.
 */
export const prefixFromName = (name: string): string =>
  (name.split(/[^A-Za-z0-9]+/).find((word) => word !== '') ?? '')
    .toUpperCase()
    .slice(0, 12) || FALLBACK_PREFIX;

/**
 * Point lambda.json at the chosen source. When it already names that source
 * (and, for Jira, that site; for markdown, a prefix) the file is left
 * byte-for-byte as it is: a checked-in lambda.json must not show up as a
 * change for the next commit to carry. Answers whether it was written.
 */
export const writeTicketSource = (
  root: string,
  choice: TicketsChoice
): boolean => {
  const file = path.join(root, PROJECT_CONFIG_FILE);
  const config = readJson(file);
  const tickets = record(config.tickets);
  const same =
    tickets.source === choice.source &&
    (choice.source !== 'jira' || tickets.site === choice.site) &&
    (choice.source !== 'markdown' || typeof tickets.prefix === 'string');

  if (same) {
    return false;
  }

  const next = {
    ...tickets,
    source: choice.source,
    ...(choice.source === 'jira' ? { site: choice.site } : {}),
    ...(choice.source === 'markdown'
      ? {
          prefix:
            typeof tickets.prefix === 'string'
              ? tickets.prefix
              : prefixFromName(
                  typeof config.name === 'string'
                    ? config.name
                    : path.basename(root)
                ),
        }
      : { statuses: tickets.statuses ?? DEFAULT_STATUSES[choice.source] }),
  };
  fs.writeFileSync(
    file,
    `${JSON.stringify({ ...config, tickets: next }, null, 2)}\n`
  );

  return true;
};

const withKey = (
  config: MachineConfig,
  choice: TicketsChoice
): MachineConfig => {
  switch (choice.source) {
    case 'markdown':
      return config;
    case 'linear':
      return { ...config, tokens: { ...config.tokens, linear: choice.apiKey } };
    case 'jira':
      return {
        ...config,
        tokens: {
          ...config.tokens,
          jira: { email: choice.email, apiToken: choice.apiToken },
        },
      };
  }
};

export type TicketsOutcome =
  | {
      ok: true;
      connectedAs: string | null;
      /** The key's own login: null for markdown, which has no key. */
      login: TrackerLogin | null;
    }
  | { ok: false; error: string };

/**
 * Check the key, then save: lambda.json's source, the key in the machine
 * file, and the project's Tickets step done. Nothing is saved on a failed
 * check.
 */
export const connectTickets = async (
  root: string,
  choice: TicketsChoice,
  options: { env?: Env; fetch?: typeof fetch; markStep?: boolean } = {}
): Promise<TicketsOutcome> => {
  const env = options.env ?? process.env;

  if (!fs.existsSync(path.join(root, PROJECT_CONFIG_FILE))) {
    throw new HttpError(409, 'Pick a codebase first.');
  }

  const check =
    choice.source === 'markdown'
      ? null
      : await checkTicketsKey(choice, options.fetch);

  if (check !== null && !check.ok) {
    return check;
  }

  writeTicketSource(root, choice);
  updateMachineConfig((config) => withKey(config, choice), env);

  if (options.markStep !== false) {
    markProject(root, { tickets: true }, env);
  }

  return check === null
    ? { ok: true, connectedAs: null, login: null }
    : {
        ok: true,
        connectedAs: check.name,
        login: { name: check.name, email: check.email },
      };
};
