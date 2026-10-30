/**
 * Every ticket carries its reporter: the person who created or planned it.
 * The computer doing the work is never written to the tracker.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { type SourceContext, createTicketSource } from '../context';
import {
  JIRA_FAKE_PROJECT,
  JIRA_FAKE_SITE,
  JIRA_FAKE_STATUSES,
  createJiraFake,
} from './fakes/jiraFake';
import { PAWNEE_STATUSES, createLinearFake } from './fakes/linearFake';

const leslie = { name: 'Leslie Knope', email: 'leslie@pawnee.gov' };

const tmp = (): string =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-reporter-')));

const markdown = (files: Record<string, string>): SourceContext => {
  const root = tmp();
  Object.entries(files).forEach(([file, text]) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  });

  return {
    root,
    config: { source: 'markdown', prefix: 'PAWNEE' },
    tokens: undefined,
    env: {},
    fetch: async () => {
      throw new Error('No network call expected.');
    },
    runner: leslie,
  };
};

describe('reporter', () => {
  it("is a Jira issue's reporter", async () => {
    const source = createTicketSource({
      ...markdown({}),
      config: {
        source: 'jira',
        statuses: JIRA_FAKE_STATUSES,
        site: JIRA_FAKE_SITE,
        project: JIRA_FAKE_PROJECT,
      },
      tokens: { jira: { email: leslie.email, apiToken: 'jira-test' } },
      fetch: createJiraFake({
        caller: { displayName: 'Leslie Knope', emailAddress: leslie.email },
      }).fetch,
    });
    const created = await source.create({ title: 'Lot 48 pit photo gallery' });

    expect((await source.get(created.id)).reporter).toEqual(leslie);
  });

  it("is a Linear issue's creator", async () => {
    const source = createTicketSource({
      ...markdown({}),
      config: { source: 'linear', statuses: PAWNEE_STATUSES, team: 'PAWNEE' },
      tokens: { linear: 'lin_api_test' },
      fetch: createLinearFake({ viewer: leslie }).fetch,
    });
    const created = await source.create({ title: 'Lot 48 pit photo gallery' });

    expect((await source.get(created.id)).reporter).toEqual(leslie);
  });

  it("is a markdown file's reporter line, or null with none", async () => {
    const source = createTicketSource(
      markdown({
        'TASKS.md':
          '- [ ] PAWNEE-1: Park map page\n- [ ] PAWNEE-2: Volunteer sign-up form\n- [ ] PAWNEE-3: Ice Town sign-up\n',
        'tickets/PAWNEE-1.md':
          '---\nreporter: Leslie Knope <leslie@pawnee.gov>\n---\n# Park map page\n',
        'tickets/PAWNEE-2.md':
          '---\nreporter: Ron Swanson\n---\n# Volunteer sign-up form\n',
        'tickets/PAWNEE-3.md': '# Ice Town sign-up\n',
      })
    );

    expect((await source.get('PAWNEE-1')).reporter).toEqual(leslie);
    expect((await source.get('PAWNEE-2')).reporter).toEqual({
      name: 'Ron Swanson',
    });
    expect((await source.get('PAWNEE-3')).reporter).toBeNull();
  });

  it("create on markdown writes the runner's reporter line", async () => {
    const context = markdown({ 'TASKS.md': '- [ ] PAWNEE-1: Park map page\n' });
    const created = await createTicketSource(context).create({
      title: 'Lot 48',
    });

    expect(
      fs.readFileSync(
        path.join(context.root, 'tickets', `${created.id}.md`),
        'utf8'
      )
    ).toContain('reporter: Leslie Knope <leslie@pawnee.gov>');
  });

  it("next --reporter skips Ron's ready ticket", async () => {
    const source = createTicketSource(
      markdown({
        'TASKS.md':
          '- [ ] PAWNEE-1: Pawnee Rangers badge\n- [ ] PAWNEE-2: Park map page\n',
        'tickets/PAWNEE-1.md':
          '---\nreporter: Ron Swanson <ron@pawnee.gov>\n---\n# Pawnee Rangers badge\n',
        'tickets/PAWNEE-2.md':
          '---\nreporter: Leslie Knope <leslie@pawnee.gov>\n---\n# Park map page\n',
      })
    );

    expect((await source.next())?.id).toBe('PAWNEE-1');
    expect((await source.next({ reporter: 'Leslie@Pawnee.gov' }))?.id).toBe(
      'PAWNEE-2'
    );
    expect((await source.next({ reporter: 'leslie knope' }))?.id).toBe(
      'PAWNEE-2'
    );
    expect(
      (await source.list({ reporter: 'ron@pawnee.gov' })).map(
        (ticket) => ticket.id
      )
    ).toEqual(['PAWNEE-1']);
  });
});
