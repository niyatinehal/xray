# Tracing by hand (any language)

When the scanner can't read the language, or misses most of a repo, you write `xray-out/system.json` yourself. Same output, same checks — the only difference is that you are the tracer. Format: `schema.md`.

## How to trace

1. **Find the units.** Deployables (services, workers, functions) or, for one app, its top-level modules/packages. Aim for 3–10 blocks; fewer is dull, more is unreadable.
2. **Find the entry points.** Go: `http.HandleFunc`, `r.Post(` (chi), `e.POST(` (echo), `gin` routes, gRPC `Register…Server`. Java/Kotlin: `@PostMapping`, `@RestController`, `@KafkaListener`, `@Scheduled`. Ruby: `config/routes.rb`, Sidekiq `perform`. PHP: Laravel `routes/api.php`, jobs. C#: `[HttpPost]`, `MapPost`. Rust: axum `.route(`, actix `#[post]`. Elixir: router + Oban workers.
3. **Pick 2–4 flows** (same criteria as SKILL.md step 2) and follow each from its handler, reading the code. Record every hop that leaves the function's own memory: database read/write, cache, publish to a bus, enqueue a job, call another module/service, call an outside API. Write the file and line you saw it on.
4. **Follow the async hops**: who consumes the queue or topic, and what that consumer does next.
5. **Read the numbers that exist in code**: worker/consumer concurrency, client timeouts, retry counts. Put them on the queue and partner nodes. Leave everything else to `estimates`.

## Rules

- Every step needs `evidence: { file, line }` pointing at the line that does the thing. `check.mjs` re-reads it and fails if the line doesn't mention the step's label — so make labels match the code (`orders.Insert`, `stripe.PaymentIntents.New`).
- Never add a hop you didn't see in code. If you're inferring (e.g. a config-driven route), say so to the person and leave it out of the map.
- The event bus is always `bus:events`; give it a `label` naming the tech (NATS, Kafka, SNS, Pub/Sub…).
- Put conditional error-path steps last in the flow with `"branch": "failure"`.

## Minimal example

```json
{
  "repo": "go-shop",
  "nodes": [
    { "id": "external:client", "kind": "external", "label": "API clients" },
    { "id": "service:orders", "kind": "service", "label": "orders", "domains": ["handler", "repo"] },
    { "id": "service:billing", "kind": "service", "label": "billing" },
    { "id": "db:sql", "kind": "database", "label": "Postgres" },
    { "id": "bus:events", "kind": "bus", "label": "NATS" },
    { "id": "partner:stripe", "kind": "partner", "label": "Stripe" }
  ],
  "candidateFlows": [{ "id": "flow:orders:create", "title": "POST /orders", "steps": [
    { "from": "external:client", "to": "service:orders", "kind": "http", "label": "POST /orders", "evidence": { "file": "internal/orders/handler.go", "line": 3 } },
    { "from": "service:orders", "to": "db:sql", "kind": "db-write", "label": "orders.Insert", "evidence": { "file": "internal/orders/handler.go", "line": 4 } },
    { "from": "service:orders", "to": "service:billing", "kind": "call", "label": "billing.Charge", "evidence": { "file": "internal/orders/handler.go", "line": 6 } },
    { "from": "service:billing", "to": "partner:stripe", "kind": "partner", "label": "stripe.PaymentIntents.New", "evidence": { "file": "internal/billing/billing.go", "line": 4 } },
    { "from": "service:orders", "to": "bus:events", "kind": "emit", "label": "orders.created", "evidence": { "file": "internal/orders/handler.go", "line": 7 } }
  ]}]
}
```
Then `build.mjs` → edit config → `build.mjs` → `check.mjs`, exactly as for a scanned repo.
