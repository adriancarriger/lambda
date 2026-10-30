import { BADGE_SIZE, type MarkBox, layoutMarks, parseMarks } from '../marks';

const PAGE = { width: 400, height: 300 };

const MARKS = parseMarks(
  JSON.stringify([
    { n: 1, label: "Ann Perkins's closed trail" },
    { n: 2, label: 'Show the detour' },
    { n: 3, label: 'Trails open in Pawnee Parks' },
  ])
);

const box = (mark: string, x: number, y: number): MarkBox => ({
  mark,
  x,
  y,
  width: 80,
  height: 30,
});

describe('layoutMarks', () => {
  it('puts badges at each box top-left and lists only the marks present, in order', () => {
    expect(
      layoutMarks([box('3', 120, 40), box('1', 10, 200)], MARKS, PAGE)
    ).toEqual({
      badges: [
        { n: 1, x: 10, y: 200 },
        { n: 3, x: 120, y: 40 },
      ],
      legend: [
        { n: 1, label: "Ann Perkins's closed trail" },
        { n: 3, label: 'Trails open in Pawnee Parks' },
      ],
    });
  });

  it('clamps a badge inside the page', () => {
    const { badges } = layoutMarks(
      [box('1', -20, -5), box('2', 395, 290)],
      MARKS,
      PAGE
    );

    expect(badges).toEqual([
      { n: 1, x: 0, y: 0 },
      { n: 2, x: PAGE.width - BADGE_SIZE, y: PAGE.height - BADGE_SIZE },
    ]);
  });

  it('lays out nothing for a state with no marks', () => {
    expect(layoutMarks([], MARKS, PAGE)).toEqual({ badges: [], legend: [] });
  });

  it.each([
    ['an unlabelled mark', [box('4', 0, 0)], MARKS, /mark 4/],
    [
      'an 81-character label',
      [box('1', 0, 0)],
      [{ n: 1, label: 'x'.repeat(81) }],
      /mark 1/,
    ],
    ['a duplicate mark', [box('2', 0, 0), box('2', 50, 50)], MARKS, /mark 2/],
    [
      'a zero box',
      [{ mark: '1', x: 5, y: 5, width: 0, height: 30 }],
      MARKS,
      /mark 1/,
    ],
    ['a mark that is not a number', [box('one', 0, 0)], MARKS, /mark "one"/],
  ])('throws on %s, naming the mark', (_label, boxes, marks, pattern) => {
    expect(() => layoutMarks(boxes, marks, PAGE)).toThrow(pattern);
  });
});

describe('parseMarks', () => {
  it.each([
    ['an 81-character label', [{ n: 5, label: 'x'.repeat(81) }], /mark 5/],
    ['an empty label', [{ n: 6, label: '' }], /mark 6/],
    [
      'a number used twice',
      [
        { n: 7, label: 'a' },
        { n: 7, label: 'b' },
      ],
      /mark 7/,
    ],
    ['a non-integer number', [{ n: 1.5, label: 'a' }], /1\.5/],
    ['not a list', { 1: 'a' }, /list/],
  ])('throws on %s', (_label, value, pattern) => {
    expect(() => parseMarks(JSON.stringify(value))).toThrow(pattern);
  });

  it('accepts an 80-character label', () => {
    expect(
      parseMarks(JSON.stringify([{ n: 1, label: 'y'.repeat(80) }]))
    ).toEqual([{ n: 1, label: 'y'.repeat(80) }]);
  });
});
