import { type GroupEvent, shippingGroups } from '../shared/shippingGroups';

const at = (minute: number) =>
  `2026-10-23T10:${String(minute).padStart(2, '0')}:00.000Z`;

const add = (ticket: string, minute: number): GroupEvent => ({
  type: 'group.add',
  groupId: 'g1',
  ticket,
  at: at(minute),
});

const added = [add('2', 0), add('3', 1), add('4', 2)];

describe('shipping-together groups, from group.* events only', () => {
  it('opens a group as tickets are added', () => {
    expect(shippingGroups(added).open).toEqual([
      {
        id: 'g1',
        tickets: ['2', '3', '4'],
        held: false,
        reason: null,
        state: 'open',
      },
    ]);
  });

  it('follows reason, hold, release and shipping', () => {
    const reason: GroupEvent = {
      type: 'group.reason',
      groupId: 'g1',
      reason: 'Ships when the epic completes, 1 left',
      at: at(3),
    };
    const hold: GroupEvent = {
      type: 'group.hold',
      groupId: 'g1',
      held: true,
      at: at(4),
    };

    expect(shippingGroups([...added, reason]).open[0]?.reason).toBe(
      'Ships when the epic completes, 1 left'
    );
    expect(shippingGroups([...added, reason, hold]).open[0]?.held).toBe(true);
    expect(
      shippingGroups([
        ...added,
        hold,
        { type: 'group.release', groupId: 'g1', at: at(5) },
      ]).open[0]?.held
    ).toBe(false);
    expect(
      shippingGroups([
        ...added,
        { type: 'group.shipping', groupId: 'g1', at: at(6) },
      ]).open[0]?.state
    ).toBe('shipping');
  });

  it('closes on group.shipped and reports its tickets done', () => {
    const result = shippingGroups([
      ...added,
      { type: 'group.shipped', groupId: 'g1', at: at(7) },
    ]);

    expect(result.open).toEqual([]);
    expect(result.shippedTickets).toEqual(['2', '3', '4']);
  });

  it('lists an unknown group type with its line number, changing nothing', () => {
    const result = shippingGroups([
      ...added,
      { type: 'group.frobnicate', groupId: 'g1', at: at(8), line: 4 },
    ]);

    expect(result.unknown).toEqual([{ type: 'group.frobnicate', line: 4 }]);
    expect(result.open).toEqual(shippingGroups(added).open);
  });

  it('has no group without group events', () => {
    expect(shippingGroups([]).open).toEqual([]);
    expect(
      shippingGroups([
        { type: 'stage.start', groupId: 'g1', at: at(0), ticket: '2' },
      ]).open
    ).toEqual([]);
  });

  it('knows whether a ticket is in an open group', () => {
    const result = shippingGroups(added);

    expect(result.groupOf('3')?.id).toBe('g1');
    expect(result.groupOf('9')).toBeUndefined();
  });
});
