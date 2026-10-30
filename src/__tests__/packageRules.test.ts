import * as fs from 'fs';
import * as path from 'path';

import { VERSION } from '../cli';

const root = path.resolve(__dirname, '..', '..');

const readJson = (file: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));

const record = (value: unknown): Record<string, string> =>
  typeof value === 'object' && value !== null
    ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, String(v)]))
    : {};

const sourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      return sourceFiles(full);
    }

    return entry.name.endsWith('.ts') ? [full] : [];
  });

describe('package rules', () => {
  const pkg = readJson('package.json');
  const scripts = record(pkg.scripts);

  it('is the published Lambda package', () => {
    expect(pkg.name).toBe('@adriancarriger/lambda');
    expect(pkg.version).toBe('0.2.0');
    expect(VERSION).toBe(pkg.version);
    expect(pkg.license).toBe('MIT');
    expect(pkg.bin).toEqual({ lambda: './bin/lambda' });
    expect(scripts).toMatchObject({
      // The CLI and services (tsup), then the app's client (Vite).
      build: 'tsup && vite build',
      lint: "eslint --cache --max-warnings 0 'src/**/*.{ts,tsx}' 'desktop/*.ts' 'scripts/**/*.ts'",
      // The client (DOM), then the Node code on its own, without DOM globals,
      // then the Mac app's main process and the release scripts.
      typecheck:
        'tsc --noEmit && tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p desktop/tsconfig.json && tsc --noEmit -p scripts/tsconfig.json',
      test: 'jest',
    });
  });

  it('names the public repo, which npm checks a provenance publish against', () => {
    // release.yml publishes with --provenance from adriancarriger/lambda;
    // npm refuses it when repository.url names any other repo, or none.
    expect(record(pkg.repository)).toEqual({
      type: 'git',
      url: 'git+https://github.com/adriancarriger/lambda.git',
    });
    expect(pkg.homepage).toBe(
      'https://github.com/adriancarriger/lambda#readme'
    );
    expect(record(pkg.bugs)).toEqual({
      url: 'https://github.com/adriancarriger/lambda/issues',
    });
    // The author is the LICENSE's copyright holder.
    expect(fs.readFileSync(path.join(root, 'LICENSE'), 'utf8')).toContain(
      `Copyright (c) 2026 ${String(pkg.author)}\n`
    );
  });

  it("keeps the original demo in examples/, out of what npm ships", () => {
    expect(fs.existsSync(path.join(root, 'examples', 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'examples', 'package.json'))).toBe(
      true
    );
    expect(Array.isArray(pkg.files) ? pkg.files : []).not.toContain('examples');
  });

  it('depends on nothing in the monorepo', () => {
    const versions = [
      pkg.dependencies,
      pkg.devDependencies,
      pkg.peerDependencies,
    ].flatMap((deps) => Object.entries(record(deps)));

    expect(
      versions.filter(
        ([name, version]) =>
          version.startsWith('workspace:') || name.startsWith('@repo/')
      )
    ).toEqual([]);
  });

  it('never links itself globally', () => {
    expect(
      Object.values(scripts).filter((script) => script.includes('link'))
    ).toEqual([]);
  });

  it('imports nothing from the monorepo', () => {
    const hits = sourceFiles(path.join(root, 'src')).filter((file) =>
      /from '@repo\//.test(fs.readFileSync(file, 'utf8'))
    );

    expect(hits).toEqual([]);
  });

  it('has a standalone tsconfig over src only', () => {
    const tsconfig = readJson('tsconfig.json');

    expect(tsconfig).not.toHaveProperty('extends');
    expect(record(tsconfig.compilerOptions).rootDir).toBe('src');
    expect(tsconfig.include).toEqual(['src']);
  });

  it('ships an await-pane server that runs lambda await', () => {
    const server = fs.readFileSync(
      path.join(root, 'tools', 'await-pane-server.cjs'),
      'utf8'
    );

    expect(server).toContain("execFileSync('lambda'");
  });
});
