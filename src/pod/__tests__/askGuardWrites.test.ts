import { askGuardDecision, productManagerGuardDecision } from '../askGuard';

describe("the Product manager's own message text is not a write option", () => {
  it.each([
    'lambda pod reply --fyi "rerun rg with --pre off"',
    'lambda pod ask dev "does git diff --output=x write a file?"',
    'lambda pod relay dev "try --hostname-bin=x"',
  ])('allows %s', (command) => {
    expect(productManagerGuardDecision('Bash', { command })).toBe('allow');
  });

  it.each(['git diff --output=x', 'git log --output notes.txt'])(
    'still denies %s',
    (command) => {
      expect(productManagerGuardDecision('Bash', { command })).toBe('deny');
    }
  );

  it('an ask fork still may not run rg --pre', () => {
    expect(askGuardDecision('Bash', { command: 'rg --pre x foo' })).toBe(
      'deny'
    );
  });
});

describe("rg's --hostname-bin runs a program", () => {
  it.each(['rg --hostname-bin=x pin src', 'rg --hostname-bin x pin src'])(
    'an ask fork may not run %s',
    (command) => {
      expect(askGuardDecision('Bash', { command })).toBe('deny');
    }
  );
});
