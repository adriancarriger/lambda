import { type MachineConfig, loadMachineConfig } from '../config/machineConfig';

/**
 * The person who runs the project, as pods name them. The name comes from
 * `owner.name` in `~/.lambda/config.json`; without one, who reads the text
 * decides the words:
 *
 *   - printed to the person in their terminal: "you" / "your";
 *   - sent to an agent: "the owner", because "you" there means the agent.
 *
 * Never a pronoun for the owner.
 */

/** `owner.name` in these machine settings, or undefined when there is none. */
export const ownerNameIn = (
  config: MachineConfig | null
): string | undefined => {
  const name = config?.owner?.name?.trim();

  return name === undefined || name === '' ? undefined : name;
};

/** `owner.name`, or undefined when the machine has none. */
export const ownerName = (): string | undefined =>
  ownerNameIn(loadMachineConfig());

/** Agent-facing: `Leslie Knope`, else `the owner`. */
export const ownerForAgent = (name: string | undefined = ownerName()): string =>
  name ?? 'the owner';

/** Agent-facing, at the start of a sentence: `Leslie Knope`, else `The owner`. */
export const ownerStartForAgent = (
  name: string | undefined = ownerName()
): string => name ?? 'The owner';

/** Agent-facing possessive: `Leslie Knope's`, else `the owner's`. */
export const ownersForAgent = (
  name: string | undefined = ownerName()
): string => `${ownerForAgent(name)}'s`;

/** Person-facing possessive: `Leslie Knope's`, else `your`. */
export const ownersForPerson = (
  name: string | undefined = ownerName()
): string => (name === undefined ? 'your' : `${name}'s`);

/** Person-facing: `Leslie Knope`, else `you`. */
export const ownerForPerson = (
  name: string | undefined = ownerName()
): string => name ?? 'you';
