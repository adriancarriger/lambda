import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { fillInstructions } from '../instructions';
import { resolveInstructions } from '../workflow-file';

const instructionsDir = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'instructions'
);

const files = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);

    return entry.isDirectory() ? files(full) : [full];
  });

/**
 * A backticked span that reads like a command: a word, then another word or
 * a flag (`lambda pod done`, `git diff`, `done --found <n>`).
 */
const COMMAND = /^([a-z][\w.-]*) (?:[a-z]|-)/;

/** A line's backticked spans: every other piece between backticks. */
const spans = (line: string): string[] =>
  line.split('`').filter((_, index) => index % 2 === 1);

/** Plain shell commands the instructions use, beside lambda. */
const SHELL = ['git', 'ps', 'claude'];

/** The tail of a lambda command named just before it (`… done --found`). */
const LAMBDA_TAILS = [
  'build',
  'checkpoint',
  'done',
  'manifest',
  'reply',
  'round',
  'skip',
];

/** Labels quoted from Lambda's own output, not commands. */
const LABELS = ['rebuild only', 'update the copy'];

const OWN = ['lambda', ...SHELL, ...LAMBDA_TAILS];

describe('the plain instructions', () => {
  it('fills {owner} with the owner name', () => {
    expect(
      fillInstructions('Ask {owner} first.', { owner: 'Leslie Knope' })
    ).toBe('Ask Leslie Knope first.');
    expect(
      fillInstructions('{owner} closes it; {owner} decides.', { owner: 'Ann' })
    ).toBe('Ann closes it; Ann decides.');
  });

  it('ships the planning and building copies', () => {
    const names = files(instructionsDir).map((file) =>
      path.relative(instructionsDir, file)
    );

    expect(names.sort()).toEqual(
      [
        'building/check-ticket.md',
        'building/code-review.md',
        'building/design-check.md',
        'building/design-system-setup.md',
        'building/manager.md',
        'building/product-manager.md',
        'building/qa.md',
        'building/ship.md',
        'building/start.md',
        'building/visual-check.md',
        'design/visual-severity.md',
        'planning/design-screen.md',
        'planning/dev.md',
        'planning/manager.md',
        'planning/pod-phase.md',
        'planning/reconcile-tickets.md',
        'planning/red-flags.md',
        'planning/review-ticket.md',
        'planning/split-ticket.md',
        'planning/ux-sketch.md',
      ].sort()
    );
  });

  it('starts every backticked command with lambda', () => {
    const hits = files(instructionsDir).flatMap((file) =>
      fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, index) =>
          spans(line)
            .filter((span) => {
              const first = COMMAND.exec(span)?.[1];

              return (
                first !== undefined &&
                !OWN.includes(first) &&
                !LABELS.some((label) => span.startsWith(label))
              );
            })
            .map(
              (span) =>
                `${path.relative(instructionsDir, file)}:${index + 1}: ${span}`
            )
        )
    );

    expect(hits).toEqual([]);
  });


  it("finds design-screen as Lambda's, or the codebase's .lambda/planning/design-screen.md when it has one", () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'pawnee-parks-'))
    );

    expect(resolveInstructions(root, 'planning', 'design-screen')).toBe(
      path.join(instructionsDir, 'planning', 'design-screen.md')
    );

    const own = path.join(root, '.lambda', 'planning', 'design-screen.md');
    fs.mkdirSync(path.dirname(own), { recursive: true });
    fs.writeFileSync(own, '# Pawnee designs its own way\n');

    expect(resolveInstructions(root, 'planning', 'design-screen')).toBe(own);
  });

  /** Every line of every instruction file, as `<file>:<line>: <text>`. */
  const lines = (): string[] =>
    files(instructionsDir).flatMap((file) =>
      fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .map(
          (line, index) =>
            `${path.relative(instructionsDir, file)}:${index + 1}: ${line}`
        )
    );

  // `origin/HEAD` exists only after a `git clone`; without a fallback the
  // base expands to nothing and the diff shows unstaged changes only.
  it('finds the diff base with a fallback, never origin/HEAD alone', () => {
    const bare = lines().filter(
      (line) =>
        line.includes('origin/HEAD') &&
        !line.includes('git rev-list --max-parents=0')
    );

    expect(bare).toEqual([]);
  });

  it('lists staged changes wherever it lists the branch diff', () => {
    const withBase = files(instructionsDir).filter((file) =>
      fs.readFileSync(file, 'utf8').includes('BASE=')
    );

    expect(withBase.map((file) => path.basename(file)).sort()).toEqual([
      'check-ticket.md',
      'code-review.md',
      'qa.md',
    ]);
    withBase.forEach((file) =>
      expect(fs.readFileSync(file, 'utf8')).toContain('git diff --cached')
    );

    const snippets = withBase.map(
      (file) =>
        fs.readFileSync(file, 'utf8').match(/```bash\nBASE=[\s\S]*?```/)?.[0]
    );

    expect(new Set(snippets).size).toBe(1);
  });

  it('gives every lambda tickets create the title it requires', () => {
    const missing = lines().filter((line) =>
      (line.match(/`lambda tickets create[^`]*`/g) ?? []).some(
        (command) => !command.includes('--title')
      )
    );

    expect(missing).toEqual([]);
  });

  it('asks for made-up data, not one show’s characters', () => {
    expect(
      lines().filter((line) => /Fictional data from Parks and Rec/.test(line))
    ).toEqual([]);
  });

  // Without a limit a test that never passes keeps the step reporting, so the
  // stall check never fires and the pod builds that one ticket forever.
  it('limits Test to 10 attempts, then blocks', () => {
    const manager = fs.readFileSync(
      path.join(instructionsDir, 'building', 'manager.md'),
      'utf8'
    );

    expect(manager).toContain('Max 10 test attempts, then Step 9.');
    expect(manager).toContain('10 failed test attempts');
    expect(manager).toMatch(/\| Test \(QA\) +\| 10 attempts \|/);
  });

  // Step 9 also comments what was tried and moves on to the next ticket; a
  // visual block that skips it leaves the manager waiting on the owner.
  it('sends a BLOCKED visual check through Step 9', () => {
    const manager = fs.readFileSync(
      path.join(instructionsDir, 'building', 'manager.md'),
      'utf8'
    );

    expect(manager).toMatch(
      /\*\*`VISUAL: BLOCKED`\*\* → Step 9, blocking with `lambda pod blocked <id> --visual`/
    );
  });

  it('records a verdict with lambda verdict record only', () => {
    const checkTicket = fs.readFileSync(
      path.join(instructionsDir, 'building', 'check-ticket.md'),
      'utf8'
    );

    expect(checkTicket).toContain('lambda verdict record');
  });
});
