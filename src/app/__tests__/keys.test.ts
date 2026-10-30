import { toHexBytes } from '../client/keys';
import { toSendKeysCalls } from '../server/keys';

const calls = (typed: string): string[][] => toSendKeysCalls(toHexBytes(typed));

describe('toSendKeysCalls', () => {
  it('sends text raw and Enter as the named key (a raw CR does not submit)', () => {
    expect(calls('ok\r')).toEqual([['-H', '6f', '6b'], ['Enter']]);
  });

  it('maps backspace, tab, ctrl-c and arrows to named keys', () => {
    expect(calls('a\x7f')).toEqual([['-H', '61'], ['BSpace']]);
    expect(calls('\t')).toEqual([['Tab']]);
    expect(calls('\x03')).toEqual([['C-c']]);
    expect(calls('\x1b[A\x1b[D')).toEqual([['Up'], ['Left']]);
  });

  it('treats a lone trailing ESC as the Escape key', () => {
    expect(calls('\x1b')).toEqual([['Escape']]);
  });

  it('keeps multi-byte characters raw', () => {
    expect(calls('é')).toEqual([['-H', 'c3', 'a9']]);
  });
});
