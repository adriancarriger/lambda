/**
 * Standalone, so the published package lints on its own: every rule is
 * written out here rather than extended from a shared config.
 *
 * @type {import('eslint').Linter.Config}
 */
module.exports = {
  root: true,
  ignorePatterns: ['node_modules', 'dist', 'build', 'desktop/release'],
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint', '@eslint-community/eslint-comments'],
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    project: [
      './tsconfig.json',
      './desktop/tsconfig.json',
      './scripts/tsconfig.json',
    ],
    tsconfigRootDir: __dirname,
    ecmaFeatures: { jsx: true },
  },
  env: {
    node: true,
    es6: true,
  },
  overrides: [
    {
      // The app's client runs in the browser: Node's globals and modules
      // aren't there (the Node types the tests need would hide it otherwise).
      files: ['src/app/client/**/*.{ts,tsx}'],
      env: { browser: true },
      rules: {
        'no-restricted-globals': [
          'error',
          ...[
            'process',
            'Buffer',
            '__dirname',
            '__filename',
            'require',
            'global',
          ].map((name) => ({
            name,
            message: 'The client runs in the browser.',
          })),
        ],
        // The typescript-eslint version, for `allowTypeImports`: the client
        // may share the server's types, never its code.
        'no-restricted-imports': 'off',
        '@typescript-eslint/no-restricted-imports': [
          'error',
          {
            paths: [
              'fs',
              'path',
              'os',
              'crypto',
              'child_process',
              'http',
              'https',
              'net',
              'stream',
              'url',
              'util',
              'events',
            ].map((name) => ({
              name,
              message: 'The client runs in the browser.',
            })),
            patterns: [
              { group: ['node:*'], message: 'The client runs in the browser.' },
              {
                group: ['@repo/*'],
                message: 'Lambda is standalone: no @repo/* imports.',
              },
              {
                group: [
                  '../server',
                  '../server/*',
                  '../devProxy',
                  '../../mothership',
                  '../../mothership/*',
                  '../../runner',
                  '../../runner/*',
                  '../../events',
                  '../../events/*',
                  '../../commands/*',
                  '../../pod-store',
                  '../../pod-store/*',
                ],
                allowTypeImports: true,
                message:
                  'Server code runs in Node, not the browser: `import type` only.',
              },
            ],
          },
        ],
      },
    },
  ],
  rules: {
    '@eslint-community/eslint-comments/require-description': 'warn',
    '@typescript-eslint/no-unused-vars': 'off',
    '@typescript-eslint/consistent-type-assertions': [
      'warn',
      { assertionStyle: 'never' },
    ],
    'arrow-body-style': ['warn', 'as-needed'],
    curly: ['warn', 'all'],
    'no-else-return': ['warn', { allowElseIf: false }],
    'prefer-destructuring': ['warn', { array: true, object: true }],
    'no-restricted-syntax': [
      'warn',
      {
        selector: 'VariableDeclaration[kind="let"]',
        message:
          'Use const instead of let. Prefer functional patterns (ternary operators, early returns, or extracted functions) over let for better code clarity and immutability.',
      },
      {
        selector: "UnaryExpression[operator='!'][argument.operator='!']",
        message: 'Use Boolean(value) instead of !!value for type coercion.',
      },
      {
        selector:
          "CallExpression[callee.property.name='push']:not([callee.object.name='router']):not([callee.object.name='history']):not([callee.object.property.name='router']):not([callee.object.property.name='history'])",
        message:
          'Array.push() mutates arrays. Use spread operator [...arr, item] or concat() instead.',
      },
    ],
    'no-unneeded-ternary': ['warn', { defaultAssignment: false }],
    'padding-line-between-statements': [
      'warn',
      { blankLine: 'always', prev: '*', next: 'return' },
      { blankLine: 'always', prev: '*', next: 'throw' },
      { blankLine: 'always', prev: '*', next: 'break' },
      { blankLine: 'always', prev: '*', next: 'continue' },
      { blankLine: 'always', prev: '*', next: 'if' },
      { blankLine: 'always', prev: '*', next: 'for' },
      { blankLine: 'always', prev: '*', next: 'while' },
      { blankLine: 'always', prev: '*', next: 'try' },
      { blankLine: 'always', prev: '*', next: 'switch' },
    ],
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['@repo/*'],
            message: 'Lambda is standalone: no @repo/* imports.',
          },
        ],
      },
    ],
  },
};
