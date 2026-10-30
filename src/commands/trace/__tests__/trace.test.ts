import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  DEFAULT_ERROR_PATTERNS,
  type ErrorPattern,
  buildSummary,
  getDiagnoseResults,
  getTraceDir,
  parseTrace,
  registerTraceCommand,
  withProjectPatterns,
} from '..';

// A failing Pawnee test, recorded once with Playwright: the page logs
// "Budget exceeded: …" to the console, then `page.click('#approve-budget')`
// times out. error-context.md is Playwright's file next to the trace.
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'budget-failure');

const PAWNEE_BUDGET: ErrorPattern = {
  pattern: /Budget exceeded/,
  category: 'Pawnee budget',
  explanation: 'The Parks Department spent more than the festival budget.',
  solution: 'Ask Ron Swanson to approve the overage.',
};

const tmpDirs: string[] = [];

/** Copy the fixture into a temp folder, so unzipping never writes into the repo. */
const copyFixture = (): string => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-trace-'));
  tmpDirs.splice(tmpDirs.length, 0, tmp);
  fs.cpSync(FIXTURE_DIR, tmp, { recursive: true });

  return path.join(tmp, 'trace.zip');
};

const loadFixture = (): ReturnType<typeof parseTrace> =>
  parseTrace(getTraceDir(copyFixture()));

/** Run `lambda trace <args>` through the registered command, capturing stdout. */
const runTrace = async (
  args: string[],
  options: Parameters<typeof registerTraceCommand>[1] = {}
): Promise<string> => {
  const logged: string[] = [];
  const spy = jest
    .spyOn(console, 'log')
    .mockImplementation((...parts: unknown[]) => {
      logged.splice(logged.length, 0, parts.map(String).join(' '));
    });
  const program = new Command();
  registerTraceCommand(program, options);

  try {
    await program.parseAsync(['node', 'lambda', 'trace', ...args]);
  } finally {
    spy.mockRestore();
  }

  return logged.join('\n');
};

