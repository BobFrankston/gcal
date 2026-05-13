# TODO

## Convert to noEmit `.ts`-only (Node 25+)

Goal: stop emitting `.js`, run `.ts` directly via Node's native type stripping.

Steps:
1. Sweep all relative imports: `./foo.js` → `./foo.ts` across every `.ts` file.
2. `tsconfig.json`: set `allowImportingTsExtensions: true` and `noEmit: true`.
3. `package.json` `bin`: point at `gcal.ts` and `gtask.ts`.
4. Add `#!/usr/bin/env node` shebang to `gcal.ts` and `gtask.ts`.
5. `files:` — drop `.js`, `.js.map`, `.d.ts`, `.d.ts.map` entries; keep `.ts`.
6. `scripts.build` becomes a no-op or just `tsc --noEmit` (same as `check`).
7. Delete committed `.js` / `.js.map` / `.d.ts` artifacts.

Caveats:
- One-way door: once `allowImportingTsExtensions` is on, `tsc` cannot emit. Anyone on Node <22.6 can't run the published package.
- No enums, no `namespace`, no `experimentalDecorators`, no parameter properties (type-stripping only).
- Verify with `node --version` >= 23.6 (default type stripping) on target machines.
