import type { MachineConfig } from '../config/machineConfig';

/**
 * The machine config, read again on every call so a name or alias changed
 * while the mothership runs is picked up. When the file can't be read, the
 * one read at start is used.
 */
export const liveConfig = (options: {
  load: () => MachineConfig | null;
  fallback: MachineConfig | null;
  log: (line: string) => void;
}): (() => MachineConfig | null) => {
  // The last reason logged: each one is said once, not on every request.
  const said: { reason: string | null } = { reason: null };

  return () => {
    try {
      const config = options.load();
      said.reason = null;

      return config;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      if (reason !== said.reason) {
        said.reason = reason;
        options.log(
          `~/.lambda/config.json can't be read (${reason}); using the one read at start.`
        );
      }

      return options.fallback;
    }
  };
};
