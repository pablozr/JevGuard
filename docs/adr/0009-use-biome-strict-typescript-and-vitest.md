# ADR 0009: Use Biome, strict TypeScript, and Vitest

## Status

Accepted

The workspace standardizes on strict TypeScript, Biome for formatting and linting,
and Vitest for tests. It does not introduce overlapping ESLint and Prettier setup.

Quality gates run formatting, linting, type checking, and tests. Code is organized
into small cohesive modules with explicit names and whitespace-separated logical
steps; implementation comments are avoided in favor of types, naming, and limited
TSDoc on exported contracts or non-obvious invariants.
