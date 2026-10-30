import { isTrustPrompt, trustAnswerKey } from '../tmux';

/** Claude Code's folder-trust prompt, as a pod's pane showed it. */
const prompt = (highlighted: 'no' | 'yes'): string =>
  [
    ' Accessing workspace:',
    '',
    ' ~/.lambda/worktrees/pawnee-parks/ice-town-1a2b',
    '',
    ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source',
    " project, or work from your team). If not, take a moment to review what's in this folder first.",
    '',
    " Claude Code'll be able to read, edit, and execute files here.",
    '',
    ' Security guide',
    '',
    highlighted === 'no' ? ' ❯ No, exit' : '   No, exit',
    highlighted === 'yes'
      ? ' ❯ Yes, I trust this folder'
      : '   Yes, I trust this folder',
    '',
    ' Enter to confirm · Esc to cancel',
  ].join('\n');

describe("answering Claude Code's folder-trust prompt", () => {
  it('recognises it', () => {
    expect(isTrustPrompt(prompt('no'))).toBe(true);
    expect(isTrustPrompt(' ❯ \n────────────')).toBe(false);
  });

  it('never presses Enter on "No, exit", which quit every agent', () => {
    expect(trustAnswerKey(prompt('no'))).toBe('Down');
  });

  it('presses Enter once the yes option is highlighted', () => {
    expect(trustAnswerKey(prompt('yes'))).toBe('Enter');
  });
});
