import { ticket } from '../../building/__tests__/fakes';
import { planningMoves } from '../planningStatus';

/**
 * A planning pod picking a ticket up moves it to Planning: from the Inbox
 * (where every new ticket lands) or from Ready. Anything further along, or
 * closed, is left where it is.
 */

describe('planningMoves', () => {
  it('moves Inbox and Ready tickets, and leaves the rest', () => {
    const { move, leave } = planningMoves([
      ticket('1', { status: 'inbox' }),
      ticket('2', { status: 'ready' }),
      ticket('3', { status: 'planning' }),
      ticket('4', { status: 'building' }),
      ticket('5', { status: 'done' }),
    ]);

    expect(move.map((one) => one.id)).toEqual(['1', '2']);
    // Already in Planning: neither moved nor named.
    expect(leave.map((one) => one.id)).toEqual(['4', '5']);
  });
});
