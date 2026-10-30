import { execFileSync } from 'child_process';
import * as os from 'os';

import {
  type MachineConfig,
  loadMachineConfig,
  writeMachineConfig,
} from '../config/machineConfig';
import type { Db } from '../mothership/db';
import { addRunner, getRunner, newRunnerId } from '../mothership/registry';
import { HOST_RUNNER_SECRET } from '../mothership/server';
import { defaultKeyPath, generateRunnerKeys, writePrivateKey } from './keys';
import { writeRunnerInfo } from './localFiles';

type Env = Record<string, string | undefined>;

/** macOS's own name for the computer ("Leslie's Mac mini"), else the host name. */
export const computerName = (): string => {
  if (process.platform === 'darwin') {
    try {
      const name = execFileSync('scutil', ['--get', 'ComputerName'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();

      if (name !== '') {
        return name;
      }
    } catch {
      // Fall through to the host name.
    }
  }

  return os.hostname();
};

/**
 * On the computer running Lambda, the first `lambda start` registers its
 * runner straight through the database file: no join code, so a single Mac
 * needs no `lambda join`. Answers the runner's id.
 */
export const ensureHostRunner = (
  db: Db,
  options: { name: string; now: number; env?: Env }
): string => {
  const env = options.env ?? process.env;
  const config: MachineConfig = loadMachineConfig(env) ?? {};
  const existing = config.runner?.id;

  if (existing !== undefined && getRunner(db, existing) !== null) {
    db.prepare('INSERT OR IGNORE INTO secrets (name, value) VALUES (?, ?)').run(
      HOST_RUNNER_SECRET,
      existing
    );

    return existing;
  }

  const keys = generateRunnerKeys();
  const keyPath = config.runner?.keyPath ?? defaultKeyPath(env);
  const runnerId = newRunnerId();
  writePrivateKey(keyPath, keys.privateKey);
  addRunner(
    db,
    { id: runnerId, name: options.name, publicKey: keys.publicKey },
    options.now
  );
  db.prepare('INSERT OR REPLACE INTO secrets (name, value) VALUES (?, ?)').run(
    HOST_RUNNER_SECRET,
    runnerId
  );
  writeMachineConfig({ ...config, runner: { id: runnerId, keyPath } }, env);
  writeRunnerInfo({ name: options.name }, env);

  return runnerId;
};
