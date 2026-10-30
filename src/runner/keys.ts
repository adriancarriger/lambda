import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { lambdaHome } from '../config/machineConfig';

type Env = Record<string, string | undefined>;

export const RUNNER_KEY_FILE = 'runner.key';

export const defaultKeyPath = (env: Env = process.env): string =>
  path.join(lambdaHome(env), RUNNER_KEY_FILE);

/** A new Ed25519 pair, PEM. Only the public half ever leaves this computer. */
export const generateRunnerKeys = (): {
  publicKey: string;
  privateKey: string;
} => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
};

/** Write the private key, mode 0600. */
export const writePrivateKey = (file: string, privateKey: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, privateKey, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
};

/** The signature of the mothership's challenge, base64. */
export const signChallenge = (privateKey: string, challenge: Buffer): string =>
  crypto.sign(null, challenge, privateKey).toString('base64');
