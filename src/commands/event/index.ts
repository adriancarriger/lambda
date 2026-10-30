import { type Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';

import {
  PROJECT_CONFIG_FILE,
  loadProjectConfig,
  resolvePodsRoot,
} from '../../config/projectConfig';
import type { EventLine } from '../../events/schema';
import { EVENTS_FILE, currentTicketRun } from '../../events/watcher';
import { createPodStore } from '../../pod-store';

/**
 * `lambda event <type> …`: one line appended to `.lambda/events.jsonl` in
 * the nearest folder going up that holds lambda.json — a pod's worktree
 * inside a pod, the project root otherwise. That's the whole of it: the
 * runner reads the file and sends the line once it's connected, so writing
 * the line by hand is the same event.
 */

/** The nearest folder at or above `cwd` holding lambda.json (no worktree mapping). */
export const nearestProjectFolder = (cwd: string): string | null => {
  const here = path.resolve(cwd);

  if (fs.existsSync(path.join(here, PROJECT_CONFIG_FILE))) {
    return here;
  }

  const parent = path.dirname(here);

  return parent === here ? null : nearestProjectFolder(parent);
};

export const NO_PROJECT = `There's no ${PROJECT_CONFIG_FILE} here or in any folder above, so there's no project to record the event in.`;

export interface EventOptions {
  name?: string;
  result?: string;
  note?: string;
  value?: string;
  unit?: string;
  ticket?: string;
  attempt?: string;
  /** `group.*`: the shipping-together group. */
  group?: string;
  reason?: string;
  held?: boolean;
  /**
   * When it happened (ISO), for a tool that reports a stage after it ended:
   * its start and end keep their own times. Never in the future.
   */
  at?: string;
}

/** An ISO 8601 time with its zone: `2026-10-24T14:02:00.000Z`, or `+02:00`. */
const ISO_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** `--at`, checked: an ISO time no later than now; else now. */
const eventTime = (at: string | undefined, now: string): string => {
  if (at === undefined) {
    return now;
  }

  // Only ISO: `Date.parse` also reads "Oct 24" or "10/24/2026", in local time.
  const time = ISO_TIME.test(at) ? Date.parse(at) : Number.NaN;

  if (!Number.isFinite(time)) {
    throw new Error('--at is an ISO time, e.g. 2026-10-24T14:02:00.000Z.');
  }

  if (time > Date.parse(now)) {
    throw new Error('--at is in the future.');
  }

  return new Date(time).toISOString();
};

export const eventLine = (
  type: string,
  options: EventOptions,
  extra: { at: string; pod?: string }
): EventLine & { pod?: string } => {
  if (type.startsWith('group.') && (options.group ?? '').trim() === '') {
    throw new Error(`${type} needs --group <id>: the group it is about.`);
  }

  if (
    options.result !== undefined &&
    options.result !== 'pass' &&
    options.result !== 'fail'
  ) {
    throw new Error('--result is pass or fail.');
  }

  const value = options.value === undefined ? undefined : Number(options.value);

  if (value !== undefined && !Number.isFinite(value)) {
    throw new Error('--value is a number.');
  }

  const attempt =
    options.attempt === undefined ? undefined : Number(options.attempt);

  if (attempt !== undefined && (!Number.isInteger(attempt) || attempt < 1)) {
    throw new Error('--attempt is a whole number from 1.');
  }

  return {
    type,
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.result === undefined ? {} : { result: options.result }),
    ...(options.note === undefined ? {} : { note: options.note }),
    ...(value === undefined ? {} : { value }),
    ...(options.unit === undefined ? {} : { unit: options.unit }),
    ...(options.ticket === undefined ? {} : { ticket: options.ticket }),
    ...(attempt === undefined ? {} : { attempt }),
    ...(options.group === undefined ? {} : { groupId: options.group.trim() }),
    ...(options.reason === undefined ? {} : { reason: options.reason }),
    ...(options.held === undefined ? {} : { held: options.held }),
    ...(extra.pod === undefined ? {} : { pod: extra.pod }),
    at: extra.at,
  };
};

/**
 * Inside a pod, the ticket and attempt it's on, unless given: resolved now,
 * as the line is written. Left to the runner, they'd be whatever the pod is
 * on when it reads the line, and a stage's start and end could disagree.
 */
const withPodRun = (
  cwd: string,
  pod: string,
  options: EventOptions,
  env: Record<string, string | undefined>
): EventOptions => {
  const project = loadProjectConfig(cwd);

  if (project === null) {
    return options;
  }

  const run = currentTicketRun(
    createPodStore(resolvePodsRoot(project, env)),
    pod
  );
  const ticket = options.ticket ?? run.ticket;
  // The run's attempt belongs to the run's ticket only.
  const attempt =
    options.attempt ??
    (run.attempt !== undefined && ticket === run.ticket
      ? String(run.attempt)
      : undefined);

  return { ...options, ticket, attempt };
};

/** Append the event; answers the file it went to. */
export const recordEvent = (
  cwd: string,
  type: string,
  options: EventOptions,
  env: Record<string, string | undefined> = process.env,
  now: () => string = () => new Date().toISOString()
): string => {
  const folder = nearestProjectFolder(cwd);

  if (folder === null) {
    throw new Error(NO_PROJECT);
  }

  const pod =
    env.POD_ID === undefined || env.POD_ID === '' ? undefined : env.POD_ID;
  // A group is about its tickets, never the one the pod happens to be on.
  const line = eventLine(
    type,
    pod === undefined || type.startsWith('group.')
      ? options
      : withPodRun(cwd, pod, options, env),
    { at: eventTime(options.at, now()), pod }
  );
  const file = path.join(folder, EVENTS_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(line)}\n`);

  return file;
};

export const registerEventCommand = (program: Command): void => {
  program
    .command('event <type>')
    .description('Record an event for the Analytics page (sent when connected)')
    .option('--name <name>', 'What it is about: a stage, a ship, a metric')
    .option('--result <result>', 'pass or fail')
    .option('--note <note>', 'A short note')
    .option('--value <number>', "A metric's value")
    .option('--unit <unit>', "The value's unit, e.g. KB")
    .option('--ticket <id>', 'The ticket it is about')
    .option('--attempt <n>', 'Which attempt at the ticket')
    .option(
      '--group <id>',
      'group.* events: the shipping-together group it is about'
    )
    .option('--reason <text>', 'group.reason: why the group is held')
    .option('--held', 'group.hold: the group is held')
    .option('--at <time>', 'When it happened (ISO), if not now')
    .action((type: string, options: EventOptions) => {
      // A passing ship.end marks the ticket shipped: lambda ship records it
      // itself, behind its verdict gate.
      if (type.startsWith('ship.')) {
        throw new Error(
          `Only lambda ship records ${type}, behind its verdict gate.`
        );
      }
      recordEvent(process.cwd(), type, options);
      console.log('✓ Event recorded (sent when connected)');
    });
};
