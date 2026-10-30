import { type Command } from 'commander';

import { loadMachineConfig } from '../../config/machineConfig';
import { mothershipDbPath, openDb } from '../../mothership/db';
import {
  type Alias,
  addAliasTo,
  isOwnersLogin,
  listAliases,
  ownerFromConfig,
  aliasOf as parseAlias,
} from '../../mothership/owner';
import { hostsMothership } from '../../runner/processes';

/**
 * `lambda account alias add|remove|list`: other ticket logins that count as
 * you (another email, or the name a second Linear account shows). Written
 * through the database file on the host, like `lambda open`'s link, so the
 * mothership needn't be running. The only route that adds one is setup's
 * "that login is me", behind the owner's sign-in.
 */

type Env = Record<string, string | undefined>;

export const NOT_ON_HOST =
  'Run lambda account alias on the computer running Lambda.';
export const EMPTY_ALIAS = 'Give an email or a name.';

/** Stored trimmed and lowercased; with an `@` it's an email. */
export const aliasOf = (typed: string): Alias => {
  const alias = parseAlias(typed);

  if (alias === null) {
    throw new Error(EMPTY_ALIAS);
  }

  return alias;
};

const withHostDb = <T>(
  env: Env,
  fn: (
    db: ReturnType<typeof openDb>,
    owner: ReturnType<typeof ownerFromConfig>
  ) => T
): T => {
  const config = loadMachineConfig(env);

  if (!hostsMothership(config, env)) {
    throw new Error(NOT_ON_HOST);
  }

  const db = openDb(mothershipDbPath(env));

  try {
    return fn(db, ownerFromConfig(config));
  } finally {
    db.close();
  }
};

/** Answers the line to print; an alias already there (or your own email) writes nothing. */
export const addAlias = (typed: string, env: Env = process.env): string => {
  const alias = aliasOf(typed);

  return withHostDb(env, (db, owner) => {
    if (alias.kind === 'email' && alias.value === owner.email) {
      return `${alias.value} already counts as ${owner.name}.`;
    }

    return addAliasTo(db, alias)
      ? `✓ ${alias.value} now counts as ${owner.name}`
      : `${alias.value} already counts as ${owner.name}.`;
  });
};

export const removeAlias = (typed: string, env: Env = process.env): string => {
  const alias = aliasOf(typed);

  return withHostDb(env, (db, owner) => {
    const { changes } = db
      .prepare('DELETE FROM aliases WHERE kind = ? AND value = ?')
      .run(alias.kind, alias.value);

    if (changes === 0) {
      throw new Error(`${alias.value} isn't an alias of ${owner.name}.`);
    }

    return `✓ ${alias.value} no longer counts as ${owner.name}`;
  });
};

export const aliasList = (env: Env = process.env): string[] =>
  withHostDb(env, (db, owner) => {
    const aliases = listAliases(db);

    return aliases.length === 0
      ? ['No aliases.']
      : [
          `Aliases for ${owner.name}`,
          ...aliases.map(
            (alias) => `  ${alias.kind.padEnd(5)}  ${alias.value}`
          ),
        ];
  });

export const registerAccountCommand = (program: Command): void => {
  const account = program
    .command('account')
    .description('You: the logins that count as you');
  const alias = account
    .command('alias')
    .description('Other emails or names that count as you on tickets');

  alias
    .command('add <value>')
    .description('Count another email or name as you')
    .action((value: string) => console.log(addAlias(value)));
  alias
    .command('remove <value>')
    .description('Stop counting an email or name as you')
    .action((value: string) => console.log(removeAlias(value)));
  alias
    .command('list')
    .description('List them')
    .action(() => aliasList().forEach((line) => console.log(line)));
};

/**
 * The owner's logins, for `lambda connect` to ask about the key's: null on a
 * computer that isn't running Lambda, which can't read or change them.
 */
export const youOnHost = (
  env: Env = process.env
): {
  isYou: (login: { name: string; email: string | null }) => boolean;
  claim: (alias: Alias) => void;
} | null => {
  if (!hostsMothership(loadMachineConfig(env), env)) {
    return null;
  }

  return {
    isYou: (login) =>
      withHostDb(env, (db, owner) => isOwnersLogin(db, owner, login)),
    claim: (alias) => {
      withHostDb(env, (db) => addAliasTo(db, alias));
    },
  };
};
