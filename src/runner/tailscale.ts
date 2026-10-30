import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { loadMachineConfig, writeMachineConfig } from '../config/machineConfig';

/**
 * Add a computer over Tailscale: find the CLI, read `tailscale status --json`
 * on the computer running the mothership, and write the one address it may
 * also listen on. Runs on the mothership, never in the browser.
 */

type Env = Record<string, string | undefined>;

/** The Mac App Store and standalone apps put no `tailscale` on PATH. */
export const TAILSCALE_APP_CLI =
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

export const INSTALL_TAILSCALE = 'Install Tailscale';
export const SIGN_IN_TO_TAILSCALE = 'Sign in to Tailscale';
export const TAILSCALE_UP = '✓ this Mac';

const STATUS_TIMEOUT_MS = 5000;

export type TailscaleCheck =
  | { state: 'missing' }
  | { state: 'signed-out' }
  | {
      state: 'up';
      /** This computer's tailnet IPv4, the one address it adds. */
      address: string;
      /** The MagicDNS name, when MagicDNS is on. */
      name: string | null;
      /** What step 2 calls this computer. */
      label: string;
    };

export const stepOneText = (check: TailscaleCheck): string => {
  switch (check.state) {
    case 'missing':
      return INSTALL_TAILSCALE;
    case 'signed-out':
      return SIGN_IN_TO_TAILSCALE;
    default:
      return TAILSCALE_UP;
  }
};

/** 100.64.0.0/10: the only addresses Tailscale gives out. */
export const isTailnetIPv4 = (address: string): boolean => {
  const parts = address.split('.');

  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) {
    return false;
  }

  const [first, second] = parts.map(Number);

  return first === 100 && second !== undefined && second >= 64 && second < 128;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const SIGNED_OUT: TailscaleCheck = { state: 'signed-out' };

/** `tailscale status --json`'s output, read. Anything unexpected is signed out. */
export const readTailscaleStatus = (stdout: string): TailscaleCheck => {
  const status = parseJson(stdout);

  if (!isRecord(status) || status.BackendState !== 'Running') {
    return SIGNED_OUT;
  }

  const self = isRecord(status.Self) ? status.Self : {};
  const ips = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : [];
  const address = ips.find(
    (ip): ip is string => typeof ip === 'string' && isTailnetIPv4(ip)
  );

  if (address === undefined) {
    return SIGNED_OUT;
  }

  const tailnet = isRecord(status.CurrentTailnet) ? status.CurrentTailnet : {};
  const dnsName =
    typeof self.DNSName === 'string' ? self.DNSName.replace(/\.$/, '') : '';
  const name =
    tailnet.MagicDNSEnabled === true && dnsName !== '' ? dnsName : null;
  const hostName = typeof self.HostName === 'string' ? self.HostName : '';
  const label = dnsName.split('.')[0] || hostName || address;

  return { state: 'up', address, name, label };
};

const isExecutable = (file: string): boolean => {
  try {
    fs.accessSync(file, fs.constants.X_OK);

    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

/** `tailscale` on PATH, else the app bundle's binary, else null. */
export const findTailscale = (env: Env, appCli: string): string | null => {
  const onPath = (env.PATH ?? '')
    .split(path.delimiter)
    .filter((dir) => dir !== '')
    .map((dir) => path.join(dir, 'tailscale'))
    .find(isExecutable);

  if (onPath !== undefined) {
    return onPath;
  }

  return isExecutable(appCli) ? appCli : null;
};

/** Run `status --json`: its output, or null on a non-zero exit. */
const runStatus = (cli: string): Promise<string | null> =>
  new Promise((resolve) => {
    execFile(
      cli,
      ['status', '--json'],
      { timeout: STATUS_TIMEOUT_MS, encoding: 'utf8' },
      (error, stdout) => resolve(error === null ? stdout : null)
    );
  });

export const checkTailscale = async (
  options: { env?: Env; appCli?: string } = {}
): Promise<TailscaleCheck> => {
  const cli = findTailscale(
    options.env ?? process.env,
    options.appCli ?? TAILSCALE_APP_CLI
  );

  if (cli === null) {
    return { state: 'missing' };
  }

  const stdout = await runStatus(cli);

  return stdout === null ? SIGNED_OUT : readTailscaleStatus(stdout);
};

export type TailscaleUp = Extract<TailscaleCheck, { state: 'up' }>;

/** What the other machine's `lambda join --server` dials. */
export const joinServer = (check: TailscaleUp, port: number): string =>
  `http://${check.name ?? check.address}:${port}`;

export interface ListenFields {
  listen: string;
  /** Only when the join line uses the MagicDNS name. */
  host?: string;
}

export const listenFields = (check: TailscaleUp): ListenFields =>
  check.name === null
    ? { listen: check.address }
    : { listen: check.address, host: check.name };

/** Write `mothership.listen` (and `host`), keeping the rest of the file. */
export const saveListenFields = (
  fields: ListenFields,
  env: Env = process.env
): void => {
  const config = loadMachineConfig(env) ?? {};
  writeMachineConfig(
    { ...config, mothership: { ...config.mothership, ...fields } },
    env
  );
};
