import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { oneShotLaunch } from '../../pod/launch';
import {
  SUMMARY_TIMEOUT_MS,
  type SummaryRun,
  answerIn,
  claudeSummaryRun,
  createTicketSummaries,
  summarySource,
} from '../server/ticketSummary';

/**
 * A ticket page's plain summary: from the checkpoint that planned it, else
 * written once by a one-shot Product manager run and stored, rewritten when
 * the description changes.
 */

const TICKET = {
  id: '3',
  title: 'Trail closures',
  description: "Hikers can't see which trails are closed.",
};

const ANSWER = JSON.stringify({
  today: "Hikers can't see which trails are closed.",
  after: "Each park page shows today's closed trails.",
});

const PAWNEE = '/tmp/pawnee';

const ignore = (): void => undefined;

const sha256 = (text: string) =>
  crypto.createHash('sha256').update(text).digest('hex');

/** A run that waits until the test settles it. */
const controlled = () => {
  const calls: {
    ticket: { id: string };
    settle: (result: {
      exitCode: number;
      stdout: string;
      stderr?: string;
    }) => void;
    signal: AbortSignal;
  }[] = [];
  const run: SummaryRun = (ticket, signal) =>
    new Promise((resolve) => {
      calls.splice(calls.length, 0, { ticket, settle: resolve, signal });
    });

  return { run, calls };
};

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('ticket summaries', () => {
  const dirs: string[] = [];
  const dir = () => {
    const made = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-summaries-'));
    dirs.splice(dirs.length, 0, made);

    return made;
  };

  afterEach(() => {
    jest.useRealTimers();
    dirs
      .splice(0)
      .forEach((made) => fs.rmSync(made, { recursive: true, force: true }));
  });

  it("uses a planned ticket's checkpoint name, today and after, running nothing", () => {
    const { run, calls } = controlled();
    const summaries = createTicketSummaries({
      root: dir(),
      project: PAWNEE,
      run,
      log: ignore,
    });

    expect(
      summaries.stateOf(TICKET, {
        name: '3 - Trail closures',
        today: 'Today.',
        after: 'After.',
        podId: 'pickup-a1b2',
      })
    ).toEqual({
      state: 'ready',
      name: '3 - Trail closures',
      today: 'Today.',
      after: 'After.',
    });
    expect(calls).toEqual([]);
  });

  it('writes an unplanned one once, stores it with the description’s hash, then reads it back', async () => {
    const root = dir();
    const { run, calls } = controlled();
    const summaries = createTicketSummaries({
      root,
      project: PAWNEE,
      run,
      log: ignore,
    });

    expect(summaries.stateOf(TICKET, null)).toEqual({ state: 'writing' });
    calls[0]?.settle({ exitCode: 0, stdout: `Here it is:\n${ANSWER}\n` });
    await flush();

    expect(summaries.stateOf(TICKET, null)).toEqual({
      state: 'ready',
      name: 'Trail closures',
      today: "Hikers can't see which trails are closed.",
      after: "Each park page shows today's closed trails.",
    });
    expect(JSON.parse(fs.readFileSync(summaries.file('3'), 'utf8'))).toEqual({
      ticketId: '3',
      name: 'Trail closures',
      today: "Hikers can't see which trails are closed.",
      after: "Each park page shows today's closed trails.",
      sourceHash: sha256(TICKET.description),
      by: 'product-manager',
    });
    expect(calls).toHaveLength(1);
  });

  it('rewrites a stored summary once the description changes', async () => {
    const { run, calls } = controlled();
    const summaries = createTicketSummaries({
      root: dir(),
      project: PAWNEE,
      run,
      log: ignore,
    });
    summaries.stateOf(TICKET, null);
    calls[0]?.settle({ exitCode: 0, stdout: ANSWER });
    await flush();

    expect(
      summaries.stateOf({ ...TICKET, description: 'Now with Lot 48.' }, null)
    ).toEqual({ state: 'writing' });
    expect(calls).toHaveLength(2);
  });

  it('starts one run for two opens at once', () => {
    const { run, calls } = controlled();
    const summaries = createTicketSummaries({
      root: dir(),
      project: PAWNEE,
      run,
      log: ignore,
    });

    expect(summaries.stateOf(TICKET, null)).toEqual({ state: 'writing' });
    expect(summaries.stateOf(TICKET, null)).toEqual({ state: 'writing' });
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['exits 1', { exitCode: 1, stdout: ANSWER }],
    [
      'returns no after',
      { exitCode: 0, stdout: JSON.stringify({ today: 'Today.' }) },
    ],
    ['returns no JSON', { exitCode: 0, stdout: 'I could not read it.' }],
  ])(
    'stores nothing when the run %s, says "No summary yet.", and tries again next open',
    async (_label, result) => {
      const { run, calls } = controlled();
      const summaries = createTicketSummaries({
        root: dir(),
        project: PAWNEE,
        run,
        log: ignore,
      });
      summaries.stateOf(TICKET, null);
      calls[0]?.settle(result);
      await flush();

      expect(summaries.stateOf(TICKET, null)).toEqual({ state: 'none' });
      expect(fs.existsSync(summaries.file('3'))).toBe(false);
      // The open page re-reads it: still "No summary yet.", and no new run.
      expect(summaries.stateOf(TICKET, null)).toEqual({ state: 'none' });
      expect(summaries.stateOf(TICKET, null)).toEqual({ state: 'none' });
      expect(calls).toHaveLength(1);
      // Opened again: one new try.
      expect(summaries.stateOf(TICKET, null, { opened: true })).toEqual({
        state: 'writing',
      });
      expect(calls).toHaveLength(2);
    }
  );

  it('tries again on a refresh once a failed ticket’s description changes', async () => {
    const { run, calls } = controlled();
    const summaries = createTicketSummaries({
      root: dir(),
      project: PAWNEE,
      run,
      log: ignore,
    });
    summaries.stateOf(TICKET, null);
    calls[0]?.settle({ exitCode: 1, stdout: '' });
    await flush();
    const changed = {
      ...TICKET,
      description: 'Hikers can’t see when Lot 48 closes.',
    };

    expect(summaries.stateOf(changed, null)).toEqual({ state: 'writing' });
    expect(calls).toHaveLength(2);
  });

  it('says "No summary yet." and logs why when the summary cannot be stored', async () => {
    const { run, calls } = controlled();
    const logged: string[] = [];
    const summaries = createTicketSummaries({
      root: dir(),
      project: PAWNEE,
      run,
      log: (line) => logged.splice(logged.length, 0, line),
      write: () => {
        throw new Error('ENOSPC: no space left on device');
      },
    });
    summaries.stateOf(TICKET, null);
    calls[0]?.settle({ exitCode: 0, stdout: ANSWER });
    await flush();

    expect(logged).toEqual([
      'No summary for 3: ENOSPC: no space left on device',
    ]);
    expect(summaries.stateOf(TICKET, null)).toEqual({ state: 'none' });
    expect(calls).toHaveLength(1);
  });

  it('gives up on a run past 2 minutes, storing nothing', async () => {
    jest.useFakeTimers();
    const { run, calls } = controlled();
    const summaries = createTicketSummaries({
      root: dir(),
      project: PAWNEE,
      run,
      log: ignore,
    });
    summaries.stateOf(TICKET, null);

    jest.advanceTimersByTime(SUMMARY_TIMEOUT_MS + 1);
    await flush();

    expect(SUMMARY_TIMEOUT_MS).toBe(2 * 60_000);
    expect(calls[0]?.signal.aborted).toBe(true);
    expect(summaries.stateOf(TICKET, null)).toEqual({ state: 'none' });

    // A late answer from the run it gave up on is not stored.
    calls[0]?.settle({ exitCode: 0, stdout: ANSWER });
    await flush();

    expect(fs.existsSync(summaries.file('3'))).toBe(false);
    // The next open tries again.
    expect(summaries.stateOf(TICKET, null, { opened: true })).toEqual({
      state: 'writing',
    });
    expect(calls).toHaveLength(2);
  });

  it("logs the run's own last words and exit code when it fails", async () => {
    const { run, calls } = controlled();
    const logged: string[] = [];
    const summaries = createTicketSummaries({
      root: dir(),
      project: PAWNEE,
      run,
      log: (line) => logged.splice(logged.length, 0, line),
    });
    summaries.stateOf(TICKET, null);
    calls[0]?.settle({
      exitCode: 1,
      stdout: '',
      stderr: `${'x'.repeat(5000)}\nInvalid API key. Run /login.\n`,
    });
    await flush();

    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(
      /^No summary for 3: it exited 1: x+\nInvalid API key\. Run \/login\.$/
    );
    // Only the tail: a run that printed pages doesn't flood the log.
    expect(logged[0]?.length).toBeLessThan(1000);
  });

  it("keeps two projects' summaries of the same ticket id apart under one pods root", async () => {
    const root = dir();
    const { run, calls } = controlled();
    const pawnee = createTicketSummaries({
      root,
      project: PAWNEE,
      run,
      log: ignore,
    });
    const eagleton = createTicketSummaries({
      root,
      project: '/tmp/eagleton',
      run,
      log: ignore,
    });
    pawnee.stateOf(TICKET, null);
    calls[0]?.settle({ exitCode: 0, stdout: ANSWER });
    await flush();

    expect(eagleton.file('3')).not.toBe(pawnee.file('3'));
    // Eagleton's ticket "3" with the same description is not Pawnee's.
    expect(eagleton.stateOf(TICKET, null)).toEqual({ state: 'writing' });
    expect(calls).toHaveLength(2);
  });

  it('refuses a ticket id that would leave the summaries folder', () => {
    const { run } = controlled();
    const summaries = createTicketSummaries({
      root: dir(),
      project: PAWNEE,
      run,
      log: ignore,
    });

    expect(() => summaries.file('../../lambda')).toThrow(
      `"../../lambda" isn't a ticket id`
    );
  });
});

