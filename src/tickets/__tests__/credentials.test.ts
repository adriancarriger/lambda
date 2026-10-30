import { resolveJiraCredentials, resolveLinearKey } from '../source';

const fromFile = {
  jira: { email: 'ben@pawnee.gov', apiToken: 'file-token' },
};
const NO_JIRA_KEY =
  'No Jira key: set tokens.jira (email and apiToken) in ~/.lambda/config.json, or LAMBDA_JIRA_EMAIL + LAMBDA_JIRA_TOKEN.';

describe('Jira credentials need both halves', () => {
  it('uses the environment pair over the config file', () => {
    expect(
      resolveJiraCredentials(fromFile, {
        LAMBDA_JIRA_EMAIL: 'leslie@pawnee.gov',
        LAMBDA_JIRA_TOKEN: 'env-token',
      })
    ).toEqual({ email: 'leslie@pawnee.gov', apiToken: 'env-token' });
  });

  it('ignores a lone LAMBDA_JIRA_EMAIL or LAMBDA_JIRA_TOKEN, never mixing it with the file', () => {
    expect(
      resolveJiraCredentials(fromFile, {
        LAMBDA_JIRA_EMAIL: 'leslie@pawnee.gov',
      })
    ).toEqual(fromFile.jira);
    expect(
      resolveJiraCredentials(fromFile, { LAMBDA_JIRA_TOKEN: 'env-token' })
    ).toEqual(fromFile.jira);
  });

  it('refuses one environment half with nothing in the file', () => {
    expect(() =>
      resolveJiraCredentials(undefined, {
        LAMBDA_JIRA_EMAIL: 'leslie@pawnee.gov',
      })
    ).toThrow(NO_JIRA_KEY);
    expect(() =>
      resolveJiraCredentials({}, { LAMBDA_JIRA_TOKEN: 'env-token' })
    ).toThrow(NO_JIRA_KEY);
  });

  it('refuses a config file missing either half', () => {
    expect(() =>
      resolveJiraCredentials(
        { jira: { email: 'ben@pawnee.gov', apiToken: '' } },
        {}
      )
    ).toThrow(NO_JIRA_KEY);
  });
});

describe('the Linear key', () => {
  it('prefers LAMBDA_LINEAR_KEY, then tokens.linear, else refuses', () => {
    expect(
      resolveLinearKey({ linear: 'lin_file' }, { LAMBDA_LINEAR_KEY: 'lin_env' })
    ).toBe('lin_env');
    expect(resolveLinearKey({ linear: 'lin_file' }, {})).toBe('lin_file');
    expect(() => resolveLinearKey(undefined, {})).toThrow(
      'No Linear key: set tokens.linear in ~/.lambda/config.json or LAMBDA_LINEAR_KEY.'
    );
  });
});
