import * as fs from 'fs';
import * as path from 'path';

import {
  bannerLine,
  expiresOn,
  renewalState,
  today,
} from '../setup/tokenExpiry';

/**
 * From 21 days before the Claude sign-in runs out, the Mac app posts one
 * macOS notification a calendar day. The last day it posted is kept in the
 * app's `state.json`, so a restart the same day doesn't post it again.
 */

export const REMINDER_TITLE = 'Reconnect Claude';

interface AppState {
  lastRenewalReminder?: string;
}

const readState = (file: string): AppState => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));

    return typeof parsed === 'object' &&
      parsed !== null &&
      'lastRenewalReminder' in parsed &&
      typeof parsed.lastRenewalReminder === 'string'
      ? { lastRenewalReminder: parsed.lastRenewalReminder }
      : {};
  } catch {
    return {};
  }
};

const writeState = (file: string, state: AppState): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
};

/** Post today's reminder if it's due; answers whether it posted. */
export const maybeRemind = (options: {
  now: number;
  /** `tokens.claude.createdAt`; nothing to remind of without one. */
  createdAt: string | undefined;
  stateFile: string;
  notify: (title: string, body: string) => void;
  /** The clock's time zone (an IANA name, for tests); default: here. */
  zone?: string;
}): boolean => {
  if (options.createdAt === undefined) {
    return false;
  }

  const expires = expiresOn(options.createdAt);
  const day = today(options.now, options.zone);
  const line = bannerLine(expires, options.now, options.zone);
  const renewal = renewalState(expires, options.now);

  if (renewal === 'fine' || line === null) {
    return false;
  }

  const state = readState(options.stateFile);

  if (state.lastRenewalReminder === day) {
    return false;
  }

  // Once it has run out, agents have already stopped: the date says it all.
  options.notify(
    REMINDER_TITLE,
    renewal === 'soon' ? `${line} Agents stop working after that.` : line
  );
  writeState(options.stateFile, { ...state, lastRenewalReminder: day });

  return true;
};

/**
 * The app's hourly reminder: a config it can't read (half-written while
 * setup saves it) is logged and tried again next hour, never an uncaught
 * exception in the main process.
 */
export const remindSafely = (options: {
  now: number;
  readCreatedAt: () => string | undefined;
  stateFile: string;
  notify: (title: string, body: string) => void;
  log: (line: string) => void;
}): void => {
  try {
    maybeRemind({
      now: options.now,
      createdAt: options.readCreatedAt(),
      stateFile: options.stateFile,
      notify: options.notify,
    });
  } catch (error) {
    options.log(
      `Renewal reminder skipped: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
};
