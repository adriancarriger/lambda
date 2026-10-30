import { loadMachineConfig } from '../config/machineConfig';
import type { RenderMachine } from '../pod-store';

type Env = Record<string, string | undefined>;

/**
 * Whether this computer's Claude account can use Claude Design, as far as
 * render mode cares: the `design` of its `~/.lambda/config.json`. The runner
 * builds the workflow view from it; `lambda pod render-mode` reads it the
 * same way. Unknown (`{}`)
 * when it was never checked.
 */
export const machineDesign = (env: Env = process.env): RenderMachine => {
  const design = loadMachineConfig(env)?.design;

  return design === undefined
    ? {}
    : { design: { available: design.available } };
};

const warnedAbout = new Set<string>();

/**
 * What the runner reports: unknown, not an error, when the config file
 * can't be read, so a bad file never stops the status or a pod's page. Why
 * is said once per problem, so the runner's log names the bad field.
 */
export const reportedMachineDesign = (
  env: Env = process.env,
  warn: (line: string) => void = (line) => console.error(line)
): RenderMachine => {
  try {
    return machineDesign(env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (!warnedAbout.has(message)) {
      warnedAbout.add(message);
      warn(`Claude Design reported as unknown: ${message}`);
    }

    return {};
  }
};
