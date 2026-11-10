// Lint for vendor modules: the root rules plus a few that keep vendor code inside the rules in AGENTS.md. ESLint uses
// the config file nearest to each linted file, so everything under packages/vendor-modules/ is linted with this one;
// it starts from the root config, so nothing is relaxed.
import root from '../../eslint.config.js';

export default [
  ...root,
  {
    files: ['*/src/**/*.ts'],
    rules: {
      // No logging at all: a module never logs request data, and errors are reported by core as `status: "error"`.
      'no-console': ['error', { allow: [] }],
      // Network calls only through the opt-in, time-limited, cached wrapper the vendor rules require; until core
      // provides it, none. Data updates belong in scheduled jobs, not requests.
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Modules make no network calls during requests. See packages/vendor-modules/AGENTS.md.' },
        { name: 'XMLHttpRequest', message: 'Modules make no network calls during requests.' },
        { name: 'WebSocket', message: 'Modules make no network calls during requests.' }
      ],
      'no-restricted-properties': [
        'error',
        { object: 'globalThis', property: 'fetch', message: 'Modules make no network calls during requests.' },
        { object: 'self', property: 'fetch', message: 'Modules make no network calls during requests.' }
      ],
      // Platform-neutral: modules run on every adapter, so no Node.js built-ins.
      'no-restricted-imports': ['error', { patterns: [{ regex: '^node:', message: 'Modules are platform-neutral: use web-standard APIs.' }] }],
      'no-eval': 'error',
      'no-new-func': 'error'
    }
  }
];