describe('a ticket whose description changes while its summary is written', () => {
  it('stops the run for the old description', () => {
    const { run, calls } = controlled();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-summaries-'));
    const summaries = createTicketSummaries({
      root,
      project: PAWNEE,
      run,
      log: ignore,
    });

    summaries.stateOf(TICKET, null);
    summaries.stateOf(
      { ...TICKET, description: 'Now with the ridge loop.' },
      null
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]?.signal.aborted).toBe(true);
    expect(calls[1]?.signal.aborted).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("the run's answer", () => {
  it('reads past thousands of braces that never close, quickly and without a stack overflow', () => {
    const started = Date.now();

    expect(answerIn(`${'{'.repeat(12_000)}\n${ANSWER}\n`)).toEqual(
      JSON.parse(ANSWER)
    );
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('reads past thousands of {placeholder} spans, quickly', () => {
    const started = Date.now();

    expect(answerIn(`${'{spec} '.repeat(1_500)}\n${ANSWER}\n`)).toEqual(
      JSON.parse(ANSWER)
    );
    expect(Date.now() - started).toBeLessThan(1000);
  }, 30_000);

  it('reads an answer whose text has braces in it', () => {
    expect(
      answerIn(
        'Done.\n{"today":"x","after":"The {spec} placeholder is filled in"}\n'
      )
    ).toEqual({ today: 'x', after: 'The {spec} placeholder is filled in' });
  });
});

describe("a ticket's summary source", () => {
  const planned = {
    podId: 'pickup-c3d4',
    name: '3 - Trail closures',
    today: "Hikers can't see which trails are closed.",
    after: "Each park page shows today's closed trails.",
  };
  const stored = {
    ticketId: '3',
    name: 'Trail closures',
    today: 'Before.',
    after: 'After.',
    sourceHash: sha256(TICKET.description),
    by: 'product-manager' as const,
  };

  it('is the checkpoint for a planned ticket', () => {
    expect(summarySource(TICKET, planned, null)).toEqual({
      kind: 'planned',
      name: planned.name,
      today: planned.today,
      after: planned.after,
    });
  });

  it('is "needs summary" for an unplanned one with nothing stored', () => {
    expect(summarySource(TICKET, null, null)).toEqual({
      kind: 'needs-summary',
      hash: sha256(TICKET.description),
    });
  });

  it('is the stored one while the description is the same', () => {
    expect(summarySource(TICKET, null, stored)).toEqual({
      kind: 'stored',
      name: 'Trail closures',
      today: 'Before.',
      after: 'After.',
    });
  });

  it('is "needs summary" again once the description changes (a new SHA-256)', () => {
    const changed = {
      ...TICKET,
      description: 'Hikers see a banner at closing.',
    };

    expect(summarySource(changed, null, stored)).toEqual({
      kind: 'needs-summary',
      hash: sha256('Hikers see a banner at closing.'),
    });
  });
});

describe("the summary writer's Claude run", () => {
  it('starts through the pod launcher, read-only, with nothing of its own', async () => {
    const spawned: { command: string; args: string[]; env?: unknown }[] = [];
    const run = claudeSummaryRun({
      cwd: '/tmp/pawnee',
      instructionsFile: '/lambda/instructions/building/product-manager.md',
      settingsFile: '/tmp/pods/_product-manager/settings.json',
      spawn: (command, args, options) => {
        spawned.splice(spawned.length, 0, { command, args, env: options.env });
        const child = Object.assign(new EventEmitter(), {
          stdout: new EventEmitter(),
          stderr: new EventEmitter(),
        });
        setImmediate(() => {
          child.stdout.emit('data', Buffer.from(ANSWER));
          child.emit('close', 0);
        });

        return child;
      },
    });

    const result = await run(TICKET, new AbortController().signal);
    const launch = oneShotLaunch({
      prompt: spawned[0]?.args[1] ?? '',
      settingsFile: '/tmp/pods/_product-manager/settings.json',
    });

    expect(result).toEqual({ exitCode: 0, stdout: ANSWER, stderr: '' });
    expect(spawned).toEqual([
      { command: launch.command, args: launch.args, env: launch.env },
    ]);
    expect(launch.args).toEqual(
      expect.arrayContaining([
        '-p',
        '--settings',
        '/tmp/pods/_product-manager/settings.json',
        '--strict-mcp-config',
      ])
    );
    expect(launch.args).not.toContain('auto');
  });

  it('answers the tail of what it printed to stderr when it fails', async () => {
    const run = claudeSummaryRun({
      cwd: '/tmp/pawnee',
      instructionsFile: '/lambda/instructions/building/product-manager.md',
      settingsFile: '/tmp/pods/_product-manager/settings.json',
      spawn: () => {
        const child = Object.assign(new EventEmitter(), {
          stdout: new EventEmitter(),
          stderr: new EventEmitter(),
        });
        setImmediate(() => {
          child.stderr.emit('data', Buffer.from('Invalid API key.\n'));
          child.emit('close', 1);
        });

        return child;
      },
    });

    await expect(run(TICKET, new AbortController().signal)).resolves.toEqual({
      exitCode: 1,
      stdout: '',
      stderr: 'Invalid API key.',
    });
  });

  it("names why it couldn't start", async () => {
    const run = claudeSummaryRun({
      cwd: '/tmp/pawnee',
      instructionsFile: '/lambda/instructions/building/product-manager.md',
      settingsFile: '/tmp/pods/_product-manager/settings.json',
      spawn: () => {
        const child = Object.assign(new EventEmitter(), {
          stdout: new EventEmitter(),
          stderr: new EventEmitter(),
        });
        setImmediate(() =>
          child.emit('error', new Error('spawn claude ENOENT'))
        );

        return child;
      },
    });

    await expect(run(TICKET, new AbortController().signal)).resolves.toEqual({
      exitCode: 1,
      stdout: '',
      stderr: "couldn't start: spawn claude ENOENT",
    });
  });
});
