import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
  type TicketSummary,
  TicketSummarySchema,
  writeJsonAtomic,
} from '../../pod-store';
import { oneShotLaunch } from '../../pod/launch';
import { assertTicketId } from '../../tickets/source';
import type { SummaryState } from '../shared/building';

/**
 * The Tickets screen's plain summary of a ticket (Today / After). A ticket a
 * pod planned uses its checkpoint's name, today and after. Any other is
 * written once by a one-shot, non-interactive Product manager run on the
 * runner holding the project (read-only, by its settings) and stored under
 * `<pods root>/_summaries/<project>/<ticket>.json` (the project as a hash of
 * its folder), keyed by the SHA-256 of the description it was written from:
 * a changed description is written again.
 */

export const SUMMARY_TIMEOUT_MS = 2 * 60_000;

/** How much of a failed run's stderr its log line keeps: the end says why. */
export const STDERR_TAIL_CHARS = 400;

const tailOf = (text: string): string =>
  text.trim().slice(-STDERR_TAIL_CHARS).trim();

export interface SummaryTicket {
  id: string;
  title: string;
  description: string;
}

export interface PlannedSummary {
  name: string;
  today: string;
  after: string;
  podId: string;
}

/** One run: its exit code and what it printed. Abort it on `signal`. */
export type SummaryRun = (
  ticket: SummaryTicket,
  signal: AbortSignal
) => Promise<{ exitCode: number; stdout: string; stderr?: string }>;

const sha256 = (text: string): string =>
  crypto.createHash('sha256').update(text).digest('hex');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/** `text` as a JSON object, or null. */
