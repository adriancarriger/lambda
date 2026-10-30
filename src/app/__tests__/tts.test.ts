import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { formatTime, sectionIndexAt } from '../client/timeline';
import { createBudget } from '../server/tts/budget';
import { type Rendered } from '../server/tts/elevenlabs';
import { MAX_CHUNK_CHARS, chunkForKokoro } from '../server/tts/kokoro';
import { comparePriority } from '../server/tts/pieceQueue';
import { createRenderer } from '../server/tts/renderer';
import { audioHash, parseRange, sectionTimes } from '../server/tts/timing';
import { buildScript } from '../shared/speech';

const script = buildScript([
  { key: 'summary', label: 'Summary', text: 'Closed trails get their own line.' },
  {
    key: 'context',
    label: 'Context',
    text: 'Ron Swanson closed the ridge loop on October fifth.',
  },
]);

/** One section's clip, as `sectionSpeech` produces it. */
const clipText = 'Summary. Closed trails get their own line.';

/** A fake ElevenLabs alignment: every character takes 0.05 s. */
const fakeAlignment = (text: string) => ({
  starts: Array.from(text, (_char, index) => index * 0.05),
  ends: Array.from(text, (_char, index) => (index + 1) * 0.05),
});

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'pods-tts-'));

describe('buildScript', () => {
  it('joins labelled sections and records exact character offsets', () => {
    expect(script.text).toBe(
      'Summary. Closed trails get their own line.\n\nContext. Ron Swanson closed the ridge loop on October fifth.'
    );
    const [first, second] = script.sections;

    expect(script.text.slice(first?.start, first?.end)).toBe(
      'Summary. Closed trails get their own line.'
    );
    expect(script.text.slice(second?.start, second?.end)).toBe(
      'Context. Ron Swanson closed the ridge loop on October fifth.'
    );
  });
});

describe('sectionTimes', () => {
  it('places each section at the timestamp of its first character', () => {
    const { sections, duration } = sectionTimes(
      script,
      fakeAlignment(script.text)
    );

    expect(sections[0]?.start).toBe(0);
    expect(sections[1]?.start).toBeCloseTo(
      (script.sections[1]?.start ?? 0) * 0.05
    );
    expect(sections[0]?.end).toBe(sections[1]?.start);
    expect(sections[1]?.end).toBe(duration);
    expect(duration).toBeCloseTo(script.text.length * 0.05);
  });

  it('maps proportionally when the alignment length differs from the script', () => {
    const half = fakeAlignment(
      script.text.slice(0, Math.floor(script.text.length / 2))
    );
    const { sections } = sectionTimes(script, half);

    expect(sections[1]?.start).toBeGreaterThan(0);
    expect(sections[1]?.start).toBeLessThanOrEqual(Math.max(...half.ends));
  });
});

describe('audioHash', () => {
  it('is stable for the same voice/model/text and changes with any of them', () => {
    const base = audioHash('rachel', 'flash', 'Hello Leslie');

    expect(audioHash('rachel', 'flash', 'Hello Leslie')).toBe(base);
    expect(audioHash('rachel', 'flash', 'Hello Ron')).not.toBe(base);
    expect(audioHash('other', 'flash', 'Hello Leslie')).not.toBe(base);
    expect(base).toMatch(/^[a-f0-9]{24}$/);
  });
});

