import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';

const PACKAGE = path.resolve(__dirname, '..', '..');

const read = (file: string): string =>
  fs.readFileSync(path.join(PACKAGE, file), 'utf8');

/** A YAML file as plain data; the shape each test reads is checked there. */
const yamlOf = (file: string): Record<string, unknown> => {
  const parsed: unknown = parse(read(file));

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${file} isn't a YAML map`);
  }

  return Object.fromEntries(Object.entries(parsed));
};

const field = (value: unknown, ...keys: string[]): unknown =>
  keys.reduce<unknown>(
    (at, key) =>
      typeof at === 'object' && at !== null ? Reflect.get(at, key) : undefined,
    value
  );

/** A job's `run:` lines, in order. */
const runsOf = (workflow: Record<string, unknown>, job: string): string[] => {
  const steps = field(workflow, 'jobs', job, 'steps');

  return Array.isArray(steps)
    ? steps
        .map((step: unknown) => field(step, 'run'))
        .filter((run): run is string => typeof run === 'string')
    : [];
};

/** A job's steps, as plain data. */
const stepsOf = (workflow: Record<string, unknown>, job: string): unknown[] => {
  const steps = field(workflow, 'jobs', job, 'steps');

  return Array.isArray(steps) ? steps : [];
};

/** Every job's name. */
const jobsOf = (workflow: Record<string, unknown>): string[] => {
  const jobs = field(workflow, 'jobs');

  return typeof jobs === 'object' && jobs !== null ? Object.keys(jobs) : [];
};

/** Index of the first `run:` containing `text`; -1 when none does. */
const stepIndex = (runs: string[], text: string): number =>
  runs.findIndex((run) => run.includes(text));

