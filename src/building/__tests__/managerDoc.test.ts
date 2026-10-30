import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The building pod's instructions, read as its agents read them: the
 * commands they're told to run must get through the Engineering manager's
 * permission hook, and what they say about who reports what must match what
 * the runner and `lambda ship` do.
 */

const HOOK = path.join(__dirname, '..', 'permission-hook.cjs');

const doc = (name: string): string =>
  fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'instructions', 'building', name),
    'utf8'
  );

const decide = (command: string): string => {
  const out = execFileSync('node', [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8',
  });

  return JSON.parse(out).hookSpecificOutput.decision.behavior;
};

/** Pasted output, as QA prints it: backticks, `$` and an apostrophe. */
const PASTE = [
  '- `listPlots()` ignores `$since` when the filter is empty',
  "- Leslie's waffle count isn't saved",
].join('\n');

describe('the Engineering manager’s instructions', () => {
  it.each([
    ['check-ticket gaps', /`(lambda tmux dev [^`]*QA check-ticket[^`]*)`/],
    ['test failures', /`(lambda tmux dev [^`]*test failures[^`]*)`/],
  ])('word a paste of %s so the hook lets it through', (_, example) => {
    const manager = doc('manager.md');
    const worded = example.exec(manager);
    const rule = /each `'` in it written as `([^`]+)`/.exec(manager);

    if (worded?.[1] === undefined || rule?.[1] === undefined) {
      throw new Error('manager.md no longer words this send.');
    }
    const [, escape] = rule;

    expect(
      decide(worded[1].replace('<paste>', PASTE.split("'").join(escape)))
    ).toBe('allow');
  });

  it('leave Pick-up to the runner and the end of Ship to lambda ship', () => {
    const manager = doc('manager.md');

    expect(manager).toContain('Every step from Build on');
    expect(manager).toContain('The runner reports Pick-up for you');
    expect(manager).toContain('`lambda ship` closes Ship');
  });
});

describe('the Dev’s and QA’s instructions', () => {
  it("don't say lambda ship pushes", () => {
    expect(doc('start.md')).not.toMatch(/commit or push/);
  });

  it('have the Dev update copied patterns before reporting the build done', () => {
    const start = doc('start.md');

    expect(start).toContain('`lambda design system changed`');
    expect(start).toContain('`update the copy`');
    expect(start).toContain('`design-check.md`');
    expect(decide('lambda design system changed')).toBe('allow');
  });

  it('leave the pod id out of the screenshot command, so it survives a /clear', () => {
    const qa = doc('qa.md');

    expect(qa).toContain('lambda pod screenshot <file.png> ');
    expect(qa).not.toMatch(/screenshot (<pod-id>|\$POD_ID)/);
  });
});

describe('the Product manager’s instructions', () => {
  it('cover a conversation about one ticket, answered with lambda pod reply', () => {
    const pm = doc('product-manager.md');
    const section = /## A conversation about one ticket\n([\s\S]*?)\n## /.exec(
      pm
    );

    expect(section?.[1]).toContain('`lambda pod reply --fyi`');
    expect(section?.[1]).toContain('no pod is building this project');
    expect(pm).toContain('If the building pod is paused');
  });
});
