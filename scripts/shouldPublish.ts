/**
 * Should this push to `main` publish? Only when package.json's version isn't
 * on npm yet, so a push that doesn't bump the version sends no approval
 * request. Run by release.yml's `version` job (`npx jiti
 * scripts/shouldPublish.ts`), which writes `publish=true|false` to the job's
 * outputs.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** npm's answer for a package it has never seen. */
export const NOT_ON_NPM = 'not-on-npm';

export const shouldPublish = (
  localVersion: string,
  npmVersions: string[] | typeof NOT_ON_NPM
): boolean => npmVersions === NOT_ON_NPM || !npmVersions.includes(localVersion);

/** `npm view <name> versions --json`, read; E404 means it isn't there at all. */
export const parseNpmView = (
  status: number | null,
  stdout: string,
  stderr: string
): string[] | typeof NOT_ON_NPM => {
  if (status !== 0) {
    if (`${stdout}\n${stderr}`.includes('E404')) {
      return NOT_ON_NPM;
    }

    throw new Error(`npm view failed (${String(status)}): ${stderr.trim()}`);
  }

  const parsed: unknown = JSON.parse(stdout);

  if (typeof parsed === 'string') {
    return [parsed];
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`npm view answered something unexpected: ${stdout.trim()}`);
  }

  return parsed.filter(
    (version): version is string => typeof version === 'string'
  );
};

const readPackage = (): { name: string; version: string } => {
  const parsed: unknown = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
  );

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('name' in parsed) ||
    !('version' in parsed) ||
    typeof parsed.name !== 'string' ||
    typeof parsed.version !== 'string'
  ) {
    throw new Error('package.json has no name or version.');
  }

  return { name: parsed.name, version: parsed.version };
};

const main = (): void => {
  const { name, version } = readPackage();
  const view = spawnSync('npm', ['view', name, 'versions', '--json'], {
    encoding: 'utf8',
  });
  const publish = shouldPublish(
    version,
    parseNpmView(view.status, view.stdout, view.stderr)
  );
  const line = `publish=${publish ? 'true' : 'false'}`;
  const output = process.env.GITHUB_OUTPUT;

  if (output !== undefined && output !== '') {
    fs.appendFileSync(output, `${line}\nversion=${version}\n`);
  }

  console.log(
    publish
      ? `version ${version}: will publish`
      : `version ${version} is already on npm: won't publish`
  );
};

if (process.argv[1]?.endsWith('shouldPublish.ts') === true) {
  main();
}