describe('the release workflow', () => {
  const release = yamlOf('.github/workflows/release.yml');

  it('publishes to npm only after the Mac app has built, so a failed build leaves nothing half-released', () => {
    const build = runsOf(release, 'build');

    expect(stepIndex(build, 'desktop/tools/package-mac.sh')).toBeGreaterThan(
      -1
    );
    expect(field(release, 'jobs', 'publish', 'needs')).toEqual(
      expect.arrayContaining(['build'])
    );
  });

  // Environment secrets reach only jobs that name the environment: without
  // it the Apple secrets are empty and every release ships ad-hoc signed.
  it('builds and tests in the release environment, with no id-token, and hands on only its artifacts', () => {
    const runs = runsOf(release, 'build');

    expect(field(release, 'jobs', 'build', 'environment')).toBe('release');
    expect(field(release, 'jobs', 'build', 'permissions')).toEqual({
      contents: 'read',
    });
    expect(stepIndex(runs, 'npm test')).toBeGreaterThan(-1);
    expect(stepIndex(runs, 'npm pack')).toBeGreaterThan(-1);
    expect(
      stepsOf(release, 'build').filter((step) =>
        String(field(step, 'uses')).startsWith('actions/upload-artifact@')
      )
    ).toHaveLength(2);
  });

  // The step's only download (package-mac.sh's rebuild for Node) runs after
  // the key file is deleted, with the secrets unset (packageMac.test.ts).
  it('gives the Apple secrets only to the packaging step, which installs nothing itself', () => {
    const secretSteps = jobsOf(release).flatMap((job) => {
      expect(
        JSON.stringify(field(release, 'jobs', job, 'env') ?? {})
      ).not.toContain('secrets.');

      return stepsOf(release, job).filter((step) =>
        JSON.stringify(field(step, 'env') ?? {}).includes('secrets.APPLE')
      );
    });

    expect(secretSteps).toHaveLength(1);
    const run = String(field(secretSteps[0], 'run'));

    expect(run).toContain('desktop/tools/package-mac.sh');
    expect(run).not.toMatch(/npm (ci|install)|fetch-tools\.sh|build:desktop/);
    // Native modules are rebuilt for Electron in an earlier step, with no
    // secrets, and the decoded notarisation key doesn't outlive the step.
    expect(run).toContain('-c.npmRebuild=false');
    expect(run).toMatch(/trap 'rm -f "\$\{APPLE_API_KEY\}"' EXIT/);
    const runs = runsOf(release, 'build');
    const rebuild = stepIndex(runs, 'electron-builder install-app-deps');

    expect(rebuild).toBeGreaterThan(-1);
    expect(rebuild).toBeLessThan(
      stepIndex(runs, 'desktop/tools/package-mac.sh')
    );
  });

  it('only downloads and publishes in the job that can mint an id-token', () => {
    const runs = runsOf(release, 'publish').join('\n');

    expect(runs).not.toMatch(/npm (ci|test|run|pack)|npm install (?!-g npm)/);
    expect(
      stepsOf(release, 'publish').some((step) =>
        String(field(step, 'uses')).startsWith('actions/download-artifact@')
      )
    ).toBe(true);
    expect(
      stepsOf(release, 'publish').some((step) =>
        String(field(step, 'uses')).startsWith('actions/checkout@')
      )
    ).toBe(false);
    expect(runs).toMatch(
      /npm publish "\$\{TARBALL\}" --provenance --access public --ignore-scripts/
    );
  });

  it('drafts the Release before npm publish and publishes it after, so a failure in between can be rerun', () => {
    const runs = runsOf(release, 'publish');
    const draft = runs.findIndex(
      (run) => run.includes('gh release create') && run.includes('--draft')
    );
    const publish = stepIndex(runs, 'npm publish');
    const undraft = stepIndex(runs, 'gh release edit');

    expect(draft).toBeGreaterThan(-1);
    expect(publish).toBeGreaterThan(draft);
    expect(undraft).toBeGreaterThan(publish);
    expect(runs[undraft]).toContain('--draft=false');
    // A rerun finds the draft and the npm version already there.
    expect(runs[draft]).toContain('gh release view');
    expect(runs[publish]).toContain('npm view');
  });

  it.each(['release.yml', 'ci.yml'])(
    '%s pins every action to a full commit SHA',
    (file) => {
      const workflow = yamlOf(`.github/workflows/${file}`);
      const uses = jobsOf(workflow).flatMap((job) =>
        stepsOf(workflow, job)
          .map((step) => field(step, 'uses'))
          .filter((use): use is string => typeof use === 'string')
      );

      expect(uses.length).toBeGreaterThan(0);
      uses.forEach((use) =>
        expect(use).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/)
      );
    }
  );

  it('builds through package-mac.sh, which ad-hoc signs and verifies, never switching signing off', () => {
    const text = read('.github/workflows/release.yml');

    expect(text).not.toContain('CSC_IDENTITY_AUTO_DISCOVERY');
    expect(text).not.toContain('npx electron-builder');
  });

  it('installs from the lockfiles', () => {
    const runs = runsOf(release, 'build');

    expect(runs).toEqual(
      expect.arrayContaining([
        'npm ci --no-audit --no-fund',
        expect.stringContaining(
          'npm ci --prefix desktop/kokoro --omit=dev --no-audit --no-fund'
        ),
      ])
    );
    expect(runs.join('\n')).not.toMatch(/npm install (?!-g npm)/);
    expect(fs.existsSync(path.join(PACKAGE, 'package-lock.json'))).toBe(true);
    expect(
      fs.existsSync(
        path.join(PACKAGE, 'desktop', 'kokoro', 'package-lock.json')
      )
    ).toBe(true);
  });

  it('publishes only from the release environment, only when the version is new', () => {
    expect(field(release, 'jobs', 'publish', 'environment')).toBe('release');
    expect(field(release, 'jobs', 'publish', 'permissions', 'id-token')).toBe(
      'write'
    );
    expect(field(release, 'jobs', 'publish', 'needs')).toEqual([
      'version',
      'build',
    ]);
    expect(field(release, 'jobs', 'publish', 'if')).toBe(
      "needs.version.outputs.publish == 'true'"
    );
  });

  it('asks no approval for the version check: it has no environment', () => {
    expect(field(release, 'jobs', 'version', 'environment')).toBeUndefined();
    expect(field(release, 'jobs', 'version', 'runs-on')).toBe('ubuntu-latest');
  });

  it('carries no npm token, anywhere', () => {
    const text = [
      read('.github/workflows/release.yml'),
      read('.github/workflows/ci.yml'),
    ].join('\n');

    expect(text).not.toContain('NPM_TOKEN');
    expect(text).not.toContain('NODE_AUTH_TOKEN');
  });

  it('publishes with provenance on npm 11.5.1 or later', () => {
    const text = read('.github/workflows/release.yml');

    expect(text).toContain('npm install -g npm@^11.5.1');
    expect(text).toContain('--provenance --access public');
  });
});

