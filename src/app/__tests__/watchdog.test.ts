import type { Pod, ThreadMessage, Turn } from '../../pod-store';
import {
  type Episode,
  HANG_MS,
  LOST_MS,
  NUDGE_GAP_MS,
  type PodSignals,
  STALL_GRACE_MS,
  judge,
} from '../server/watchdog';
import { sameEscalation } from '../server/watchdogRunner';

const T0 = Date.parse('2026-10-06T10:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

const pod: Pod = {
  id: 'pawnee-a1b2',
  slug: 'pawnee',
  createdAt: iso(T0 - 3_600_000),
  status: 'active',
  phase: 4,
  completedCheckpoints: [1, 2, 3, 4],
  worktreePath: '/tmp',
  ownsWorktree: true,
  managerCwd: '/tmp',
  devCwd: '/tmp',
  agentCommand: 'claude',
  sessions: { manager: 'm', dev: 'd' },
};

const ended = (at: number): Turn => ({
  sentAt: iso(at - 60_000),
  startedAt: iso(at - 59_000),
  endedAt: iso(at),
});
const working = (since: number): Turn => ({
  sentAt: iso(since - 1),
  startedAt: iso(since),
  endedAt: iso(since - 120_000),
});

const signals = (overrides: Partial<PodSignals> = {}): PodSignals => ({
  pod,
  running: true,
  hasInboxItems: false,
  turns: { manager: ended(T0), dev: ended(T0) },
  thread: [],
  questions: [],
  steps: [],
  transcriptAt: {},
  screens: {},
  ...overrides,
});

/** Run ticks in order, carrying the episode; returns every verdict. */
const run = (ticks: { at: number; signals: PodSignals }[]) =>
  ticks.reduce<{ verdicts: string[]; episode?: Episode }>(
    (acc, tick) => {
      const { verdict, episode } = judge(tick.signals, acc.episode, tick.at);

      return {
        verdicts: [
          ...acc.verdicts,
          verdict.kind === 'nudge' ? `nudge ${verdict.attempt}` : verdict.kind,
        ],
        episode,
      };
    },
    { verdicts: [] }
  ).verdicts;

describe('the watchdog', () => {
  it('leaves a working pod, and one waiting on the owner, alone', () => {
    expect(
      run([
        {
          at: T0 + 600_000,
          signals: signals({ turns: { manager: working(T0), dev: ended(T0) } }),
        },
        { at: T0 + 600_000, signals: signals({ hasInboxItems: true }) },
      ])
    ).toEqual(['ok', 'ok']);
  });

  it('does not nudge a manager that was just handed something (a work request)', () => {
    const idleSince = (ms: number): Turn => ({
      ...ended(ms),
      sentAt: iso(ms - 60_000),
    });
    const justSent = {
      ...ended(T0),
      sentAt: iso(T0 + 10 * 60_000),
    };

    expect(
      run([
        {
          // Idle for 10 minutes, but a message reached the manager just now.
          at: T0 + 10 * 60_000 + 5_000,
          signals: signals({
            turns: { manager: justSent, dev: idleSince(T0) },
          }),
        },
      ])
    ).toEqual(['ok']);
  });

  it('waits out the handoff grace, then nudges', () => {
    expect(
      run([
        { at: T0 + STALL_GRACE_MS - 1_000, signals: signals() },
        { at: T0 + STALL_GRACE_MS, signals: signals() },
      ])
    ).toEqual(['ok', 'nudge 1']);
  });

  it('a nudge that only causes "nothing to do" turns does not reset the count — twice, then the inbox', () => {
    const after = (ms: number) => T0 + STALL_GRACE_MS + ms;

    expect(
      run([
        { at: after(0), signals: signals() },
        // The nudge makes the manager take a turn…
        {
          at: after(10_000),
          signals: signals({
            turns: { manager: working(after(5_000)), dev: ended(T0) },
          }),
        },
        // …which ends with nothing done.
        {
          at: after(NUDGE_GAP_MS),
          signals: signals({
            turns: { manager: ended(after(20_000)), dev: ended(T0) },
          }),
        },
        {
          at: after(2 * NUDGE_GAP_MS + 1),
          signals: signals({
            turns: { manager: ended(after(20_000)), dev: ended(T0) },
          }),
        },
      ])
    ).toEqual(['nudge 1', 'ok', 'nudge 2', 'escalate']);
  });

  it('real progress starts a fresh count', () => {
    const after = (ms: number) => T0 + STALL_GRACE_MS + ms;
    const progressed = signals({
      steps: [{ at: iso(after(30_000)), step: 'e2e-plans', event: 'done' }],
    });

    expect(
      run([
        { at: after(0), signals: signals() },
        { at: after(NUDGE_GAP_MS), signals: signals() },
        // The second nudge worked: a step was reported, then it stalled again.
        { at: after(2 * NUDGE_GAP_MS + 1), signals: progressed },
      ])
    ).toEqual(['nudge 1', 'nudge 2', 'nudge 1']);
  });

  it('a permission prompt goes straight to the owner', () => {
    expect(
      run([
        {
          at: T0 + 5_000,
          signals: signals({
            turns: { manager: working(T0), dev: ended(T0) },
            screens: {
              manager:
                'Bash command\n tmux send-keys -t x C-u\n Do you want to proceed?\n ❯ 1. Yes',
            },
          }),
        },
      ])
    ).toEqual(['escalate']);
  });

  it('the usage limit goes straight to the owner, with when it resets', () => {
    const limited = signals({
      turns: { manager: working(T0), dev: ended(T0) },
      screens: {
        manager:
          "  ⎿  You've hit your weekly limit · resets 9am (America/Indiana/Indianapolis)\n⏺ Usage limit reached · continuing automatically at 9am",
      },
    });

    expect(judge(limited, undefined, T0 + 5_000).verdict).toEqual({
      kind: 'escalate',
      reason:
        'The manager hit the Claude usage limit (resets 9am). Log in to another account and restart the pod, or wait',
    });
  });

  it('a turn that has written nothing for 15 minutes is hung', () => {
    expect(
      run([
        {
          at: T0 + HANG_MS + 1,
          signals: signals({
            turns: { manager: ended(T0), dev: working(T0) },
            transcriptAt: { dev: T0 },
          }),
        },
      ])
    ).toEqual(['escalate']);
  });

  describe('a message an agent never took in', () => {
    /** The owner's q4 answer, typed into a busy dev and lost over a reboot. */
    const answer = (overrides: Partial<ThreadMessage> = {}): ThreadMessage => ({
      id: 'mq4',
      podId: pod.id,
      qid: 'q4',
      from: 'human',
      mode: 'async',
      text: 'Either switch turns it on.',
      wire: '/human-async q4 [m:mq4]',
      target: 'dev',
      createdAt: iso(T0 - LOST_MS),
      delivery: 'delivered',
      ...overrides,
    });
    // The dev is idle; the owner has nothing in the inbox, so nobody else looks.
    const lost = signals({ thread: [answer()], hasInboxItems: false });

    it('is re-sent once, then goes to the owner if it is still not taken', () => {
      expect(
        run([
          { at: T0 + LOST_MS, signals: lost },
          { at: T0 + LOST_MS + 15_000, signals: lost },
        ])
      ).toEqual(['resend', 'escalate']);
      expect(judge(lost, undefined, T0 + LOST_MS).verdict).toEqual({
        kind: 'resend',
        msgIds: ['mq4'],
      });
    });

    it('waits while the agent is mid-turn (a busy agent queues it)', () => {
      expect(
        run([
          {
            at: T0 + LOST_MS * 5,
            signals: signals({
              thread: [answer()],
              turns: { manager: ended(T0), dev: working(T0) },
            }),
          },
        ])
      ).toEqual(['ok']);
    });

    it('waits until the agent has been idle a while, and leaves taken ones alone', () => {
      expect(
        run([
          // Something else in the inbox keeps the stall nudges out of it.
          { at: T0 + LOST_MS - 1, signals: { ...lost, hasInboxItems: true } },
          {
            at: T0 + LOST_MS,
            signals: signals({
              thread: [answer({ delivery: 'received' })],
              hasInboxItems: true,
            }),
          },
        ])
      ).toEqual(['ok', 'ok']);
    });

    it('is still noticed after a send that was never taken (sentAt after the last turn)', () => {
      expect(
        run([
          {
            at: T0 + LOST_MS,
            signals: signals({
              thread: [answer()],
              turns: {
                manager: ended(T0),
                dev: { ...ended(T0 - LOST_MS), sentAt: iso(T0 - LOST_MS) },
              },
            }),
          },
        ])
      ).toEqual(['resend']);
    });
  });

  it('counts "hung for 17 minutes" and "for 18 minutes" as one escalation', () => {
    expect(
      sameEscalation(
        'The manager has been mid-turn for 17 minutes without writing anything',
        'The manager has been mid-turn for 18 minutes without writing anything'
      )
    ).toBe(true);
    expect(
      sameEscalation(
        'The manager has been mid-turn for 17 minutes without writing anything',
        'The dev has been mid-turn for 17 minutes without writing anything'
      )
    ).toBe(false);
  });
});
