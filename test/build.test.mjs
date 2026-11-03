// The build accepts scanned and hand-written maps, and rejects broken ones with clear errors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = (...a) => spawnSync(process.execPath, a, { encoding: "utf8" });

test("scanned example builds into one self-contained page", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xray-"));
  execFileSync(process.execPath, [path.join(root, "scripts/scan.mjs"), path.join(root, "examples/nest-shop"), "--out", path.join(dir, "system.json")]);
  const r = node(path.join(root, "scripts/build.mjs"), dir);
  assert.equal(r.status, 0, r.stderr);
  const html = fs.readFileSync(path.join(dir, "xray.html"), "utf8");
  assert.ok(html.length < 1024 * 1024, "page should stay under 1 MB");
  assert.ok(!/<script[^>]+src=/.test(html), "no external scripts — works offline");
});

test("hand-written map (go-manual) builds", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xray-"));
  fs.copyFileSync(path.join(root, "examples/go-manual/system.json"), path.join(dir, "system.json"));
  const r = node(path.join(root, "scripts/build.mjs"), dir);
  assert.equal(r.status, 0, r.stderr);
});

test("broken map is rejected with readable errors", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xray-"));
  fs.writeFileSync(path.join(dir, "system.json"), JSON.stringify({ nodes: [{ id: "service:a", kind: "service" }], candidateFlows: [{ title: "x", steps: [{ from: "service:a", to: "db:nope", kind: "query" }] }] }));
  const r = node(path.join(root, "scripts/build.mjs"), dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /kind "query" must be one of/);
  assert.match(r.stderr, /"db:nope" is not a node id/);
  assert.match(r.stderr, /needs evidence/);
});

test("redact hides file paths and code", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xray-"));
  execFileSync(process.execPath, [path.join(root, "scripts/scan.mjs"), path.join(root, "examples/nest-shop"), "--out", path.join(dir, "system.json")]);
  node(path.join(root, "scripts/build.mjs"), dir, "--init");
  const cfgPath = path.join(dir, "xray.config.json"); const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); cfg.redact = true; fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  assert.equal(node(path.join(root, "scripts/build.mjs"), dir).status, 0);
  const html = fs.readFileSync(path.join(dir, "xray.html"), "utf8");
  assert.ok(!html.includes("orders.service.ts"), "file names must not appear");
  assert.ok(!html.includes("paymentIntents.create({"), "code lines must not appear");
});