describe('the CI workflow', () => {
  it('builds, lints, typechecks and tests on push and pull request', () => {
    const ci = yamlOf('.github/workflows/ci.yml');
    const steps = field(ci, 'jobs', 'check', 'steps');
    const runs = Array.isArray(steps)
      ? steps.map((step: unknown) => field(step, 'run')).filter(Boolean)
      : [];

    const on = field(ci, 'on');

    expect(
      Object.keys(typeof on === 'object' && on !== null ? on : {}).sort()
    ).toEqual(['pull_request', 'push']);
    expect(runs).toEqual(
      expect.arrayContaining([
        'npm run build',
        'npm run lint',
        'npm run typecheck',
        'npm test',
      ])
    );
  });

  // Some tests start a real Chromium, and some a real tmux server: both
  // workflows need them before `npm test`, or every run is red.
  it.each([
    ['ci.yml', 'check'],
    ['release.yml', 'build'],
  ])('%s installs Chromium and tmux before npm test', (file, job) => {
    const runs = runsOf(yamlOf(`.github/workflows/${file}`), job);
    const test = stepIndex(runs, 'npm test');
    const chromium = stepIndex(runs, 'playwright install --with-deps chromium');
    const tmux = runs.findIndex((run) =>
      /\b(apt-get install -y|brew install) tmux\b/.test(run)
    );

    expect(chromium).toBeGreaterThan(-1);
    expect(chromium).toBeLessThan(test);
    expect(tmux).toBeGreaterThan(-1);
    expect(tmux).toBeLessThan(test);
  });
});

describe('electron-builder.yml', () => {
  const builder = yamlOf('desktop/electron-builder.yml');

  it('builds a dmg and a zip for arm64', () => {
    const targets = field(builder, 'mac', 'target');

    expect(
      Array.isArray(targets)
        ? targets.map((target: unknown) => ({
            target: field(target, 'target'),
            arch: field(target, 'arch'),
          }))
        : []
    ).toEqual([
      { target: 'dmg', arch: ['arm64'] },
      { target: 'zip', arch: ['arm64'] },
    ]);
  });

  // Everything nested in the app (Electron's helpers, the pty's
  // spawn-helper, tmux, git) is signed with the inherit file: only what the
  // helpers need, never the main process's unsigned executable memory.
  it('signs what the app carries with a narrower inherit file than the app', () => {
    const inherit = field(builder, 'mac', 'entitlementsInherit');

    expect(inherit).toBe('desktop/build/entitlements.mac.inherit.plist');
    expect(inherit).not.toBe(field(builder, 'mac', 'entitlements'));

    const keys = [
      ...read(String(inherit)).matchAll(/<key>([^<]+)<\/key>/g),
    ].map((match) => match[1]);

    expect(keys).toEqual([
      'com.apple.security.cs.allow-jit',
      'com.apple.security.cs.disable-library-validation',
    ]);
  });

  it("unpacks Kokoro's worker, the pty and the tools from app.asar", () => {
    expect(builder.asarUnpack).toEqual(
      expect.arrayContaining([
        'dist/kokoroWorker.js',
        'node_modules/@lydell/node-pty/**',
        'tools/**',
      ])
    );
  });
});
