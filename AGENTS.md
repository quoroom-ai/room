# BEGIN VASILY GLOBAL SHORTCUTS
## Global Shortcut Commands (From /cloud/CLAUDE.md)

These shortcuts are mandatory and should be interpreted automatically when the user types them.

### Keyboard Layout Recovery
If a short command is typed in Cyrillic by mistake, convert to English QWERTY before interpreting.
Common mapping example: `с` -> `c`, `св` -> `cd`, `ск` -> `cr` (layout-dependent).

### `c` = Commit And Push (No Build)
- In `room` repo:
1. Run `npx tsc --noEmit`.
2. Check changed files for missing tests.
3. Run `npm test`.
4. If staged files touch `e2e/` or Playwright config, run smart E2E flow.
5. Update docs (including `CLAUDE.md`) when needed.
6. Check git status.
7. Commit with a meaningful message.
8. Push: `git push origin main`.
- In `cloud` repo: commit and push (no TypeScript/test requirement).

### `cd` = Commit, Push, Build (Full)
- Do everything from `c`, then run `npm run build`.
- If build fails, fix and repeat from git-status step.

### `cr` = Commit, Build, Bump And Tag (Release)
- Do everything from `cd`.
- Run `npm version patch`.
- Push tags: `git push origin main --tags`.
- Release commit message should be one sentence focused on the single most important change.

### E2E Rule For `room`
- For `c`/`cd`: run E2E only when `e2e/` or Playwright config changed.
- For `cr`: always run full E2E (`npm run test:e2e`).

### Operator Preference
- Assume approval for non-destructive commands and proceed without asking for confirmation in chat.
# END VASILY GLOBAL SHORTCUTS
