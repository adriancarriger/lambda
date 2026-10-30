import {
  ARTIFACT_URL,
  type MachineConfig,
  type MachineDesign,
  loadMachineConfig,
  writeMachineConfig,
} from '../config/machineConfig';

/**
 * Whether Claude Design works with this machine's Claude account. The planning
 * dev checks it at the start of a ux phase (the Artifact tool loads, and its
 * type listing shows a Design type) and records what it found here, in the
 * machine config's `design`. Canvases are then created from the recorded type,
 * and a pod's render mode defaults from `available`.
 */

export { ARTIFACT_URL };

export const assertArtifactUrl = (url: string, label: string): void => {
  if (!ARTIFACT_URL.test(url)) {
    throw new Error(
      `Refusing ${label} ${url}: it must be https://claude.ai/artifact/<id> or https://claude.ai/code/artifact/<id>, with nothing after the id.`
    );
  }
};

/** What `lambda design capability` prints: `available <url>`, `unavailable <reason>` or `unknown`. */
export const capabilityLine = (design: MachineDesign | undefined): string => {
  if (design === undefined) {
    return 'unknown';
  }

  if (design.available) {
    return `available ${design.typeUrl ?? ''}`.trimEnd();
  }

  return `unavailable ${design.reason ?? ''}`.trimEnd();
};

export type CapabilitySetting =
  | { available: true; typeUrl: string; systemTypeUrl?: string }
  | { available: false; reason: string };

/**
 * Record a capability check's result in the machine config, checked now.
 * Every check runs before the file is written: a bad type URL or an empty
 * reason leaves the config as it was.
 */
export const setCapability = (
  setting: CapabilitySetting,
  {
    env = process.env,
    now = () => new Date(),
  }: { env?: Record<string, string | undefined>; now?: () => Date } = {}
): MachineDesign => {
  const checkedAt = now().toISOString();

  const design: MachineDesign = (() => {
    if (setting.available) {
      assertArtifactUrl(setting.typeUrl, '--type-url');

      if (setting.systemTypeUrl !== undefined) {
        assertArtifactUrl(setting.systemTypeUrl, '--system-type-url');
      }

      return {
        available: true,
        typeUrl: setting.typeUrl,
        ...(setting.systemTypeUrl === undefined
          ? {}
          : { systemTypeUrl: setting.systemTypeUrl }),
        checkedAt,
      };
    }

    if (setting.reason.trim() === '') {
      throw new Error('--set unavailable needs a --reason.');
    }

    return { available: false, checkedAt, reason: setting.reason.trim() };
  })();

  const config: MachineConfig = loadMachineConfig(env) ?? {};
  writeMachineConfig({ ...config, design }, env);

  return design;
};

/**
 * The Design type a runtime import records: `--type-url` when given, else the
 * one the capability check recorded. Neither: refused.
 */
export const resolveTypeUrl = (
  explicit: string | undefined,
  machine: MachineConfig | null
): string => {
  const typeUrl = explicit ?? machine?.design?.typeUrl;

  if (typeUrl === undefined || typeUrl === '') {
    throw new Error(
      'No Claude Design type recorded: run the capability check first.'
    );
  }

  assertArtifactUrl(typeUrl, 'type url');

  return typeUrl;
};
