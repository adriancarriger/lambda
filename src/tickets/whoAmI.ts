import type { MachineConfig } from '../config/machineConfig';
import type { TrackerIdentity } from './assignees';
import { LINEAR_API_URL } from './linear';

/**
 * Who this computer is in each tracker it has a key for: Linear's viewer
 * (the key's own user), and for Jira the email its token was made with. A
 * key Linear won't answer for is left out, with why, and asked again on the
 * next connect.
 */

type Env = Record<string, string | undefined>;

const WHO_AM_I_TIMEOUT_MS = 10_000;

export interface WhoAmI {
  identities: TrackerIdentity[];
  /** Why a tracker with a key isn't in `identities`. */
  problems: string[];
}

const linearViewer = async (
  key: string,
  doFetch: typeof fetch
): Promise<TrackerIdentity> => {
  const response = await doFetch(LINEAR_API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: key },
    body: JSON.stringify({ query: 'query { viewer { name email } }' }),
    signal: AbortSignal.timeout(WHO_AM_I_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Linear answered ${response.status}.`);
  }

  const body: unknown = await response.json();
  const viewer =
    typeof body === 'object' &&
    body !== null &&
    'data' in body &&
    typeof body.data === 'object' &&
    body.data !== null &&
    'viewer' in body.data &&
    typeof body.data.viewer === 'object' &&
    body.data.viewer !== null
      ? body.data.viewer
      : null;
  const name =
    viewer !== null && 'name' in viewer && typeof viewer.name === 'string'
      ? viewer.name
      : null;
  const email =
    viewer !== null &&
    'email' in viewer &&
    typeof viewer.email === 'string' &&
    viewer.email !== ''
      ? viewer.email
      : null;
  const who = email ?? name;

  if (who === null) {
    throw new Error("Linear didn't say whose key it is.");
  }

  return { tracker: 'linear', who, name };
};

export const whoAmI = async (
  machine: MachineConfig | null,
  env: Env = process.env,
  doFetch: typeof fetch = globalThis.fetch
): Promise<WhoAmI> => {
  const linearKey = env.LAMBDA_LINEAR_KEY ?? machine?.tokens?.linear;
  const jiraEmail = machine?.tokens?.jira?.email;
  const linear = await (linearKey === undefined || linearKey === ''
    ? Promise.resolve(null)
    : linearViewer(linearKey, doFetch).then(
        (identity) => ({ identity }),
        (error: unknown) => ({
          problem: `Linear: ${
            error instanceof Error ? error.message : String(error)
          }`,
        })
      ));
  const jira: TrackerIdentity[] =
    jiraEmail === undefined || jiraEmail === ''
      ? []
      : [{ tracker: 'jira', who: jiraEmail, name: jiraEmail }];

  return {
    identities: [
      ...(linear !== null && 'identity' in linear ? [linear.identity] : []),
      ...jira,
    ],
    problems: linear !== null && 'problem' in linear ? [linear.problem] : [],
  };
};
