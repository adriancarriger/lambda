import { minutes } from '../client/AnalyticsPage';

describe('Analytics’ times', () => {
  it('says under a minute rather than rounding a short gap up to one', () => {
    expect(minutes(0)).toBe('<1 min');
    expect(minutes(25_000)).toBe('<1 min');
    expect(minutes(59_999)).toBe('<1 min');
  });

  it('rounds a minute or more to whole minutes', () => {
    expect(minutes(60_000)).toBe('1 min');
    expect(minutes(150_000)).toBe('3 min');
    expect(minutes(47 * 60_000)).toBe('47 min');
  });

  it('shows a dash when there is nothing to time (no failed attempt)', () => {
    expect(minutes(null)).toBe('—');
  });
});
