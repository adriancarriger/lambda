import { RESEND_MAX_AGE_MS, pendingResends } from '../resend';
import { type ThreadMessage } from '../schemas';

const NOW = Date.parse('2026-10-12T16:00:00.000Z');

const message = (overrides: Partial<ThreadMessage>): ThreadMessage => ({
  id: 'm1',
  podId: 'pawnee-a1b2',
  from: 'human',
  mode: 'async',
  text: 'Leslie decides: ship the detour layer.',
  wire: '/human-async q4 [m:m1]',
  target: 'dev',
  createdAt: new Date(NOW - 60 * 60_000).toISOString(),
  delivery: 'delivered',
  ...overrides,
});

const ids = (thread: ThreadMessage[]): string[] =>
  pendingResends(thread, NOW).map((entry) => entry.id);

describe('pendingResends', () => {
  it('re-sends an answer that was typed into the pane but never taken in', () => {
    expect(
      ids([
        message({ id: 'lost' }),
        message({ id: 'never-delivered', delivery: 'pending' }),
        message({ id: 'taken', delivery: 'received' }),
      ])
    ).toEqual(['lost', 'never-delivered']);
  });

  it('re-sends messages between the agents, and system resolutions', () => {
    expect(
      ids([
        message({ id: 'from-manager', from: 'manager' }),
        message({
          id: 'resolved',
          from: 'system',
          mode: 'note',
          wire: '/human-resolved q6 [m:resolved]',
        }),
      ])
    ).toEqual(['from-manager', 'resolved']);
  });

  it('skips restart notices, nudges and heartbeats, which are sent afresh', () => {
    expect(
      ids([
        message({
          id: 'restarted',
          from: 'system',
          mode: 'note',
          text: '',
          wire: '/pod-restarted [m:restarted]',
        }),
        message({
          id: 'nudge',
          from: 'system',
          mode: 'note',
          text: '[Watchdog] Nothing is running in this pod.',
          wire: '[m:nudge]: [Watchdog] Nothing is running in this pod.',
          target: 'manager',
        }),
        message({
          id: 'heartbeat',
          from: 'system',
          mode: 'note',
          text: '[Heartbeat] Check the step-0 ticket.',
          wire: '[m:heartbeat]: [Heartbeat] Check the step-0 ticket.',
          target: 'manager',
        }),
      ])
    ).toEqual([]);
  });

  it('skips forks, entries with nothing to send, and old backlog', () => {
    expect(
      ids([
        message({ id: 'fork', target: 'fork-chat' }),
        message({ id: 'no-wire', wire: undefined }),
        message({
          id: 'old',
          createdAt: new Date(NOW - RESEND_MAX_AGE_MS - 1).toISOString(),
        }),
      ])
    ).toEqual([]);
  });
});