const objectOf = (text: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(text);

    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/** Only the end of what a run printed is read: its answer is its last line. */
const ANSWER_TAIL_CHARS = 64 * 1024;

/**
 * The top-level JSON objects in `text`, in one pass: a `{` outside any object
 * opens a span, braces inside a string value don't count, and a balanced span
 * is kept when it parses (skipped whole when it doesn't). Linear, so a run
 * that echoes a brace-heavy description can't stall the runner.
 */
const objectsIn = (text: string): Record<string, unknown>[] => {
  const scan = { start: -1, depth: 0, inString: false, escaped: false };
  const found: Record<string, unknown>[] = [];

  Array.from(text).forEach((char, index) => {
    if (scan.inString) {
      const wasEscaped = scan.escaped;
      scan.escaped = !wasEscaped && char === '\\';
      scan.inString = wasEscaped || char !== '"';

      return;
    }

    if (char === '"' && scan.depth > 0) {
      scan.inString = true;
    } else if (char === '{') {
      scan.start = scan.depth === 0 ? index : scan.start;
      scan.depth += 1;
    } else if (char === '}' && scan.depth > 0) {
      scan.depth -= 1;

      const object =
        scan.depth === 0 ? objectOf(text.slice(scan.start, index + 1)) : null;

      if (object !== null) {
        found.splice(found.length, 0, object);
      }
    }
  });

  return found;
};

/** The last line of `text` that is a JSON object on its own, or null. */
const lastObjectLine = (text: string): Record<string, unknown> | null =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{') && line.endsWith('}'))
    .map(objectOf)
    .filter((object): object is Record<string, unknown> => object !== null)
    .at(-1) ?? null;

/** The last JSON object in what the run printed, or null. */
export const answerIn = (
  stdout: string
): { name?: string; today: string; after: string } | null => {
  const tail = stdout.slice(-ANSWER_TAIL_CHARS);
  const found = lastObjectLine(tail) ?? objectsIn(tail).at(-1);
  const today = text(found?.today);
  const after = text(found?.after);

  if (today === null || after === null) {
    return null;
  }

  const name = text(found?.name);

  return name === null ? { today, after } : { name, today, after };
};

/** Where a ticket's summary comes from, before anything is run. */
export type SummarySource =
  | { kind: 'planned' | 'stored'; name: string; today: string; after: string }
  /** No checkpoint planned it, and nothing stored matches its description. */
  | { kind: 'needs-summary'; hash: string };

/**
 * A planned ticket uses its checkpoint's name, today and after. An unplanned
 * one uses what was stored for it while its description (by SHA-256) is the
 * one it was written from; otherwise it needs a summary written.
 */
export const summarySource = (
  ticket: SummaryTicket,
  planned: PlannedSummary | null,
  stored: TicketSummary | null
): SummarySource => {
  if (planned !== null) {
    return {
      kind: 'planned',
      name: planned.name,
      today: planned.today,
      after: planned.after,
    };
  }

  const hash = sha256(ticket.description);

  return stored !== null && stored.sourceHash === hash
    ? {
        kind: 'stored',
        name: stored.name,
        today: stored.today,
        after: stored.after,
      }
    : { kind: 'needs-summary', hash };
};

export const createTicketSummaries = (deps: {
  /** The pods root: summaries live in its `_summaries/`. */
  root: string;
  /**
   * The project's folder. A pods root can be shared by several projects,
   * each with its own ticket "3", so each project's summaries are kept apart.
   */
  project: string;
  run: SummaryRun;
  timeoutMs?: number;
  /** Why a summary couldn't be written: the screen only says "No summary yet." */
  log: (line: string) => void;
  /** For tests: how a summary is stored. */
  write?: (file: string, summary: TicketSummary) => void;
}) => {
  const writeSummary = deps.write ?? writeJsonAtomic;
  const timeoutMs = deps.timeoutMs ?? SUMMARY_TIMEOUT_MS;
  /** Ticket id → the description hash its run is writing from. */
  const running = new Map<string, string>();
  /** Ticket id → how to stop the run writing its summary. */
  const controllers = new Map<string, AbortController>();
  /**
   * Ticket id → the description hash its last run failed on: "No summary
   * yet." for that description only, so a changed one gets a fresh try.
   */
  const failed = new Map<string, string>();

  const projectDir = sha256(deps.project).slice(0, 16);

  const file = (ticketId: string): string =>
    path.join(
      deps.root,
      '_summaries',
      projectDir,
      `${assertTicketId(ticketId)}.json`
    );

  const stored = (ticketId: string): TicketSummary | null => {
    try {
      const parsed = TicketSummarySchema.safeParse(
        JSON.parse(fs.readFileSync(file(ticketId), 'utf8'))
      );

      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  };

  const write = (ticket: SummaryTicket, hash: string): void => {
    const controller = new AbortController();
    running.set(ticket.id, hash);
    // A run for an older description is stopped, not left to its timeout:
    // set after `running`, so its finish sees it superseded and stores nothing.
    controllers.get(ticket.id)?.abort();
    controllers.set(ticket.id, controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // A run that hangs never keeps the runner (or a test) from exiting.
    timer.unref?.();
    const finish = (summary: TicketSummary | null, why?: string): void => {
      clearTimeout(timer);

      if (controllers.get(ticket.id) === controller) {
        controllers.delete(ticket.id);
      }

      if (running.get(ticket.id) !== hash) {
        return;
      }

      running.delete(ticket.id);
      const fail = (reason: string): void => {
        failed.set(ticket.id, hash);
        deps.log(`No summary for ${ticket.id}: ${reason}`);
      };

      if (summary === null) {
        fail(why ?? 'unknown');

        return;
      }

      // Run inside the run's promise handler: a throw here (a full disk, a
      // bad answer) would be an unhandled rejection that ends the runner.
      try {
        writeSummary(file(ticket.id), TicketSummarySchema.parse(summary));
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    };

    controller.signal.addEventListener('abort', () =>
      finish(null, `it took longer than ${timeoutMs / 1000} seconds`)
    );
    deps.run(ticket, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) {
          return;
        }

        // Read inside a try: a throw here would be an unhandled rejection,
        // and the ticket would stay "Writing a summary…" until the abort.
        const read = (() => {
          try {
            return {
              answer: result.exitCode === 0 ? answerIn(result.stdout) : null,
            };
          } catch (error) {
            return {
              error: error instanceof Error ? error.message : String(error),
            };
          }
        })();

        if ('error' in read) {
          finish(null, read.error);

          return;
        }

        const { answer } = read;
        const stderr = tailOf(result.stderr ?? '');

        finish(
          answer === null
            ? null
            : {
                ticketId: ticket.id,
                name: answer.name ?? ticket.title,
                today: answer.today,
                after: answer.after,
                sourceHash: hash,
                by: 'product-manager',
              },
          result.exitCode === 0
            ? 'it returned no today or after'
            : `it exited ${result.exitCode}${
                stderr === '' ? '' : `: ${stderr}`
              }`
        );
      },
      (error: unknown) => finish(null, String(error))
    );
  };

  const stateOf = (
    ticket: SummaryTicket,
    planned: PlannedSummary | null,
    /** The page was just opened (not one of its refreshes). */
    options: { opened?: boolean } = {}
  ): SummaryState => {
    const source = summarySource(ticket, planned, stored(ticket.id));

    if (source.kind !== 'needs-summary') {
      return {
        state: 'ready',
        name: source.name,
        today: source.today,
        after: source.after,
      };
    }

    // Needs a summary: one run writes it, however many open the page.
    const { hash } = source;

    if (running.get(ticket.id) === hash) {
      return { state: 'writing' };
    }

    // The last try failed: "No summary yet." while the page refreshes, and
    // one new try only when it's opened again.
    if (failed.get(ticket.id) === hash && options.opened !== true) {
      return { state: 'none' };
    }

    failed.delete(ticket.id);

    write(ticket, hash);

    return { state: 'writing' };
  };

  return { stateOf, file };
};

/**
 * The real run: `claude -p` in the project folder, with the Product
 * manager's instructions and its read-only settings file.
 */
/** What the summary run needs of a started process. */
export type SpawnLike = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    signal: AbortSignal;
    stdio: ['ignore', 'pipe', 'pipe'];
  }
) => {
  stdout: { on: (event: 'data', listener: (chunk: Buffer) => void) => unknown };
  stderr: { on: (event: 'data', listener: (chunk: Buffer) => void) => unknown };
  on: (event: string, listener: (value?: unknown) => void) => unknown;
};

