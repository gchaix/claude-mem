import os from 'node:os';

/**
 * Returns the hostname of the current machine, used to tag observations
 * with the originating machine in multi-machine setups where hooks on one
 * machine submit observations to a worker on another.
 *
 * The CLAUDE_MEM_HOSTNAME env var overrides os.hostname(), which is useful
 * when the OS hostname is unstable (e.g. container environments that assign
 * random IDs) or when a friendlier label is preferred.
 */
export function getHostname(): string {
  return process.env.CLAUDE_MEM_HOSTNAME?.trim() || os.hostname();
}
