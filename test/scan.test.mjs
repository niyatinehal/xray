// Regression tests: each example repo must keep producing the flows a person
// reading its code would trace. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const scan = (example) => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "xray-")), "system.json");
  execFileSync(process.execPath, [path.join(root, "scripts/scan.mjs"), path.join(root, "examples", example), "--out", out], { stdio: "pipe" });
  return JSON.parse(fs.readFileSync(out, "utf8"));
};
const flow = (sys, title) => sys.candidateFlows.find((f) => f.title === title) || assert.fail(`no flow "${title}" — have: ${sys.candidateFlows.map((f) => f.title).join(", ")}`);
const hops = (f) => f.steps.map((s) => `${s.kind} ${s.to}`);
const includesInOrder = (arr, want) => { let i = 0; for (const x of arr) if (x === want[i]) i++; return i === want.length; };

test("nest-shop: order → inventory → Stripe → event → email queue → Resend", () => {
  const s = scan("nest-shop");
  const f = flow(s, "POST /orders");
  assert.ok(includesInOrder(hops(f), ["call service:inventory", "db-write db:sql", "call service:payments", "partner partner:stripe", "emit bus:events", "deliver service:notifications", "enqueue queue:emails", "consume service:notifications", "partner partner:resend"]), hops(f).join("\n"));
  assert.equal(s.nodes.find((n) => n.id === "db:sql").label, "Postgres");
  assert.equal(s.nodes.find((n) => n.id === "queue:emails").concurrency, 5);
});

test("next-ai-app: browser fetch, server action, OpenAI, Redis; Stripe signature check is not a network call", () => {
  const s = scan("next-ai-app");
  const gen = flow(s, "POST /api/generate");
  assert.equal(gen.steps[0].from, "external:browser");
  assert.ok(includesInOrder(hops(gen), ["db-write cache:redis", "db-read db:sql", "partner partner:openai", "db-write db:sql"]), hops(gen).join("\n"));
  assert.equal(flow(s, "createProject()").steps[0].from, "external:browser");
  const hook = flow(s, "POST /api/billing/webhook");
  assert.ok(!hook.steps.some((st) => st.to === "partner:stripe"), "constructEvent must not be drawn as a call to Stripe");
  assert.ok(hops(hook).includes("partner partner:resend"));
});

test("fastapi-rides: SQLAlchemy, Redis, Mapbox, Celery queues with countdown and concurrency", () => {
  const s = scan("fastapi-rides");
  const ride = flow(s, "POST /rides/");
  assert.ok(includesInOrder(hops(ride), ["db-write db:sql", "db-read cache:redis", "partner partner:mapbox", "enqueue queue:notifications", "consume service:rideshare-api", "partner partner:fcm-googleapis"]), hops(ride).join("\n"));
  assert.equal(ride.steps.find((st) => st.kind === "db-write").label, "Ride.add");
  const done = flow(s, "POST /rides/{ride_id}/complete");
  assert.equal(done.steps.find((st) => st.kind === "enqueue").delayMs, 30000);
  assert.equal(s.nodes.find((n) => n.id === "queue:payments").concurrency, 4);
});

test("payments-monorepo: webhook crosses 5 services; failure branch tagged; monolith wrapper traced", () => {
  const s = scan("payments-monorepo");
  const f = flow(s, "POST /public/webhooks/payment");
  assert.ok(includesInOrder(hops(f), ["db-write db:sql", "emit bus:events", "deliver service:gps", "enqueue queue:production-transaction", "consume service:gps", "partner partner:railpay", "deliver service:wallet", "deliver service:common"]), hops(f).join("\n"));
  assert.ok(f.steps.some((st) => st.label === "GPS_TRANSACTION_ATTEMPT_FAILED" && st.branch === "failure"));
  assert.equal(s.nodes.find((n) => n.id === "queue:production-transaction").concurrency, 10);
  assert.equal(s.nodes.find((n) => n.id === "partner:railpay").timeoutMs, 15000);
  const otc = flow(s, "POST /v1/otc/quotes/:id/accept");
  assert.deepEqual(otc.steps.map((st) => st.label).slice(1), ["quote.update", "WITHDRAW_CREATED"], "only the accept() method of the monolith wrapper");
  assert.equal(flow(s, "POST /v1/checkouts").steps.find((st) => st.kind === "enqueue").delayMs, 900000);
});

test("every evidence line exists and mentions its step", () => {
  for (const ex of ["nest-shop", "next-ai-app", "fastapi-rides", "payments-monorepo"]) {
    const s = scan(ex);
    for (const f of s.candidateFlows) for (const st of f.steps) {
      const lines = fs.readFileSync(path.join(root, "examples", ex, st.evidence.file), "utf8").split("\n");
      assert.ok(lines[st.evidence.line - 1]?.trim(), `${ex}: ${st.evidence.file}:${st.evidence.line} is empty`);
    }
  }
});
