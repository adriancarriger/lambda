import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { addTime, timeSummary } from '../server/timeLog';

const file = (): string =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pods-time-')), '_time.json');

describe('time log', () => {
  it("splits a card's time by the version on screen", () => {
    const log = file();

    addTime(
      log,
      [
        { podId: 'pawnee-a1b2', qid: 'q4', version: 1, ms: 20_000 },
        // The Plan rail was closed: the card's time, but no version's.
        { podId: 'pawnee-a1b2', qid: 'q4', ms: 5_000 },
      ],
      '2026-10-17'
    );
    addTime(
      log,
      [{ podId: 'pawnee-a1b2', qid: 'q4', version: 2, ms: 7_000 }],
      '2026-10-17'
    );

    expect(timeSummary(log, '2026-10-17').pods['pawnee-a1b2']).toEqual({
      totalMs: 32_000,
      items: { q4: 32_000 },
      versions: { q4: { 1: 20_000, 2: 7_000 } },
      cards: {},
    });
  });

  it('keeps time per card inside a checkpoint, per version', () => {
    const log = file();
    const card = 'screen:Bench list';

    addTime(
      log,
      [
        { podId: 'pawnee-a1b2', qid: 'q4', version: 1, card, ms: 9_000 },
        { podId: 'pawnee-a1b2', qid: 'q4', version: 2, card, ms: 4_000 },
        // A card key that can't be a title is dropped, not the time.
        {
          podId: 'pawnee-a1b2',
          qid: 'q4',
          version: 2,
          card: 'x'.repeat(301),
          ms: 1_000,
        },
      ],
      '2026-10-17'
    );

    const pod = timeSummary(log, '2026-10-17').pods['pawnee-a1b2'];
    expect(pod?.cards).toEqual({ q4: { [card]: { 1: 9_000, 2: 4_000 } } });
    expect(pod?.items).toEqual({ q4: 14_000 });
  });

  it('adds active time per day, per pod and per item', () => {
    const log = file();

    addTime(
      log,
      [
        { podId: 'pawnee-a1b2', qid: 'q1', ms: 15_000 },
        { podId: 'pawnee-a1b2', ms: 5_000 },
        { ms: 2_000 },
      ],
      '2026-10-04'
    );
    addTime(
      log,
      [{ podId: 'pawnee-a1b2', qid: 'q1', ms: 10_000 }],
      '2026-10-04'
    );
    addTime(
      log,
      [{ podId: 'pawnee-a1b2', qid: 'q2', ms: 1_000 }],
      '2026-10-05'
    );

    expect(timeSummary(log, '2026-10-04')).toEqual({
      day: '2026-10-04',
      todayMs: 32_000,
      days: { '2026-10-04': 32_000, '2026-10-05': 1_000 },
      pods: {
        'pawnee-a1b2': {
          totalMs: 31_000,
          items: { q1: 25_000, q2: 1_000 },
          versions: {},
          cards: {},
        },
      },
    });
    expect(timeSummary(log, '2026-10-05').todayMs).toBe(1_000);
  });

  it('ignores nonsense and caps a single report', () => {
    const log = file();

    addTime(log, [{ ms: -5 }, { ms: 0 }, { ms: 60 * 60_000 }], '2026-10-04');

    expect(timeSummary(log, '2026-10-04').todayMs).toBe(5 * 60_000);
  });

  it('credits one batch 5 minutes at most, however many entries it has', () => {
    const log = file();

    addTime(
      log,
      Array.from({ length: 1000 }, () => ({ ms: 5 * 60_000 })),
      '2026-10-04'
    );

    expect(timeSummary(log, '2026-10-04').todayMs).toBe(5 * 60_000);
  });

  it('keeps only real pod and item ids, so the file can’t grow a key per guess', () => {
    const log = file();

    addTime(
      log,
      [
        { podId: '../etc', ms: 1_000 },
        { podId: 'dog-park', qid: 'q'.repeat(500), ms: 1_000 },
        { podId: 'dog-park', qid: 'q1', ms: 2_000 },
      ],
      '2026-10-04'
    );
    const { pods, todayMs } = timeSummary(log, '2026-10-04');

    expect(Object.keys(pods)).toEqual(['dog-park']);
    expect(pods['dog-park']?.items).toEqual({ q1: 2_000 });
    expect(todayMs).toBe(2_000);
  });

  it('moves an unreadable log aside, and says so, instead of writing over it', () => {
    const log = file();
    fs.writeFileSync(log, '{"days": {"2026-10-03": 3600000}, "pods": {');
    const moved: { to: string[] } = { to: [] };

    addTime(log, [{ ms: 1_000 }], '2026-10-04', (to) => {
      moved.to = [...moved.to, to];
    });

    expect(moved.to).toHaveLength(1);
    expect(fs.readFileSync(moved.to[0] ?? '', 'utf8')).toBe(
      '{"days": {"2026-10-03": 3600000}, "pods": {'
    );
    expect(timeSummary(log, '2026-10-04').todayMs).toBe(1_000);
  });

  it('starts empty without a file', () => {
    expect(timeSummary(file(), '2026-10-04')).toEqual({
      day: '2026-10-04',
      todayMs: 0,
      days: {},
      pods: {},
    });
  });
});
