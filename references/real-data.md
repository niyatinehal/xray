# Real numbers

Without this step every timing and traffic figure is an estimate (labelled "est."). With it, the page uses what production actually did, labels those numbers "measured", and lists calls seen in production that the code map doesn't contain.

```bash
node $X/measure.mjs xray-out --traces <export> [--sample-rate 0.1] [--label "Tempo, prod, last hour"]
node $X/measure.mjs xray-out --metrics metrics.json          # or both together
node $X/build.mjs xray-out                                     # rebuild to use measured.json
```

## Step 1: find out where their numbers live

Ask the person once. Typical answers and what to do:

| They use | Get a trace export |
|---|---|
| Jaeger | Jaeger UI → search the service → open traces → **Download JSON** (or the `/api/traces?service=…&limit=1000` endpoint). |
| Grafana Tempo | Explore → Tempo → run a TraceQL search → export each trace as JSON (OTLP), or query the Tempo API `/api/traces/<id>`. Several files can be concatenated one per line. |
| OpenTelemetry Collector | Add the `file` exporter to the traces pipeline for 10–30 minutes; it writes OTLP JSON, one export per line. |
| Zipkin | `GET /api/v2/traces?serviceName=…&limit=1000` returns Zipkin v2 JSON. |
| Honeycomb, Datadog APM, New Relic, Dynatrace, Sentry | Raw span export varies by plan. Usually quicker: read p50/p95/throughput/error rate from their service or endpoint pages and fill `metrics.json` (below). If their connector is available in this session, read the numbers through it. |
| Prometheus / Grafana dashboards / CloudWatch | Fill `metrics.json` from the dashboards. |
| Nothing yet | Stay on estimates. Mention that adding OpenTelemetry auto-instrumentation is usually a few lines and makes this step possible. |

10–30 minutes of normal traffic is plenty. **Ask about sampling**: if only 10% of requests are traced, pass `--sample-rate 0.1`, or traffic will read 10× too low (latency is unaffected).

## Step 2: run it and read the report

`measure.mjs` prints how many spans matched the code map, the slowest hops, and calls **seen in production but not in the code map**. Read that last list carefully and tell the person; it's often the most valuable output:

- a real dependency the scanner missed (dynamic client, generated SDK) → add it to the map
- a call they didn't know about (a library phoning home, a leftover integration) → a finding in its own right

If under half the spans match, service names in the traces don't match the units. Add to `xray.config.json`:

```json
"serviceMap": { "shopfront-api": "service:orders", "PaymentsService": "service:payments" }
```
Keys are a `service.name` or a span-name prefix; values are node ids from `system.json`.

How spans are matched: `code.filepath` → the unit owning that folder; server spans → the unit owning `http.route`; otherwise a unit whose name appears in the span or `code.function`; otherwise the `service.name`; otherwise the parent span's unit. Targets: `db.system` → database; `messaging.destination.name` → queue (or the event bus); HTTP client spans → the service whose server span is the child, else an outside service matched by host. When a span only inherited its owner and the code shows exactly one sender for that target, the code wins (in-process events add no span, so this prevents false alarms).

## metrics.json — numbers from any dashboard

```json
{
  "source": "Datadog, production, last 24 h",
  "windowSec": 86400,
  "entries": [ { "route": "POST /orders", "rps": 3.4 } ],
  "hops": [
    { "from": "payments", "to": "Stripe", "p50Ms": 410, "p95Ms": 980, "rps": 3.1, "errorRate": 0.008 },
    { "from": "orders", "to": "Postgres", "label": "orders", "p50Ms": 6, "p95Ms": 21 }
  ],
  "queues": [ { "name": "emails", "concurrency": 5, "waitP50Ms": 180 } ]
}
```
`from` / `to` are node labels or ids from `system.json`; `route` is `METHOD /path` as in `system.json` routes. Only fill what you know: anything missing stays estimated and labelled as such.

## What the page does with it

- Leaf hops (database, outside calls, queue writes, events) use their measured p50. Hops that wrap other work (a request into another service, a hand-off, a job) show their measured time in the inspector but don't add it to the end-to-end sum, which would count the work inside them twice.
- Traffic at 1× is the measured traffic per request type; the slider multiplies it.
- Measured error rates on outside calls feed "failing/s" at baseline.
- Measured queue wait is added to the model's backlog wait; workers seen running at once fill in a worker count the code didn't reveal.
- The end-to-end caption says how many hops are measured ("measured 10 of 12 hops").

## Privacy

`measured.json` keeps only aggregates: counts, timings, error rates, and the names of routes, tables, queues and hosts. No trace or span ids, attribute values, payloads or user data. Still, keep the raw trace export out of the repo.
