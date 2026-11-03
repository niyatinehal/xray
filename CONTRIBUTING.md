# Contributing

The most useful contribution is **a real codebase xray got wrong.** Open an issue with:

1. the framework, ORM and queue libraries involved
2. one endpoint, and the hops a person reading the code would trace
3. what `scan.mjs` produced instead (the `candidateFlows` entry from `xray-out/system.json`)

To fix it yourself:

1. Add a minimal example under `examples/<name>/` that reproduces the pattern.
2. Add a test in `test/scan.test.mjs` asserting the hops you expect.
3. Extend `scripts/scan.mjs`. [`references/adapting.md`](references/adapting.md) maps symptoms to the section to change.
4. Run `npm test`. Every existing example must still pass.

Ground rules: every step must carry `file:line` evidence, and nothing is ever drawn that wasn't seen in code. A hop that's missing is better than one that's wrong.
