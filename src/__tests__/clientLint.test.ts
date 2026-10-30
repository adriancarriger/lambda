import * as path from 'path';

/** What the test needs of ESLint's API (the package ships no types). */
interface ESLintApi {
  ESLint: new (options: { cwd: string }) => {
    lintText: (
      code: string,
      options: { filePath: string }
    ) => Promise<{ messages: { ruleId: string | null; severity: number }[] }[]>;
  };
}

const { ESLint } = jest.requireActual<ESLintApi>('eslint');

const root = path.resolve(__dirname, '..', '..');

/**
 * The rules a line breaks, linted for real as if it were in `file` (an
 * existing file, so the TypeScript project knows it; only the text is new).
 */
const brokenBy = async (code: string, file: string): Promise<string[]> => {
  const results = await new ESLint({ cwd: root }).lintText(`${code}\n`, {
    filePath: path.join(root, file),
  });

  return (
    results
      .flatMap((result) => result.messages)
      .filter((message) => message.severity === 2)
      .map((message) => message.ruleId ?? 'parse error')
      // The core rule and typescript-eslint's are one rule here.
      .map((rule) => rule.replace('@typescript-eslint/', ''))
  );
};

const CLIENT = 'src/app/client/chime.ts';

// Built from parts so packageRules' own "imports nothing from the monorepo"
// scan doesn't take this fixture for a real import.
const MONOREPO_IMPORT = `import { theme } from '${'@re'}po/config';`;

describe('the app’s client, which runs in the browser', () => {
  // Typed linting builds the project once: allow for a cold start.
  jest.setTimeout(60_000);

  it.each([
    ["import * as fs from 'fs';", 'no-restricted-imports'],
    ["import { readFileSync } from 'node:fs';", 'no-restricted-imports'],
    [MONOREPO_IMPORT, 'no-restricted-imports'],
    ['export const port = process.env.PORT;', 'no-restricted-globals'],
    ['export const here = __dirname;', 'no-restricted-globals'],
  ])('refuses %s', async (code, rule) => {
    expect(await brokenBy(code, CLIENT)).toContain(rule);
  });

  it.each([
    "import { podFileRoute } from '../server/podFile';",
    "import { createRelay } from '../../mothership/relay';",
    "import { startRunner } from '../../runner/runtime';",
    "import { openStore } from '../../pod-store';",
  ])('refuses server code: %s', async (code) => {
    expect(await brokenBy(code, CLIENT)).toContain('no-restricted-imports');
  });

  it('lets it share the server’s types', async () => {
    expect(
      await brokenBy(
        "import type { Relay } from '../../mothership/relay';\nimport type { Pod } from '../../pod-store';\nexport type Both = [Relay, Pod];",
        CLIENT
      )
    ).toEqual([]);
  });

  it('leaves the server side its Node', async () => {
    expect(
      await brokenBy(
        "import * as fs from 'fs';\nexport const port = process.env.PORT ?? fs.constants.F_OK;",
        'src/mothership/http.ts'
      )
    ).toEqual([]);
  });

  it('keeps the server standalone too', async () => {
    expect(await brokenBy(MONOREPO_IMPORT, 'src/mothership/http.ts')).toContain(
      'no-restricted-imports'
    );
  });
});
