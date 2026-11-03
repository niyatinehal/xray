# Examples

Small codebases written to exercise the scanner. Each one has a regression test in `test/scan.test.mjs` pinning down the flows a person reading the code would trace.

| Example | Stack | The flow worth watching |
|---|---|---|
| `nest-shop` | NestJS modules, TypeORM, event emitter, Bull, Stripe, Resend | an order goes through inventory, payments and Stripe, then an event triggers the receipt email queue |
| `next-ai-app` | Next.js app router, server actions, Prisma, OpenAI, Upstash Redis | the browser asks for a draft: rate limit, project lookup, OpenAI call, save |
| `fastapi-rides` | FastAPI, SQLAlchemy, Redis, Celery, Mapbox, Stripe | a ride request: database, cache, Mapbox, then a queued push notification |
| `payments-monorepo` | Express services, Prisma, shared event bus, BullMQ, partner clients | a payment webhook crosses five services; take the payout partner down to watch the queue stall |
| `go-manual` | Go (not scanned) | a hand-written `system.json`, showing the format for languages the scanner doesn't read |

Try one:

```bash
npm run demo            # nest-shop → examples/nest-shop/xray-out/xray.html
node scripts/scan.mjs examples/fastapi-rides && node scripts/build.mjs examples/fastapi-rides/xray-out
mkdir -p examples/go-manual/xray-out && cp examples/go-manual/system.json examples/go-manual/xray-out/ && node scripts/build.mjs examples/go-manual/xray-out
```
