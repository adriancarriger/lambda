import { withKeys } from '../client/uniqueKeys';

describe('a list’s React keys', () => {
  it('stays unique when two rows read the same', () => {
    // Two bad lines in events.jsonl carry the same warning text; with the
    // text as the key React drops or duplicates one of them.
    const rows = withKeys(
      [
        'A line in events.jsonl that isn’t an event.',
        'A line in events.jsonl that isn’t an event.',
        'PAWNEE-12 never finished',
      ],
      (warning) => warning
    );

    expect(rows.map((row) => row.key)).toEqual([
      'A line in events.jsonl that isn’t an event.',
      'A line in events.jsonl that isn’t an event.#2',
      'PAWNEE-12 never finished',
    ]);
    expect(rows.map((row) => row.item)).toEqual([
      'A line in events.jsonl that isn’t an event.',
      'A line in events.jsonl that isn’t an event.',
      'PAWNEE-12 never finished',
    ]);
  });

  it('keeps each row’s key when a later duplicate appears', () => {
    const before = withKeys([{ name: 'PAWNEE-12' }], (row) => row.name);
    const after = withKeys(
      [{ name: 'PAWNEE-12' }, { name: 'PAWNEE-12' }],
      (row) => row.name
    );

    expect(after[0]?.key).toBe(before[0]?.key);
    expect(after[1]?.key).toBe('PAWNEE-12#2');
  });
});
