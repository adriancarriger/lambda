import * as fs from 'fs';
import * as path from 'path';

import { buildingPodStore } from '../../building/__tests__/fakes';
import {
  JIRA_FAKE_PROJECT,
  JIRA_FAKE_SITE,
  JIRA_FAKE_STATUSES,
  createJiraFake,
} from '../../tickets/__tests__/fakes/jiraFake';
import { type SourceContext } from '../../tickets/context';
import { createJiraSource } from '../../tickets/jira';
import { createMarkdownSource } from '../../tickets/markdown';
import type { TicketSource } from '../../tickets/source';
import { createTicketRequests } from '../ticketRequests';

/**
 * All tickets links a tracker's ticket out and a markdown one nowhere: the
 * link comes from the source, through the runner's list, not the fixture.
 */

const roots: string[] = [];

afterEach(() => {
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true }));
});

const listUrls = async (
  source: (root: string) => TicketSource
): Promise<(string | null)[]> => {
  const { root } = buildingPodStore();
  roots.splice(roots.length, 0, root);
  fs.writeFileSync(
    path.join(root, 'lambda.json'),
    JSON.stringify({ name: 'Pawnee Parks app' })
  );
  const { tickets } = await createTicketRequests({
    lambda: async () => '',
    log: () => undefined,
    openSource: () => source(root),
    summaryRun: () => async () => ({ exitCode: 1, stdout: '' }),
  }).list({ type: 'tickets', folder: root, projectId: 'p1' });

  return tickets.map((one) => one.url);
};

const context = (
  root: string,
  config: SourceContext['config'],
  fetch: SourceContext['fetch'] = () => {
    throw new Error('No network');
  }
): SourceContext => ({
  root,
  config,
  tokens: {
    jira: { email: 'leslie@pawnee.gov', apiToken: 'jira_token_test123' },
  },
  env: {},
  fetch,
  runner: { name: 'Leslie Knope', email: 'leslie@pawnee.gov' },
});

describe('All tickets links', () => {
  it('a Jira ticket out to its browse page', async () => {
    const fake = createJiraFake({
      issues: [{ key: 'PAWNEE-1', summary: 'Park map page' }],
    });

    expect(
      await listUrls((root) =>
        createJiraSource(
          context(
            root,
            {
              source: 'jira',
              statuses: JIRA_FAKE_STATUSES,
              site: JIRA_FAKE_SITE,
              project: JIRA_FAKE_PROJECT,
            },
            fake.fetch
          )
        )
      )
    ).toEqual(['https://pawnee.atlassian.net/browse/PAWNEE-1']);
  });

  it('a markdown ticket nowhere', async () => {
    expect(
      await listUrls((root) => {
        fs.writeFileSync(
          path.join(root, 'TASKS.md'),
          '# Pawnee Parks app\n\n- [ ] PAWNEE-1: Park map page\n'
        );

        return createMarkdownSource(
          context(root, { source: 'markdown', prefix: 'PAWNEE' })
        );
      })
    ).toEqual([null]);
  });
});
