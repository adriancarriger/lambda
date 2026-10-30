import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { markShippedGroupsDone } from '../groups';
import { fakeSource, ticket } from './fakes';

/**
 * The runner marks grouped tickets done once their group ships. One ticket
 * the tracker can't answer for must never stop the rest, nor every tick.
 */

const roots: string[] = [];

afterEach(() => {
  roots.splice(0).forEach((root) => {
    fs.rmSync(root, { recursive: true, force: true });
  });
});

const line = (root: string, event: Record<string, unknown>) =>
  fs.appendFileSync(
    path.join(root, '.lambda', 'events.jsonl'),
    `${JSON.stringify(event)}\n`
  );

/** A project whose group g1 (the given tickets, each shipped) has shipped. */
const shippedGroup = (ids: string[]): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-groups-'));
  roots.splice(roots.length, 0, root);
  fs.mkdirSync(path.join(root, '.lambda'));
  ids.forEach((id) => {
    line(root, {
      type: 'group.add',
      groupId: 'g1',
      ticket: id,
      at: '2026-10-23T09:00:00.000Z',
    });
    line(root, { type: 'ship.end', result: 'pass', ticket: id });
  });
  line(root, {
    type: 'group.shipped',
    groupId: 'g1',
    at: '2026-10-23T10:30:00.000Z',
  });

  return root;
};

describe('markShippedGroupsDone', () => {
  it('marks the rest done when one grouped ticket is gone from the tracker, and stops asking about it', async () => {
    const root = shippedGroup(['9', '3']);
    const source = fakeSource([ticket('3', { status: 'building' })]);
    const asked: string[] = [];
    const counted = {
      get: (id: string) => {
        asked.splice(asked.length, 0, id);

        return source.get(id);
      },
      update: source.update,
    };
    const logged: string[] = [];
    const log = (text: string) => {
      logged.splice(logged.length, 0, text);
    };

    expect(await markShippedGroupsDone(root, counted, { log })).toEqual(['3']);
    expect(source.statusOf('3')).toBe('done');

    // Something else reported: the file changed, but 9 is settled.
    line(root, { type: 'ship.start', ticket: '4' });
    await markShippedGroupsDone(root, counted, { log });

    expect(asked).toEqual(['9', '3']);
    expect(logged).toEqual([
      "9 is no longer in the tracker: it can't be marked done.",
    ]);
  });

  it('logs a ticket the tracker refuses for now, marks the rest, and tries it again next tick', async () => {
    const root = shippedGroup(['5', '3']);
    const source = fakeSource([
      ticket('3', { status: 'building' }),
      ticket('5', { status: 'building' }),
    ]);
    source.failNextUpdate('5');
    const logged: string[] = [];
    const log = (text: string) => {
      logged.splice(logged.length, 0, text);
    };

    expect(await markShippedGroupsDone(root, source, { log })).toEqual(['3']);
    expect(source.statusOf('5')).toBe('building');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/^Couldn't mark 5 done \(trying again\): /);

    // Nothing new in the events file, and 5 is still tried.
    expect(await markShippedGroupsDone(root, source, { log })).toEqual(['5']);
    expect(source.statusOf('5')).toBe('done');
  });
});
