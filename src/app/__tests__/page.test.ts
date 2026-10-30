import { accountPageOf, pageOfRoute } from '../client/page';

describe('the one page on screen', () => {
  it('is the page a URL names, or none for the inbox and a Lambda', () => {
    expect(pageOfRoute({ page: 'new' })).toBe('new');
    expect(pageOfRoute({ page: 'time' })).toBe('time');
    expect(pageOfRoute({ page: 'tickets' })).toBe('tickets');
    expect(pageOfRoute({ page: 'account', which: 'settings/process' })).toBe(
      'settings/process'
    );
    expect(pageOfRoute({ page: 'auto' })).toBeNull();
    expect(pageOfRoute({ page: 'lambda', lambda: 'dog-park-map' })).toBeNull();
  });

  it('names an account page only for one of the account menu’s', () => {
    expect(accountPageOf('computers')).toBe('computers');
    expect(accountPageOf('settings/devices')).toBe('settings/devices');
    expect(accountPageOf('time')).toBeNull();
    expect(accountPageOf('new')).toBeNull();
    expect(accountPageOf(null)).toBeNull();
  });
});
