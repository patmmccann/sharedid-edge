# packages/modules/all

User documentation is in [README.md](README.md) (also the npm package page).

`@sharedid-edge/modules` exports `builtInModules`, the one list of modules every adapter builds in. Read [`../AGENTS.md`](../AGENTS.md) first.

- **Adding a project module:** add the package to `dependencies` and `tsconfig.json` `references`, append it to `builtInModules`, and update the expected names in `test/modules.test.ts`, this README's list and the main README's built-in modules table. The adapters pick it up without changes.
- **Order:** `SID_MODULES` sets the order modules run in, not this list. Append new modules anyway, so diffs stay small.
- **Never add vendor modules** (`packages/vendor-modules/`): those are opt-in at build time.
- No code here besides the list. Core must never depend on this package.
