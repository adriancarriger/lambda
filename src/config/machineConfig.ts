import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';

import { ownerLabel } from '../pod-store/resolution';
import { readConfigFile } from './readConfigFile';

export const MACHINE_CONFIG_FILE = 'config.json';

const TokenSchema = z.object({
  value: z.string(),
  createdAt: z.string().optional(),
});

/** A claude.ai artifact link, with nothing after the id. */
export const ARTIFACT_URL =
  /^https:\/\/claude\.ai\/(code\/)?artifact\/[A-Za-z0-9-]+$/;

const ArtifactUrlSchema = z
  .string()
  .regex(ARTIFACT_URL, 'must be a claude.ai artifact link');

/**
 * Whether Claude Design works with this machine's Claude account, as the
 * planning dev's capability check last found it (`lambda design capability
 * --set …`). `typeUrl` is the account's Design type, the one canvases are
 * created from; `systemTypeUrl` its Design System type, when the same listing
 * showed one. Nothing in the code names either: they come from the account.
 */
export const MachineDesignSchema = z
  .object({
    available: z.boolean(),
    typeUrl: ArtifactUrlSchema.optional(),
    systemTypeUrl: ArtifactUrlSchema.optional(),
    checkedAt: z.string().min(1),
    /** Why it isn't available, in the check's words. */
    reason: z.string().min(1).optional(),
  })
  // Canvases are created from the type, so "available" means nothing without it.
  .refine((design) => !design.available || design.typeUrl !== undefined, {
    path: ['typeUrl'],
    message: 'is needed when available is true',
  });

export type MachineDesign = z.infer<typeof MachineDesignSchema>;

/**
 * `~/.lambda/config.json`, one per machine: who you are, this machine's keys
 * and tokens, and first-run state. Defined once here; later commands read
 * these fields and never redefine them. Created 0600 in a 0700 folder.
 */
export const MachineConfigSchema = z.object({
  owner: z
    .object({
      name: z.string().min(1).optional(),
      /** Your own email. Ticket reporters are matched against it. */
      email: z.string().min(1).optional(),
    })
    .optional(),
  runner: z
    .object({
      id: z.string().min(1).optional(),
      /** The runner's signing key. */
      keyPath: z.string().min(1).optional(),
    })
    .optional(),
  mothership: z
    .object({
      /** Overridden by the `LAMBDA_URL` env var. */
      url: z.string().min(1).optional(),
      /** A hostname without a port. */
      host: z.string().min(1).optional(),
      /** An extra address to listen on, besides 127.0.0.1. */
      listen: z.string().min(1).optional(),
      port: z.number().int().positive().optional(),
    })
    .optional(),
  tokens: z
    .object({
      claude: TokenSchema.optional(),
      linear: z.string().optional(),
      jira: z.object({ email: z.string(), apiToken: z.string() }).optional(),
      elevenlabs: z.string().optional(),
    })
    .optional(),
  firstRun: z
    .object({
      claude: z.boolean().optional(),
      /** By absolute project path. */
      projects: z.record(
        z.object({ project: z.boolean(), tickets: z.boolean() })
      ),
    })
    .optional(),
  design: MachineDesignSchema.optional(),
});

export type MachineConfig = z.infer<typeof MachineConfigSchema>;

type Env = Record<string, string | undefined>;

/**
 * `LAMBDA_HOME`, else `~/.lambda`. A test run never gets the real one (the
 * account's own home, whatever HOME or a mocked `os.homedir()` says): it
 * throws, so a test that forgot its temp home fails instead of writing into
 * the person's own setup.
 */
export const lambdaHome = (env: Env = process.env): string => {
  const fromEnv = env.LAMBDA_HOME;

  if (fromEnv !== undefined && fromEnv !== '') {
    return path.resolve(fromEnv);
  }

  const home = path.join(os.homedir(), '.lambda');

  if (
    process.env.JEST_WORKER_ID !== undefined &&
    home === path.join(os.userInfo().homedir, '.lambda')
  ) {
    throw new Error(
      'A test reached the real ~/.lambda: give it a temp LAMBDA_HOME.'
    );
  }

  return home;
};

export const machineConfigPath = (env: Env = process.env): string =>
  path.join(lambdaHome(env), MACHINE_CONFIG_FILE);

/**
 * This machine's settings, or `null` when the file doesn't exist (not an
 * error). Throws `<path>: <field> <problem>` lines on a bad file.
 */
export const loadMachineConfig = (
  env: Env = process.env
): MachineConfig | null => {
  const file = machineConfigPath(env);

  return fs.existsSync(file) ? readConfigFile(file, MachineConfigSchema) : null;
};

/**
 * Write the machine file, 0600. A folder it has to create is made 0700; one
 * that already exists keeps its mode.
 */
export const writeMachineConfig = (
  config: MachineConfig,
  env: Env = process.env
): string => {
  const home = lambdaHome(env);

  if (!fs.existsSync(home)) {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.chmodSync(home, 0o700);
  }

  const file = path.join(home, MACHINE_CONFIG_FILE);
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.chmodSync(file, 0o600);

  return file;
};

/** The name agent-facing text uses: `owner.name`, else `Owner`. */
export const resolveOwnerName = (config: MachineConfig | null): string =>
  ownerLabel(config?.owner?.name);

/** `LAMBDA_URL`, else `mothership.url`. */
export const resolveMothershipUrl = (
  config: MachineConfig | null,
  env: Env = process.env
): string | undefined => {
  const fromEnv = env.LAMBDA_URL;

  return fromEnv === undefined || fromEnv === ''
    ? config?.mothership?.url
    : fromEnv;
};
