# Working on the QuickBooks MCP

Follow the repository conventions in [CLAUDE.md](CLAUDE.md). This repository is suitable for public distribution. Use invented names and figures in examples, fixtures and issue reports.

The desktop entry point is `src/index.ts`. The MCP tool registry is `src/tools/definitions.ts`, the dispatcher is `src/tools/index.ts`, and `src/tools/discovery.ts` builds the client instructions from the current transport's catalogue. The remote entry point in `src/lambda.ts` restricts local OAuth operations.

When adding a tool, update its schema, description, permission hints, handler, dispatcher and README entry. Run the [fictional workflow and discovery checks](docs/finance-workflows.md#fictional-evaluation). Use the installed server's `initialize` and `tools/list` responses to verify what a fresh client can actually discover.
