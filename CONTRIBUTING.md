# Contributing to Quoroom

Thanks for your interest in contributing! Quoroom is open source and we welcome contributions of all kinds.

## Getting Started

```bash
git clone https://github.com/quoroom-ai/room.git
cd room
npm install
npm run build
npm test
```

## Development

- `npm run build` — Typecheck + bundle MCP server + build UI
- `npm run build:mcp` — Bundle MCP server only
- `npm run build:ui` — Build UI SPA only
- `npm run dev:ui` — UI dev server with hot reload
- `npm test` — Run the test suite (818+ tests)
- `npm run typecheck` — TypeScript type checking
- `npm run test:watch` — Watch mode
- `npm run test:e2e` — End-to-end tests (Playwright)

## Before Submitting a PR

1. Run `npm run typecheck` — no type errors
2. Run `npm test` — all tests pass
3. If you added new functionality, add tests for it

## What to Contribute

- Bug fixes
- New MCP tools
- Documentation improvements
- Test coverage
- Performance improvements

## Code Style

- TypeScript throughout (strict mode)
- Shared logic goes in `src/shared/` (no platform dependencies)
- MCP tools go in `src/mcp/tools/`
- Server routes go in `src/server/routes/`
- UI components go in `src/ui/components/`
- Keep it simple — avoid over-engineering

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