afterAll(() => {
  tmpDirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

describe('lambda trace', () => {
  it('summary names the failed action, the console error and the screenshot', () => {
    const summary = buildSummary(loadFixture());

    expect(summary.status).toBe('failed');
    expect(summary.failedAction?.apiName).toMatch(/click/i);
    expect(summary.failedAction?.error).toContain('Timeout 1500ms exceeded');
    expect(summary.consoleErrors).toEqual([
      'Budget exceeded: Harvest Festival is over by $500',
    ]);
    expect(summary.screenshot).toMatch(/resources\/page@.+\.jpeg$/);
    expect(summary.screenshot && fs.existsSync(summary.screenshot)).toBe(true);
  });

  it("diagnose reports a project's extra pattern", () => {
    const results = getDiagnoseResults(loadFixture(), {
      patterns: [...DEFAULT_ERROR_PATTERNS, PAWNEE_BUDGET],
    });

    expect(results.byCategory['Pawnee budget']).toBe(1);
    expect(results.issues).toContainEqual(
      expect.objectContaining({
        category: 'Pawnee budget',
        source: 'console',
        solution: 'Ask Ron Swanson to approve the overage.',
      })
    );
  });

  it('diagnose without the extra pattern does not report it', () => {
    const results = getDiagnoseResults(loadFixture());

    expect(results.byCategory['Pawnee budget']).toBeUndefined();
    // The failed click still shows up, from error-context.md.
    expect(results.byCategory['Test Assertion Failed']).toBe(1);
  });

  it("trace diagnose reports a project's extraPatterns", async () => {
    const output = await runTrace(['diagnose', copyFixture()], {
      extraPatterns: [PAWNEE_BUDGET],
    });

    expect(output).toContain('Pawnee budget');
    expect(output).toContain('Ask Ron Swanson to approve the overage.');
  });

  it('trace diagnose without extraPatterns does not report them', async () => {
    const output = await runTrace(['diagnose', copyFixture()]);

    expect(output).not.toContain('Pawnee budget');
  });

  it('trace errors prints the timed-out click', async () => {
    const output = await runTrace(['errors', copyFixture()]);

    expect(output).toContain('Timeout 1500ms exceeded');
  });

  it('a failed unzip leaves no unzipped/ cache behind', () => {
    const zip = copyFixture();
    fs.writeFileSync(zip, 'not a zip');

    expect(() => getTraceDir(zip)).toThrow();
    expect(fs.readdirSync(path.dirname(zip))).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^unzip/)])
    );
  });

  it('unzips a path the shell would read', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-trace-'));
    tmpDirs.splice(tmpDirs.length, 0, tmp);
    const dir = path.join(tmp, 'budget "$(touch pwned)"');
    fs.cpSync(FIXTURE_DIR, dir, { recursive: true });

    expect(parseTrace(getTraceDir(path.join(dir, 'trace.zip'))).tracePath).toBe(
      path.join(dir, 'unzipped')
    );
    expect(fs.existsSync(path.join(process.cwd(), 'pwned'))).toBe(false);
  });

  it('a Permission Denied trace is critical', () => {
    const zip = copyFixture();
    fs.rmSync(path.join(path.dirname(zip), 'error-context.md'));
    const ctx = parseTrace(getTraceDir(zip));
    const [first] = ctx.consoleMessages;

    if (first === undefined) {
      throw new Error('The fixture has no console message');
    }

    const results = getDiagnoseResults({
      ...ctx,
      errors: [],
      consoleMessages: [
        { ...first, text: 'Permission denied: trail map edits' },
      ],
    });

    expect(results.byCategory).toEqual({ 'Permission Denied': 1 });
    expect(results.summary).toMatch(/^🚨 CRITICAL ISSUES FOUND/);
  });

  it('registers trace with its subcommands', () => {
    const program = new Command();
    registerTraceCommand(program, { extraPatterns: [PAWNEE_BUDGET] });

    const trace = program.commands.find(
      (command) => command.name() === 'trace'
    );
    const names = trace?.commands.map((command) => command.name()) ?? [];

    expect(names).toEqual([
      'summary',
      'errors',
      'actions',
      'screenshots',
      'screenshot',
      'console',
      'around',
      'timeline',
      'diagnose',
      'diagnose-all',
    ]);
  });

  it('has the generic patterns, specific ones first', () => {
    expect(DEFAULT_ERROR_PATTERNS.map((entry) => entry.category)).toEqual([
      'Permission Denied',
      'Auth Error',
      'Timeout',
      'HTTP 4xx Error',
      'HTTP 5xx Error',
      'UI Error',
      'Unhandled Exception',
      'Connection Error',
    ]);
  });

  it.each([
    ['Permission denied: trail map edits', 'Permission Denied'],
    ['GET /trails/48 403 Forbidden', 'Permission Denied'],
    ['Unauthorized: sign in to edit the festival board', 'Auth Error'],
    [
      'Failed to load resource: the server responded with a status of 404',
      'HTTP 4xx Error',
    ],
    ['Something went wrong loading the bench list', 'UI Error'],
    ['connect ECONNREFUSED 127.0.0.1:3000', 'Connection Error'],
  ])('%s is a %s', (text, category) => {
    expect(
      DEFAULT_ERROR_PATTERNS.find((entry) => entry.pattern.test(text))?.category
    ).toBe(category);
  });

  describe("lambda.json's trace.patterns", () => {
    const BUDGET_LOG = {
      pattern: 'BUDGET OVER (\\w+)',
      flags: 'i',
      category: 'Budget Over',
      explanation: 'A park spent past its budget.',
      solution: 'Ask Ron Swanson.',
    };
    const categories = (patterns: ErrorPattern[]): string[] =>
      patterns.map((entry) => entry.category);

    it('puts one ahead of its before category, and the rest at the end', () => {
      const placed = withProjectPatterns(DEFAULT_ERROR_PATTERNS, [
        { ...BUDGET_LOG, before: 'Permission Denied' },
        { ...BUDGET_LOG, category: 'Late Budget' },
        { ...BUDGET_LOG, category: 'Budget Two', before: 'Permission Denied' },
      ]);

      expect(categories(placed).slice(0, 3)).toEqual([
        'Budget Over',
        'Budget Two',
        'Permission Denied',
      ]);
      expect(categories(placed).at(-1)).toBe('Late Budget');
      expect(placed).toHaveLength(DEFAULT_ERROR_PATTERNS.length + 3);
    });

    it('claims text a later built-in pattern would have, when placed before it', () => {
      const placed = withProjectPatterns(DEFAULT_ERROR_PATTERNS, [
        { ...BUDGET_LOG, before: 'Permission Denied' },
      ]);
      const text = 'BUDGET OVER lot48: permission denied';

      expect(placed.find((entry) => entry.pattern.test(text))?.category).toBe(
        'Budget Over'
      );
      expect(
        DEFAULT_ERROR_PATTERNS.find((entry) => entry.pattern.test(text))
          ?.category
      ).toBe('Permission Denied');
    });

    it('refuses a before that no pattern has', () => {
      expect(() =>
        withProjectPatterns(DEFAULT_ERROR_PATTERNS, [
          { ...BUDGET_LOG, before: 'Raccoon Error' },
        ])
      ).toThrow(
        'lambda.json trace.patterns: "Budget Over" goes before "Raccoon Error", and no pattern has that category.'
      );
    });

    it('reaches trace diagnose from the project folder', async () => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), 'lambda-trace-project-')
      );
      tmpDirs.splice(tmpDirs.length, 0, root);
      fs.writeFileSync(
        path.join(root, 'lambda.json'),
        JSON.stringify({
          trace: {
            patterns: [
              {
                pattern: 'Budget exceeded',
                category: 'Festival budget',
                explanation: 'The festival spent past its budget.',
                solution: 'Ask Chris Traeger.',
                before: 'Permission Denied',
              },
            ],
          },
        })
      );

      const output = await runTrace(['diagnose', copyFixture()], { cwd: root });

      expect(output).toContain('Festival budget');
      expect(output).toContain('Ask Chris Traeger.');
    });

    it("leaves Lambda's own patterns out with builtIn: false", async () => {
      const projectWith = (trace: object): string => {
        const root = fs.mkdtempSync(
          path.join(os.tmpdir(), 'lambda-trace-project-')
        );
        tmpDirs.splice(tmpDirs.length, 0, root);
        fs.writeFileSync(
          path.join(root, 'lambda.json'),
          JSON.stringify({ trace })
        );

        return root;
      };
      const traceDir = (): string =>
        fixtureWithLines([
          {
            type: 'event',
            time: 1,
            class: 'Page',
            method: 'pageError',
            params: {
              error: { value: 'Something went wrong on the trail map' },
            },
          },
        ]);

      expect(
        await runTrace(['diagnose', traceDir()], { cwd: projectWith({}) })
      ).toContain('UI Error');

      const own = await runTrace(['diagnose', traceDir()], {
        cwd: projectWith({
          builtIn: false,
          patterns: [
            {
              ...BUDGET_LOG,
              pattern: 'Budget exceeded',
              category: 'Festival budget',
            },
          ],
        }),
      });

      expect(own).not.toContain('UI Error');
      expect(own).toContain('Festival budget');
    });
  });

  /** The fixture's trace folder, with `lines` appended to its first browser trace. */
  const fixtureWithLines = (lines: unknown[]): string => {
    const traceDir = getTraceDir(copyFixture());
    const [browserFile] = fs
      .readdirSync(traceDir)
      .filter((file) => /^\d+-trace\.trace$/.test(file))
      .sort();

    if (browserFile === undefined) {
      throw new Error('The fixture has no browser trace');
    }

    fs.appendFileSync(
      path.join(traceDir, browserFile),
      lines.map((line) => `\n${JSON.stringify(line)}`).join('')
    );

    return traceDir;
  };

  it('keeps a page error thrown as a plain value, with that value as its message', async () => {
    const traceDir = fixtureWithLines([
      {
        type: 'event',
        time: 1,
        class: 'Page',
        method: 'pageError',
        params: { error: { value: 'Lot 48 is still a pit' } },
      },
    ]);
    const ctx = parseTrace(traceDir);

    expect(ctx.errors).toHaveLength(1);
    expect(await runTrace(['timeline', traceDir])).toContain(
      'Lot 48 is still a pit'
    );
    expect(await runTrace(['errors', traceDir])).toContain(
      'Lot 48 is still a pit'
    );
  });

  it('reports a line of a known kind that it cannot read, and still reads the rest', () => {
    const traceDir = fixtureWithLines([
      { type: 'event', time: 'noon', method: 'pageError' },
    ]);
    const reported: string[] = [];
    const spy = jest
      .spyOn(console, 'error')
      .mockImplementation((...parts: unknown[]) => {
        reported.splice(reported.length, 0, parts.map(String).join(' '));
      });

    try {
      const ctx = parseTrace(traceDir);

      expect(ctx.consoleMessages.length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }

    expect(reported.join('\n')).toMatch(/"event" line[\s\S]*noon/);
  });
});
