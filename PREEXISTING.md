# Pre-existing code

The hackathon requires that projects be newly created during the submission period, and that any
pre-existing code carried in be disclosed. This is that disclosure.

The submission period opened **2026-07-06**. This repository was created **2026-07-21**, inside it.

## What was carried in

Five configuration files were adapted from an earlier personal project of the author's:

- `next.config.ts`
- `tsconfig.json`
- `eslint.config.mjs`
- `prettier.config.mjs`
- `vitest.config.ts`

They set compiler strictness, lint rules, formatting, the `@/` path alias, and the test runner.
They contain no product logic. All five are in this repository's first commit, `0755e93`.

## What was not

Everything else — every file under `src/`, `app/`, `agents/`, `tests/`, `docs/`, and `examples/` —
was written during the submission period, for this project.

## Two notes for completeness

**Findings gathered under an earlier idea.** `docs/environment-findings.md` records DataHub
behaviour measured on this machine on 2026-07-21. Some of it was measured earlier that same day
while a different project was being scoped, before obsel existed. The measurements are about
DataHub, not about that project, so they carried over unchanged; the document says so in its own
opening. Everything there is inside the submission period.

**Third-party dependencies.** The libraries in `package.json` and the Python packages the agents
use (`acryl-datahub`, and `mcp-server-datahub` run through `uvx`) are standard tools used under
their own licences, which the rules permit and which are not pre-existing code in the sense above.
This project is Apache-2.0; see `LICENSE`.
