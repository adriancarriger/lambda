import { sessionStatus } from '../client/sessionStatus';

const leslie = {
  owner: { name: 'Leslie Knope', initials: 'LK' },
  deviceId: 'dev_1',
};

describe('the first screen', () => {
  it('signs in with a session and out without one', () => {
    expect(sessionStatus({ session: leslie })).toEqual({
      kind: 'in',
      session: leslie,
    });
    expect(sessionStatus({ session: null })).toEqual({ kind: 'out' });
  });

  it('says it can’t reach Lambda when the check fails, not "sign in"', () => {
    expect(sessionStatus({ error: new Error('HTTP 500') })).toEqual({
      kind: 'unreachable',
    });
  });
});