describe('parseRange', () => {
  it('handles the forms browsers send when seeking', () => {
    expect(parseRange(undefined, 1000)).toBeNull();
    expect(parseRange('bytes=0-', 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRange('bytes=100-199', 1000)).toEqual({ start: 100, end: 199 });
    expect(parseRange('bytes=-200', 1000)).toEqual({ start: 800, end: 999 });
    expect(parseRange('bytes=900-5000', 1000)).toEqual({
      start: 900,
      end: 999,
    });
    expect(parseRange('bytes=2000-', 1000)).toBe('unsatisfiable');
  });
});

describe('budget', () => {
  it('accumulates, blocks past the cap, and resets in a new month', () => {
    const file = path.join(tmp(), 'usage.json');
    const clock = { now: new Date('2026-10-03T12:00:00Z') };
    const budget = createBudget({
      file,
      usdPer1kChars: 1,
      capUsd: 10,
      now: () => clock.now,
    });

    expect(budget.allows(9_000)).toBe(true);
    budget.record(9_000);
    expect(budget.status().usd).toBeCloseTo(9);
    expect(budget.allows(2_000)).toBe(false);
    expect(budget.allows(1_000)).toBe(true);
    budget.record(1_000);
    expect(budget.status().overBudget).toBe(true);

    clock.now = new Date('2026-11-01T00:00:01Z');
    expect(budget.status()).toMatchObject({
      month: '2026-11',
      usd: 0,
      overBudget: false,
    });
    expect(budget.allows(9_000)).toBe(true);
  });
});

describe('budget file', () => {
  it('is written in a folder that does not exist yet (~/.lambda on a new machine)', () => {
    const file = path.join(tmp(), 'not-yet', 'tts-usage.json');
    const budget = createBudget({ file, usdPer1kChars: 1, capUsd: 10 });

    budget.record(1_000);

    expect(budget.status().usd).toBeCloseTo(1);
  });

  it('refuses to spend when its file is unreadable, rather than starting at $0', () => {
    const file = path.join(tmp(), 'tts-usage.json');
    fs.writeFileSync(file, '{"month": "2026-10", "characters": 90');
    const budget = createBudget({
      file,
      usdPer1kChars: 1,
      capUsd: 10,
      now: () => new Date('2026-10-03T12:00:00Z'),
    });

    expect(budget.allows(1)).toBe(false);
    // What every pod snapshot shows: over the cap and why, not a crash.
    expect(budget.status()).toMatchObject({
      usd: 0,
      overBudget: true,
      problem: `The audio budget in ${file} can't be read, so nothing is spent until it's fixed or deleted.`,
    });
  });
});

describe('chunkForKokoro', () => {
  const sentence =
    'Ron Swanson builds the bench, and Leslie Knope paints the mural.';

  it('keeps every word, in order, with no chunk over the limit', () => {
    const text = Array.from({ length: 20 }, () => sentence).join(' ');
    const chunks = chunkForKokoro(text);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= MAX_CHUNK_CHARS)).toBe(true);
    expect(chunks.join(' ')).toBe(text);
  });

  it('packs whole sentences, and breaks only an over-long one', () => {
    const long = Array.from({ length: 12 }, () => 'a pause, then more').join(
      ' '
    );
    const chunks = chunkForKokoro(`Short one. ${long}.`, 60);

    expect(chunks[0]).toBe('Short one.');
    expect(chunks.every((chunk) => chunk.length <= 60)).toBe(true);
    expect(chunks.slice(1).join(' ')).toBe(`${long}.`);
  });

  it('leaves a short section whole', () => {
    expect(chunkForKokoro(sentence)).toEqual([sentence]);
  });
});