export const claudeSummaryRun =
  (options: {
    cwd: string;
    instructionsFile: string;
    settingsFile: string;
    /** For tests: how the process is started. */
    spawn?: SpawnLike;
  }): SummaryRun =>
  (ticket, signal) =>
    new Promise((resolve) => {
      const prompt = [
        `Read ${options.instructionsFile}: you are the Product manager.`,
        `Write the plain summary of ticket ${ticket.id} ("${ticket.title}") for the Tickets screen: what a person sees today, and what changes once it ships.`,
        'Answer with one line of JSON and nothing else: {"today": "…", "after": "…"}.',
        '',
        'The ticket:',
        ticket.description,
      ].join('\n');
      // Started as pod agents are, through the pod launcher.
      const launch = oneShotLaunch({
        prompt,
        settingsFile: options.settingsFile,
      });
      const child = (options.spawn ?? spawn)(launch.command, launch.args, {
        cwd: options.cwd,
        env: launch.env,
        signal,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const out = { text: '', err: '' };
      // Only the tail its answer is read from is kept.
      child.stdout.on('data', (chunk: Buffer) => {
        out.text = (out.text + chunk.toString('utf8')).slice(
          -ANSWER_TAIL_CHARS
        );
      });
      // Only its end is kept: that's where a failed run says why.
      child.stderr.on('data', (chunk: Buffer) => {
        out.err = (out.err + chunk.toString('utf8')).slice(
          -STDERR_TAIL_CHARS * 2
        );
      });
      child.on('error', (error) =>
        resolve({
          exitCode: 1,
          stdout: out.text,
          stderr: tailOf(
            `${out.err}\ncouldn't start: ${
              error instanceof Error ? error.message : String(error)
            }`
          ),
        })
      );
      child.on('close', (code) =>
        resolve({
          exitCode: typeof code === 'number' ? code : 1,
          stdout: out.text,
          stderr: tailOf(out.err),
        })
      );
    });
