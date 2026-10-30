import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const PACKAGE = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(PACKAGE, 'desktop', 'tools', 'package-mac.sh');

const BUILDER =
  'electron-builder --config desktop/electron-builder.yml --mac --arm64 --publish never';
const AD_HOC = `${BUILDER} -c.mac.identity=-`;
const VERIFY =
  'codesign --verify --deep --strict desktop/release/mac-arm64/Lambda.app';

/** Stub electron-builder, codesign and the rebuild step; each notes when it ran. */
const run = (
  builderStatus: number,
  options: {
    rebuildStatus?: number;
    verifyStatus?: number;
    env?: NodeJS.ProcessEnv;
    /** A file the rebuild step reports on, if it still exists then. */
    keyFile?: string;
  } = {}
) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-package-mac-'));
  const log = path.join(dir, 'log');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'electron-builder'),
    `#!/bin/sh\necho "electron-builder $*" >> "${log}"\nexit ${builderStatus}\n`,
    { mode: 0o755 }
  );
  fs.writeFileSync(
    path.join(bin, 'codesign'),
    `#!/bin/sh\necho "codesign $*" >> "${log}"\nexit ${
      options.verifyStatus ?? 0
    }\n`,
    { mode: 0o755 }
  );
  const rebuild = path.join(dir, 'rebuild.sh');
  const keyFile = options.keyFile ?? '';
  fs.writeFileSync(
    rebuild,
    `echo rebuild >> "${log}"\necho "\${CSC_LINK:-}\${CSC_KEY_PASSWORD:-}\${APPLE_API_KEY:-}\${APPLE_API_KEY_ID:-}\${APPLE_API_ISSUER:-}" > "${log}.secrets"\nif [ -n "${keyFile}" ] && [ -e "${keyFile}" ]; then echo present > "${log}.key"; fi\nexit ${
      options.rebuildStatus ?? 0
    }\n`
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    LAMBDA_REBUILD_FOR_NODE: rebuild,
    ...(options.env ?? {}),
  };

  if (options.env?.CSC_LINK === undefined) {
    delete env.CSC_LINK;
  }

  const result = spawnSync('bash', [SCRIPT], {
    cwd: PACKAGE,
    env,
    encoding: 'utf8',
  });

  return {
    status: result.status,
    keySeenByRebuild: fs.existsSync(`${log}.key`),
    rebuildSecrets: fs.existsSync(`${log}.secrets`)
      ? fs.readFileSync(`${log}.secrets`, 'utf8').trim()
      : undefined,
    log: fs.existsSync(log)
      ? fs.readFileSync(log, 'utf8').trim().split('\n')
      : [],
  };
};

describe("build:mac's last step", () => {
  it('ad-hoc signs a build with no Developer ID, verifies it, then rebuilds better-sqlite3 for Node', () => {
    expect(run(0)).toMatchObject({
      status: 0,
      log: [AD_HOC, VERIFY, 'rebuild'],
    });
  });

  it('leaves signing to electron-builder when a Developer ID certificate is given', () => {
    expect(run(0, { env: { CSC_LINK: 'certificate.p12' } }).log).toEqual([
      BUILDER,
      VERIFY,
      'rebuild',
    ]);
  });

  // The rebuild runs better-sqlite3's install step, which downloads.
  it('rebuilds for Node with none of the Apple secrets in its environment', () => {
    const signed = run(0, {
      env: {
        CSC_LINK: 'certificate.p12',
        CSC_KEY_PASSWORD: 'pawnee',
        // The script deletes this file: a path that can't exist.
        APPLE_API_KEY: '/nonexistent-lambda-test/key.p8',
        APPLE_API_KEY_ID: 'KEY',
        APPLE_API_ISSUER: 'ISSUER',
      },
    });

    expect(signed.log).toContain('rebuild');
    expect(signed.rebuildSecrets).toBe('');
  });

  it('deletes the decoded notarisation key before the rebuild runs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-p8-'));
    const key = path.join(dir, 'apple-api-key.p8');
    fs.writeFileSync(key, 'not a real key');

    try {
      const signed = run(0, {
        env: { CSC_LINK: 'certificate.p12', APPLE_API_KEY: key },
        keyFile: key,
      });

      expect(signed.log).toContain('rebuild');
      expect(signed.keySeenByRebuild).toBe(false);
      expect(fs.existsSync(key)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when the built app does not verify, and still rebuilds for Node', () => {
    expect(run(0, { verifyStatus: 1 })).toMatchObject({
      status: 1,
      log: [AD_HOC, VERIFY, 'rebuild'],
    });
  });

  it('still rebuilds for Node when electron-builder fails, and fails with it', () => {
    expect(run(3)).toMatchObject({
      status: 3,
      log: [AD_HOC, 'rebuild'],
    });
  });

  it('fails when the rebuild for Node fails', () => {
    expect(run(0, { rebuildStatus: 1 }).status).toBe(1);
  });

  it('is how build:mac ends', () => {
    const pkg: unknown = JSON.parse(
      fs.readFileSync(path.join(PACKAGE, 'package.json'), 'utf8')
    );
    const scripts =
      typeof pkg === 'object' && pkg !== null && 'scripts' in pkg
        ? pkg.scripts
        : undefined;
    const buildMac =
      typeof scripts === 'object' && scripts !== null && 'build:mac' in scripts
        ? String(scripts['build:mac'])
        : '';

    expect(buildMac.endsWith('&& bash desktop/tools/package-mac.sh')).toBe(
      true
    );
    expect(buildMac).not.toContain('electron-builder');
  });
});
