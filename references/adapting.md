# Extending the scanner

`scripts/scan.mjs` is regex-level with no dependencies, in clearly marked sections. When a JS/TS or Python repo uses a pattern it doesn't know, extend the right section and re-scan — usually one regex. Don't hand-write a big repo's model if a small scanner fix will do.

**Diagnose first.** Pick one endpoint you know, follow its code by hand, and compare with the scanner's trace (`candidateFlows` in `xray-out/system.json`). The first hop where they differ tells you which section to change.

| Symptom | Section | Typical fix |
|---|---|---|
| Wrong or missing blocks | `findUnits` / `findModules` | Add the repo's folders (e.g. `backend/*`, `src/contexts/*`). |
| Entry points missing | `jsRoutes` / `pyRegistries` | New framework or router style (tRPC procedures, GraphQL resolvers, Remix loaders, `fastify.route({…})`, Litestar, Sanic). Push to `routes` with a body `range`. |
| Route prefix wrong | mounts in `jsRoutes` | Prefix set another way (`Router({ prefix })`, `basePath`). |
| Flow stops at a call | `effects` → follow calls | The callee is reached through something unknown: a DI container, a service locator, `services.x.y`, a class instance created elsewhere. Resolve the target file and use `fnBody(file, null, method)`. |
| Imports don't resolve | `resolveJs` / `resolvePy` | Unusual aliases (webpack/vite config, `PYTHONPATH`). Add the alias. |
| Database calls missing | `effects` → databases | Another ORM/client (MikroORM, Objection, Kysely, Peewee, Tortoise). Add a pattern; use `db(idx, store, model, op)`. |
| Events/messages missing | listeners in registries + emits in `effects` | Another bus API (`nats.publish`, SNS `PublishCommand`, Pub/Sub `topic.publishMessage`, `bus.dispatch`). Add emit + listener patterns with matching names. |
| Jobs missing | worker registry + enqueue in `effects` | Another queue (Inngest, Trigger.dev, pg-boss, Agenda, Temporal activities, Huey, arq). Register the worker with its handler range; detect the enqueue call. |
| Outside service missing | `SDK_JS` / `SDK_PY` | Add the package → display name. Calls that never leave the process (signature checks) go in `LOCAL_SDK_CALL`. |

Every effect must be pushed with its offset so `ev()` records `file:line`. Re-run `check.mjs` — its evidence pass confirms the new hops still match the code.
