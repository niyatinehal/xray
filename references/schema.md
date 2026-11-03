# Formats

## system.json — the model everything reads

Written by `scan.mjs`, or by hand (`manual.md`). `build.mjs` validates it and prints clear errors.

```jsonc
{
  "repo": "shopfront",
  "stats": { "files": 140 },                         // optional, shown in the intro caption
  "nodes": [ Node, … ],
  "candidateFlows": [ { "id": "flow:orders:create", "title": "POST /orders", "steps": [ Step, … ] } ],
  "unresolved": { "eventsWithoutListener": [], "listenersNeverTriggered": [] }   // optional findings
}
```

### Node
| kind | id convention | drawn as | useful fields |
|---|---|---|---|
| `service` | `service:<name>` | graphite block, one floor per part | `label`, `path`, `fileCount`, `domains` (the floors), `routes[]`, `emits[]`, `listens[]`, `workers[]` |
| `app` | `app:<name>` | a screen (frontend that only calls out) | `label` |
| `external` | `external:client` / `external:browser` / `external:webhook` | a screen at the left | `label` |
| `database` | `db:sql`, `db:mongo`, `db:supabase`, `cache:redis` | stacked drums (cache: smaller, red rings) | `label` ("Postgres"), `models[]` |
| `bus` | **must be** `bus:events` | the rail in front | `label` ("Kafka"), `events[]` |
| `queue` | `queue:<name>` | glass tank that fills | `owner`, `consumers[]`, `concurrency`, `concurrencyEnv`, `evidence` |
| `partner` | `partner:<name>` | tower beyond the wall | `label`, `timeoutMs`, `timeoutEnv`, `retries`, `evidence` |

`routes[]`: `{ method, path, evidence }` · `emits[]`/`listens[]`: `{ event, evidence }` · `workers[]`: `{ queue, concurrency, concurrencyEnv, evidence }`.

### Step
```jsonc
{ "from": "service:orders", "to": "partner:stripe", "kind": "partner", "label": "stripe.paymentIntents.create",
  "evidence": { "file": "src/payments/payments.service.ts", "line": 9, "code": "…" },   // code optional
  "branch": "failure",   // optional: only on the failure path (played when an outside service is down)
  "delayMs": 900000,     // optional: on enqueue/consume of a delayed job
  "async": true }        // optional: deliver/consume hops
```
kinds: `http` (request into a unit) · `call` (in-process hand-off to another module) · `db-read` · `db-write` · `emit` (unit → `bus:events`) · `deliver` (`bus:events` → listener) · `enqueue` (unit → queue) · `consume` (queue → worker's unit) · `partner` (unit → outside service).

Order steps the way they happen: a unit's synchronous work first, then what each async hop triggers.

## xray.config.json — yours to edit

```jsonc
{
  "title": "Shopfront",
  "subtitle": "Our order system, built from the code.",
  "flows": [
    { "from": "flow:orders:POST:/orders", "title": "A customer places an order", "caption": "orders → inventory → Stripe → email",
      "hideBranches": ["failure"], "include": [0, 1, 2, 5] },                 // include: optional step indexes to keep
    { "title": "…", "steps": [ Step, … ] }                                    // or explicit steps
  ],
  "traffic": { "baseRps": 8, "maxMultiplier": 20, "flowMix": { "<flow id>": 2 } },
  "estimates": {
    "hopMs": { "http": 35, "call": 1, "db-read": 4, "db-write": 9, "emit": 2, "deliver": 12, "enqueue": 3, "consume": 25, "partner": 400 },
    "serviceCapacityRps": { "service:orders": 400 },
    "partnerLatencyMs": { "partner:stripe": 450 },
    "partnerRetries": { "partner:stripe": 3 }          // used only when retries weren't found in code
  },
  "redact": false
}
```
The first flow drives the big number and opens the tour; the second closes it. Failure branches are hidden from normal replays and played when an outside service is taken down.