describe('renderer', () => {
  const setup = (
    render: (text: string) => Promise<Rendered>,
    capUsd = 100,
    cancel?: (text: string) => void
  ) => {
    const root = tmp();
    const scheduled: (() => void)[] = [];
    const renderer = createRenderer({
      audioDir: (podId) => path.join(root, podId, 'audio'),
      render,
      cancel,
      budget: createBudget({
        file: path.join(root, 'usage.json'),
        usdPer1kChars: 1,
        capUsd,
      }),
      enabled: () => true,
      voiceId: 'rachel',
      modelId: 'flash',
      retryDelaysMs: [1, 1],
      settleMs: 0,
      schedule: (fn) => {
        scheduled.splice(scheduled.length, 0, fn);
      },
    });

    return { renderer, scheduled };
  };

  const flush = (): Promise<void> =>
    new Promise((resolve) => setImmediate(resolve));

  it('waits for text to stop changing before paying for a render', async () => {
    const root = tmp();
    const clock = { now: 0 };
    const calls: { texts: string[] } = { texts: [] };
    const renderer = createRenderer({
      audioDir: (podId) => path.join(root, podId, 'audio'),
      render: async (text) => {
        calls.texts.splice(calls.texts.length, 0, text);

        return { audio: Buffer.from('mp3'), alignment: fakeAlignment(text) };
      },
      budget: createBudget({
        file: path.join(root, 'usage.json'),
        usdPer1kChars: 1,
        capUsd: 100,
      }),
      enabled: () => true,
      voiceId: 'rachel',
      modelId: 'flash',
      settleMs: 15_000,
      now: () => clock.now,
      schedule: () => undefined,
    });
    const pod = 'pawnee-a1b2';

    // A dev mid-edit: each version is seen once, then replaced.
    renderer.prefetch([{ podId: pod, text: 'Summary. Half written.' }]);
    clock.now = 5_000;
    renderer.prefetch([{ podId: pod, text: clipText }]);
    clock.now = 10_000;
    renderer.prefetch([{ podId: pod, text: clipText }]);
    await flush();
    expect(calls.texts).toEqual([]);

    // Unchanged for 15 s: now it renders — only the final text.
    clock.now = 21_000;
    renderer.prefetch([{ podId: pod, text: clipText }]);
    await flush();
    expect(calls.texts).toEqual([clipText]);
  });

  it('renders a clip, stores it, and reports its duration', async () => {
    const { renderer } = setup(async (text) => ({
      audio: Buffer.from('mp3'),
      alignment: fakeAlignment(text),
    }));

    expect(renderer.clip('pawnee-a1b2', clipText)).toEqual({ status: 'none' });
    renderer.prefetch([{ podId: 'pawnee-a1b2', text: clipText }]);
    expect(renderer.clip('pawnee-a1b2', clipText).status).toBe('pending');
    await flush();

    expect(renderer.clip('pawnee-a1b2', clipText)).toMatchObject({
      status: 'ready',
      duration: clipText.length * 0.05,
    });
  });

  it('uses a directly reported duration when there is no alignment (Kokoro)', async () => {
    const { renderer } = setup(async () => ({
      audio: Buffer.from('mp3'),
      alignment: { starts: [], ends: [] },
      duration: 4.25,
    }));

    await renderer.renderNow('pawnee-a1b2', clipText);

    expect(renderer.clip('pawnee-a1b2', clipText)).toMatchObject({
      status: 'ready',
      duration: 4.25,
    });
  });

  it('renders on demand at once — and never pays twice for the same text', async () => {
    const calls = { count: 0 };
    const { renderer } = setup(async (text) => {
      calls.count += 1;

      return { audio: Buffer.from('mp3'), alignment: fakeAlignment(text) };
    });

    // Listen to it, listen to something else, jump back: one render.
    const first = await renderer.renderNow('pawnee-a1b2', clipText);
    await renderer.renderNow('pawnee-a1b2', 'Context. Something else.');
    const again = await renderer.renderNow('pawnee-a1b2', clipText);
    renderer.prefetch([{ podId: 'pawnee-a1b2', text: clipText }]);
    await flush();

    expect(first.status).toBe('ready');
    expect(again).toEqual(first);
    expect(calls.count).toBe(2);
  });

  it('never renders (or pays) again because recording the spend failed', async () => {
    const root = tmp();
    const calls = { count: 0 };
    const events: Record<string, unknown>[] = [];
    const budget = createBudget({
      file: path.join(root, 'usage.json'),
      usdPer1kChars: 1,
      capUsd: 100,
    });
    const scheduled: (() => void)[] = [];
    const renderer = createRenderer({
      audioDir: (podId) => path.join(root, podId, 'audio'),
      render: async (text) => {
        calls.count += 1;

        return { audio: Buffer.from('mp3'), alignment: fakeAlignment(text) };
      },
      budget: {
        ...budget,
        record: () => {
          throw new Error('EACCES: permission denied');
        },
      },
      enabled: () => true,
      voiceId: 'rachel',
      modelId: 'flash',
      retryDelaysMs: [1, 1],
      settleMs: 0,
      schedule: (fn) => {
        scheduled.splice(scheduled.length, 0, fn);
      },
      log: (event) => {
        events.splice(events.length, 0, event);
      },
    });

    renderer.prefetch([{ podId: 'pawnee-a1b2', text: clipText }]);
    await flush();
    scheduled.splice(0).forEach((fn) => fn());
    await flush();

    expect(calls.count).toBe(1);
    expect(renderer.clip('pawnee-a1b2', clipText).status).toBe('ready');
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'budget-not-recorded',
        reason: 'EACCES: permission denied',
      })
    );
  });

  it('joins a render already in flight instead of starting another', async () => {
    const calls = { count: 0 };
    const { renderer } = setup(async (text) => {
      calls.count += 1;

      return { audio: Buffer.from('mp3'), alignment: fakeAlignment(text) };
    });

    const [a, b] = await Promise.all([
      renderer.renderNow('pawnee-a1b2', clipText),
      renderer.renderNow('pawnee-a1b2', clipText),
    ]);

    expect(a.status).toBe('ready');
    expect(b.status).toBe('ready');
    expect(calls.count).toBe(1);
  });

  it('logs each render and how long the player waited (.lambda/pods/_tts.log)', async () => {
    const root = tmp();
    const clock = { now: 1_000 };
    const events: Record<string, unknown>[] = [];
    const renderer = createRenderer({
      audioDir: (podId) => path.join(root, podId, 'audio'),
      render: async (text) => {
        clock.now += 4_000;

        return {
          audio: Buffer.from('mp3'),
          alignment: { starts: [], ends: [] },
          duration: 8,
        };
      },
      budget: createBudget({
        file: path.join(root, 'usage.json'),
        usdPer1kChars: 1,
        capUsd: 100,
      }),
      enabled: () => true,
      voiceId: 'rachel',
      modelId: 'flash',
      settleMs: 0,
      now: () => clock.now,
      schedule: () => undefined,
      log: (event) => {
        events.splice(events.length, 0, event);
      },
    });

    await renderer.renderNow('pawnee-a1b2', clipText, 'now');

    expect(events).toEqual([
      expect.objectContaining({
        event: 'rendered',
        podId: 'pawnee-a1b2',
        chars: clipText.length,
        queuedMs: 0,
        renderMs: 4_000,
        audioSec: 8,
        speed: 2,
      }),
      expect.objectContaining({
        event: 'player-wait',
        need: 'now',
        waitedMs: 4_000,
        joined: false,
        status: 'ready',
      }),
    ]);
  });

  describe('priority — what Kokoro renders next', () => {
    const never = (): Promise<Rendered> => new Promise(() => undefined);

    it('the section they are waiting on beats look-ahead, and the newest wait wins', () => {
      const { renderer } = setup(never);
      renderer.setFocus('pawnee-a1b2/q/q7');

      renderer
        .renderNow('pawnee-a1b2', 'Section three.', 'now')
        .catch(() => undefined);
      renderer
        .renderNow('pawnee-a1b2', 'Section four.', 'soon')
        .catch(() => undefined);
      // They jump to section twelve.
      renderer
        .renderNow('pawnee-a1b2', 'Section twelve.', 'now')
        .catch(() => undefined);

      const ranked = ['Section three.', 'Section four.', 'Section twelve.']
        .map((text) => ({ text, priority: renderer.priorityOf(text) }))
        .sort((a, b) => comparePriority(a.priority, b.priority))
        .map(({ text }) => text);

      expect(ranked).toEqual([
        'Section twelve.',
        'Section three.',
        'Section four.',
      ]);
    });

    it('a look-ahead request never downgrades a clip already wanted now', () => {
      const { renderer } = setup(never);
      renderer.setFocus('pawnee-a1b2/q/q7');

      renderer
        .renderNow('pawnee-a1b2', 'Section three.', 'now')
        .catch(() => undefined);
      renderer
        .renderNow('pawnee-a1b2', 'Section three.', 'soon')
        .catch(() => undefined);

      expect(renderer.priorityOf('Section three.')[0]).toBe(0);
    });

    it('clicking away demotes what the player asked for to the background order', () => {
      const { renderer } = setup(never);
      renderer.setFocus('pawnee-a1b2/q/q7');
      renderer.prefetch([
        { podId: 'pawnee-a1b2', text: 'Eagleton opening.' },
        { podId: 'pawnee-a1b2', text: 'Section three.' },
      ]);
      renderer
        .renderNow('pawnee-a1b2', 'Section three.', 'now')
        .catch(() => undefined);
      expect(renderer.priorityOf('Section three.')[0]).toBe(0);

      renderer.setFocus('eagleton-c3d4/q/q2');

      expect(renderer.priorityOf('Section three.')).toEqual([2, 1]);
      expect(renderer.priorityOf('Eagleton opening.')).toEqual([2, 0]);
    });

    it('the background follows the latest order, and drops what left the inbox', () => {
      const cancelled: string[] = [];
      const { renderer } = setup(never, 100, (text) =>
        cancelled.splice(cancelled.length, 0, text)
      );

      renderer.prefetch([
        { podId: 'pawnee-a1b2', text: 'Old item.' },
        { podId: 'pawnee-a1b2', text: 'Kept item.' },
      ]);
      // Both were handed to the provider (rendering). Then "Old item" leaves
      // the inbox and the order changes.
      renderer.prefetch([{ podId: 'pawnee-a1b2', text: 'Kept item.' }]);

      expect(renderer.priorityOf('Kept item.')).toEqual([2, 0]);
      expect(renderer.priorityOf('Old item.')).toEqual([3]);
      expect(cancelled).toEqual(['Old item.']);
    });

    it('the item on screen skips the settling wait', () => {
      const root = tmp();
      const renders: string[] = [];
      const renderer = createRenderer({
        audioDir: (podId) => path.join(root, podId, 'audio'),
        render: (text) => {
          renders.splice(renders.length, 0, text);

          return never();
        },
        budget: createBudget({
          file: path.join(root, 'usage.json'),
          usdPer1kChars: 1,
          capUsd: 100,
        }),
        enabled: () => true,
        voiceId: 'rachel',
        modelId: 'flash',
        settleMs: 15_000,
        concurrency: Number.POSITIVE_INFINITY,
        schedule: () => undefined,
      });

      renderer.prefetch([
        { podId: 'pawnee-a1b2', text: 'On screen.', settle: false },
        { podId: 'pawnee-a1b2', text: 'Elsewhere.' },
      ]);

      expect(renders).toEqual(['On screen.']);
    });
  });

  it('retries in the background, then gives up and falls back', async () => {
    const calls = { count: 0 };
    const { renderer, scheduled } = setup(async () => {
      calls.count += 1;

      throw new Error('ElevenLabs 500');
    });

    renderer.prefetch([{ podId: 'pawnee-a1b2', text: clipText }]);
    await flush();
    expect(renderer.clip('pawnee-a1b2', clipText).status).toBe('pending');

    scheduled.shift()?.();
    await flush();
    scheduled.shift()?.();
    await flush();

    expect(calls.count).toBe(3);
    expect(renderer.clip('pawnee-a1b2', clipText)).toEqual({
      status: 'unavailable',
      reason: 'ElevenLabs 500',
    });
  });

  it('on demand tries once — the player falls back to the browser voice', async () => {
    const calls = { count: 0 };
    const { renderer } = setup(async () => {
      calls.count += 1;

      throw new Error('ElevenLabs 500');
    });

    expect(await renderer.renderNow('pawnee-a1b2', clipText)).toEqual({
      status: 'unavailable',
      reason: 'ElevenLabs 500',
    });
    expect(calls.count).toBe(1);
  });

  it('refuses to render past the monthly cap', async () => {
    const { renderer } = setup(async () => {
      throw new Error('should not be called');
    }, 0.001);

    renderer.prefetch([{ podId: 'pawnee-a1b2', text: clipText }]);

    expect(renderer.clip('pawnee-a1b2', clipText)).toEqual({
      status: 'unavailable',
      reason: 'over-budget',
    });
    expect(
      await renderer.renderNow('pawnee-a1b2', 'Context. A different clip.')
    ).toEqual({ status: 'unavailable', reason: 'over-budget' });
  });
});

describe('timeline', () => {
  it('finds the section playing at a time', () => {
    const sections = [
      { key: 'summary', label: 'Summary', start: 0, end: 4 },
      { key: 'context', label: 'Context', start: 4, end: 10 },
    ];

    expect(sectionIndexAt(sections, 0)).toBe(0);
    expect(sectionIndexAt(sections, 3.9)).toBe(0);
    expect(sectionIndexAt(sections, 4)).toBe(1);
    expect(sectionIndexAt(sections, 99)).toBe(1);
  });

  it('formats times as m:ss', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(75.9)).toBe('1:15');
  });
});
