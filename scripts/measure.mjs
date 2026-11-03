#!/usr/bin/env node
// Real numbers instead of estimates.
//
//   node measure.mjs <outDir> --traces <export.json> [--sample-rate 0.1] [--window 3600]
//   node measure.mjs <outDir> --metrics <metrics.json>
//   add --label "Tempo, production, last hour" to name the source on the page
//
// Reads production traces exported from your monitoring tool and matches every
// recorded call to a hop in the code map (system.json). Writes <outDir>/measured.json
// with, per hop: calls per second, p50 and p95 latency, error rate; per request type:
// real traffic; per queue: time jobs wait and how many run at once.
//
// Trace formats: OpenTelemetry OTLP JSON (one export, or one per line as the collector's
// file exporter writes), Jaeger JSON ("Download JSON" in the Jaeger UI, Tempo/Grafana
// exports in Jaeger format) and Zipkin v2 JSON.
//
// Privacy: only aggregates are kept — counts, durations, and the names of routes,
// tables, queues and hosts. No attribute values, ids, payloads or user data are written.
import fs from "node:fs";
import path from "node:path";

const a = process.argv.slice(2);
const outDir = path.resolve(a.find((x, i) => !x.startsWith("--") && !a[i - 1]?.startsWith("--")) || "xray-out");
const opt = (k) => { const i = a.indexOf(k); return i > -1 ? a[i + 1] : null; };
const tracesFile = opt("--traces"), metricsFile = opt("--metrics");
const sampleRate = +(opt("--sample-rate") || 1);
if (!tracesFile && !metricsFile) { console.error("Give --traces <file> and/or --metrics <file>. See references/real-data.md."); process.exit(1); }
if (!(sampleRate > 0 && sampleRate <= 1)) { console.error("--sample-rate must be between 0 and 1 (e.g. 0.1 if 10% of requests are traced)"); process.exit(1); }
const system = JSON.parse(fs.readFileSync(path.join(outDir, "system.json"), "utf8"));
const config = (() => { try { return JSON.parse(fs.readFileSync(path.join(outDir, "xray.config.json"), "utf8")); } catch { return {}; } })();

const NODES = Object.fromEntries(system.nodes.map((n) => [n.id, n]));
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const tok = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "").replace(/(ies)$/, "y").replace(/s$/, "");

const out = { source: null, generatedAt: new Date().toISOString(), sampleRate, windowSec: 0, spans: 0, traces: 0, mapped: 0, hops: {}, entries: {}, queues: {}, unexpected: [], notes: [] };

// =============================================================== traces → normalized spans
function loadDocs(file) {
  const text = fs.readFileSync(file, "utf8").trim();
  try { return [JSON.parse(text)]; } catch {}
  return text.split(/\n+/).filter(Boolean).map((l) => JSON.parse(l));
}
const attrVal = (v) => v == null ? null : v.stringValue ?? (v.intValue != null ? Number(v.intValue) : null) ?? v.doubleValue ?? v.boolValue ?? null;
const OTLP_KIND = { 1: "internal", 2: "server", 3: "client", 4: "producer", 5: "consumer" };
function normalize(docs) {
  const spans = [];
  for (const d of docs) {
    if (d.resourceSpans) {
      out.source ||= "OpenTelemetry";
      for (const rs of d.resourceSpans) {
        const res = Object.fromEntries((rs.resource?.attributes || []).map((x) => [x.key, attrVal(x.value)]));
        for (const ss of rs.scopeSpans || rs.instrumentationLibrarySpans || []) for (const s of ss.spans || []) {
          const at = Object.fromEntries((s.attributes || []).map((x) => [x.key, attrVal(x.value)]));
          const kind = typeof s.kind === "number" ? OTLP_KIND[s.kind] : String(s.kind || "").replace(/^SPAN_KIND_/, "").toLowerCase();
          const start = Number(s.startTimeUnixNano) / 1e6, end = Number(s.endTimeUnixNano) / 1e6;
          const st = s.status?.code; const error = st === 2 || st === "STATUS_CODE_ERROR" || at["error"] === true;
          spans.push({ trace: s.traceId, id: s.spanId, parent: s.parentSpanId || null, links: (s.links || []).map((l) => l.spanId), service: res["service.name"], name: s.name, kind: kind || "internal", start, dur: end - start, at, error });
        }
      }
    } else if (Array.isArray(d.data) && d.data[0]?.spans) {
      out.source ||= "Jaeger";
      for (const t of d.data) for (const s of t.spans) {
        const at = Object.fromEntries((s.tags || []).map((x) => [x.key, x.value]));
        const parent = (s.references || []).find((r) => r.refType === "CHILD_OF")?.spanID || null;
        const follows = (s.references || []).filter((r) => r.refType === "FOLLOWS_FROM").map((r) => r.spanID);
        spans.push({ trace: s.traceID, id: s.spanID, parent, links: follows, service: t.processes?.[s.processID]?.serviceName, name: s.operationName, kind: String(at["span.kind"] || "internal").toLowerCase(), start: s.startTime / 1000, dur: s.duration / 1000, at, error: at.error === true || at.error === "true" || at["otel.status_code"] === "ERROR" });
      }
    } else {
      const arr = Array.isArray(d) ? d.flat() : [];
      if (arr.length && arr[0].traceId && ("localEndpoint" in arr[0] || "duration" in arr[0])) {
        out.source ||= "Zipkin";
        for (const s of arr) {
          const at = { ...(s.tags || {}) }; if (s.remoteEndpoint?.serviceName) at["peer.service"] = s.remoteEndpoint.serviceName;
          spans.push({ trace: s.traceId, id: s.id, parent: s.parentId || null, links: [], service: s.localEndpoint?.serviceName, name: s.name, kind: String(s.kind || "internal").toLowerCase(), start: s.timestamp / 1000, dur: (s.duration || 0) / 1000, at, error: "error" in (s.tags || {}) });
        }
      }
    }
  }
  return spans;
}

// =============================================================== spans → nodes
const units = system.nodes.filter((n) => n.kind === "service" || n.kind === "app");
const serviceMap = config.serviceMap || {}; // { "<service.name or span-name prefix>": "<node id>" }
const routeOwner = (method, route) => {
  if (!route) return null;
  const norm = (p) => String(p).replace(/\{[^}]+\}|:[^/]+/g, "*").replace(/\/+$/, "").toLowerCase() || "/";
  const r = (system.routes || []).find((r) => norm(r.path) === norm(route) && (!method || r.method === method || r.method === "ANY"));
  return r || null;
};
function nodeOfSpan(s, byId) {
  if (s._node !== undefined) return s._node;
  const viaMap = Object.entries(serviceMap).find(([k]) => s.service === k || s.name?.startsWith(k));
  let n = viaMap ? viaMap[1] : null;
  const file = s.at["code.filepath"] || s.at["code.file.path"];
  if (!n && file) n = units.filter((u) => u.path && u.path !== "." && String(file).includes(u.path)).sort((x, y) => y.path.length - x.path.length)[0]?.id || null;
  if (!n && s.kind === "server") { const r = routeOwner(s.at["http.request.method"] || s.at["http.method"], s.at["http.route"]); if (r) n = r.unit; }
  if (!n) { const hay = `${s.at["code.namespace"] || ""} ${s.at["code.function"] || ""} ${s.name || ""}`.toLowerCase(); const m = units.filter((u) => u.label && new RegExp(`(^|[^a-z])${u.label.toLowerCase().replace(/[^a-z0-9]/g, ".?")}`).test(hay)).sort((x, y) => y.label.length - x.label.length)[0]; if (m) n = m.id; }
  if (!n && s.service) { const sv = slug(s.service); n = units.find((u) => slug(u.label) === sv || u.id.endsWith(":" + sv))?.id || units.find((u) => sv.includes(slug(u.label)) && slug(u.label).length > 2 && !u.core)?.id || null; }
  if (!n && s.parent && byId.get(s.parent)) { n = nodeOfSpan(byId.get(s.parent), byId); s._inherited = true; }
  if (!n && s.service) { n = units.find((u) => u.core)?.id || null; s._inherited = true; }
  return (s._node = n);
}
function dbTarget(sys) {
  const v = String(sys).toLowerCase();
  const id = /redis|memcache|valkey/.test(v) ? "cache:redis" : /mongo/.test(v) ? "db:mongo" : /supabase/.test(v) ? "db:supabase" : "db:sql";
  return NODES[id] ? id : system.nodes.find((n) => n.kind === "database")?.id || id;
}
function hostOf(s) {
  const url = s.at["url.full"] || s.at["http.url"] || "";
  return s.at["server.address"] || s.at["net.peer.name"] || s.at["http.host"] || (url.match(/^https?:\/\/([^/:]+)/) || [])[1] || s.at["peer.service"] || null;
}
function partnerFor(host) {
  if (!host) return null;
  const h = host.toLowerCase();
  const p = system.nodes.filter((n) => n.kind === "partner").find((n) => { const k = slug(n.label).split("-")[0]; return k.length > 2 && (h.includes(k) || h.includes(n.id.slice(8))); });
  return p ? p.id : null;
}

// =============================================================== hops
const H = {}; // key -> { from,to,kind,durs:[], errors, count, labels:{tok:{durs,errors,count,label}} }
const unexpected = {};
const knownEdges = new Set([...(system.edges || []).map((e) => `${e.from}>${e.to}`), ...system.candidateFlows.flatMap((f) => f.steps.map((s) => `${s.from}>${s.to}`))]);
// who sent this, when the trace can't say: a span that only inherited its owner from its parent
// (e.g. in-process events add no span) defers to the code map if the map knows exactly one sender
const incoming = {}; for (const k of knownEdges) { const [f, t] = k.split(">"); (incoming[t] ||= new Set()).add(f); }
function rec(from, to, kind, label, s, dur = s.dur) {
  if (!from || !to || from === to) return false;
  if (s._inherited && !knownEdges.has(`${from}>${to}`) && incoming[to]?.size === 1) { from = [...incoming[to]][0]; out.reattributed = (out.reattributed || 0) + 1; }
  const key = `${from}>${to}`;
  if (!NODES[from] || !NODES[to] || !knownEdges.has(key)) {
    const u = (unexpected[`${key}|${label}`] ||= { from, to, fromLabel: NODES[from]?.label || from, toLabel: NODES[to]?.label || to.split(":").pop(), kind, label, count: 0 }); u.count++;
    if (!NODES[from] || !NODES[to]) return false;
  }
  const h = (H[key] ||= { from, to, kind, durs: [], errors: 0, count: 0, labels: {} });
  h.durs.push(dur); h.count++; if (s.error) h.errors++;
  const t = tok(label); if (t) { const l = (h.labels[t] ||= { label, durs: [], errors: 0, count: 0 }); l.durs.push(dur); l.count++; if (s.error) l.errors++; }
  return true;
}
const queueWait = {}, queueSpans = {}, entryCount = {};
function measureTraces(spans) {
  const byId = new Map(spans.map((s) => [s.id, s]));
  const children = new Map(); for (const s of spans) if (s.parent) (children.get(s.parent) || children.set(s.parent, []).get(s.parent)).push(s);
  let mapped = 0;
  for (const s of spans) {
    const from = nodeOfSpan(s, byId); let ok = false;
    const dbSys = s.at["db.system"] || s.at["db.system.name"];
    const msgSys = s.at["messaging.system"];
    const dest = s.at["messaging.destination.name"] || s.at["messaging.destination"] || s.at["messaging.kafka.destination"] || s.at["messaging.rabbitmq.routing_key"];
    if ((s.kind === "client" || s.kind === "internal") && dbSys) {
      const table = s.at["db.sql.table"] || s.at["db.collection.name"] || s.at["db.mongodb.collection"] || (String(s.at["db.statement"] || s.at["db.query.text"] || "").match(/\b(?:from|into|update)\s+["`]?(\w+)/i) || [])[1] || s.at["db.operation"] || s.name;
      ok = rec(from, dbTarget(dbSys), "db", table, s);
    } else if (s.kind === "producer" || (msgSys && s.kind === "client")) {
      const q = NODES[`queue:${dest}`] ? `queue:${dest}` : null;
      ok = q ? rec(from, q, "enqueue", dest, s) : rec(from, "bus:events", "emit", dest || s.name, s);
    } else if (s.kind === "consumer") {
      const q = NODES[`queue:${dest}`] ? `queue:${dest}` : null;
      const prod = [s.parent, ...s.links].map((id) => byId.get(id)).find((p) => p && (p.kind === "producer" || p.at["messaging.system"]));
      if (q) { ok = rec(q, from, "consume", dest, s); (queueSpans[q] ||= []).push([s.start, s.start + s.dur]); if (prod) (queueWait[q] ||= []).push(Math.max(0, s.start - (prod.start + prod.dur))); }
      else ok = rec("bus:events", from, "deliver", dest || s.name, s);
    } else if (s.kind === "client") {
      const child = (children.get(s.id) || []).find((c) => c.kind === "server");
      const host = hostOf(s);
      const to = child ? nodeOfSpan(child, byId) : partnerFor(host) || (host ? `partner:${slug(host.replace(/^(api|www)\./, "").split(".").slice(0, -1).join("-") || host)}` : null);
      const label = child ? (child.at["http.route"] || child.name) : `${s.at["http.request.method"] || s.at["http.method"] || ""} ${String(s.at["url.path"] || s.at["http.target"] || s.at["url.full"] || s.at["http.url"] || "").replace(/^https?:\/\/[^/]+/, "").split("?")[0] || s.name}`.trim();
      ok = rec(from, to, child ? "http" : "partner", label, s);
    } else if (s.kind === "server") {
      const parent = s.parent && byId.get(s.parent);
      if (!parent || parent.kind !== "client") {
        const r = routeOwner(s.at["http.request.method"] || s.at["http.method"], s.at["http.route"] || s.name.replace(/^[A-Z]+\s+/, ""));
        if (r) { entryCount[r.id] = (entryCount[r.id] || 0) + 1; ok = true; }
      } else ok = true;
    } else if (s.kind === "internal" && s.parent) {
      const p = byId.get(s.parent); const pn = p && nodeOfSpan(p, byId);
      if (pn && from && pn !== from) ok = rec(pn, from, "call", s.at["code.function"] ? `${s.at["code.namespace"] || ""}.${s.at["code.function"]}`.replace(/^\./, "") : s.name, s);
      else ok = !!from;
    } else ok = !!from;
    if (ok) mapped++;
  }
  return mapped;
}

// =============================================================== run
const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
let windowSec = +(opt("--window") || 0);
if (tracesFile) {
  const spans = normalize(loadDocs(tracesFile));
  if (!spans.length) { console.error(`No spans found in ${tracesFile}. Supported: OpenTelemetry OTLP JSON, Jaeger JSON, Zipkin v2 JSON.`); process.exit(1); }
  out.spans = spans.length; out.traces = new Set(spans.map((s) => s.trace)).size;
  out.mapped = measureTraces(spans);
  const t0 = Math.min(...spans.map((s) => s.start)), t1 = Math.max(...spans.map((s) => s.start + s.dur));
  windowSec ||= Math.max(1, (t1 - t0) / 1000);
  out.windowSec = Math.round(windowSec);
  const scale = 1 / sampleRate / windowSec;
  for (const [k, h] of Object.entries(H)) out.hops[k] = {
    from: h.from, to: h.to, kind: h.kind, count: h.count, rps: r1(h.count * scale), p50: r1(pct(h.durs, 0.5)), p95: r1(pct(h.durs, 0.95)), errorRate: Math.round((h.errors / h.count) * 1000) / 1000,
    labels: Object.fromEntries(Object.entries(h.labels).map(([t, l]) => [t, { label: l.label, count: l.count, p50: r1(pct(l.durs, 0.5)), p95: r1(pct(l.durs, 0.95)), errorRate: Math.round((l.errors / l.count) * 1000) / 1000 }])),
  };
  for (const [id, c] of Object.entries(entryCount)) out.entries[id] = { count: c, rps: r1(c * scale) };
  for (const q of new Set([...Object.keys(queueWait), ...Object.keys(queueSpans)])) {
    const iv = (queueSpans[q] || []).flatMap(([s, e]) => [[s, 1], [e, -1]]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    let cur = 0, max = 0; for (const [, d] of iv) { cur += d; max = Math.max(max, cur); }
    out.queues[q] = { waitP50: r1(pct(queueWait[q] || [], 0.5)), waitP95: r1(pct(queueWait[q] || [], 0.95)), observedConcurrency: max || null, jobs: (queueSpans[q] || []).length };
  }
  out.unexpected = Object.values(unexpected).sort((x, y) => y.count - x.count).slice(0, 25);
  if (sampleRate === 1) out.notes.push("Traffic assumes every request was traced. If your tracing samples, pass --sample-rate (e.g. 0.1 for 10%).");
}
if (metricsFile) {
  // hand-filled numbers from any dashboard (Datadog, Grafana, New Relic, CloudWatch…)
  const m = JSON.parse(fs.readFileSync(metricsFile, "utf8"));
  out.source = out.source ? `${out.source} + ${m.source || "metrics file"}` : (m.source || "metrics file");
  if (m.windowSec) out.windowSec = m.windowSec;
  const nodeId = (x) => NODES[x] ? x : system.nodes.find((n) => slug(n.label) === slug(x) || n.id.endsWith(":" + slug(x)))?.id || null;
  for (const h of m.hops || []) {
    const from = nodeId(h.from), to = nodeId(h.to);
    if (!from || !to) { out.notes.push(`metrics: no node matches "${!from ? h.from : h.to}" — use a label or id from system.json`); continue; }
    const key = `${from}>${to}`; const prev = out.hops[key] || { from, to, kind: "metrics", labels: {} };
    out.hops[key] = { ...prev, rps: h.rps ?? prev.rps ?? null, p50: h.p50Ms ?? prev.p50 ?? null, p95: h.p95Ms ?? prev.p95 ?? null, errorRate: h.errorRate ?? prev.errorRate ?? 0, count: prev.count || null };
    if (h.label) prev.labels[tok(h.label)] = { label: h.label, p50: h.p50Ms ?? null, p95: h.p95Ms ?? null, errorRate: h.errorRate ?? 0 };
  }
  for (const e of m.entries || []) {
    const r = (system.routes || []).find((r) => `${r.method} ${r.path}` === e.route || r.id === e.route);
    if (r) out.entries[r.id] = { rps: e.rps }; else out.notes.push(`metrics: no route "${e.route}" — use "METHOD /path" as in system.json routes`);
  }
  for (const q of m.queues || []) { const id = nodeId(q.name) || (NODES[`queue:${q.name}`] ? `queue:${q.name}` : null); if (id) out.queues[id] = { ...(out.queues[id] || {}), observedConcurrency: q.concurrency ?? out.queues[id]?.observedConcurrency ?? null, waitP50: q.waitP50Ms ?? out.queues[id]?.waitP50 ?? null }; }
}
if (opt("--label")) out.source = opt("--label"); // e.g. "Datadog, production, last hour"
fs.writeFileSync(path.join(outDir, "measured.json"), JSON.stringify(out, null, 2));

// =============================================================== report
const hopCount = Object.keys(out.hops).length, planned = new Set(system.candidateFlows.flatMap((f) => f.steps.map((s) => `${s.from}>${s.to}`))).size;
console.log(`measured from ${out.source}${out.spans ? `: ${out.spans} spans in ${out.traces} traces over ${Math.round(out.windowSec / 60)} min` : ""}`);
if (out.reattributed) console.log(`  ${out.reattributed} calls had no owner of their own in the trace; credited to the only sender the code shows`);
if (out.spans) console.log(`  matched ${out.mapped} of ${out.spans} spans (${Math.round((out.mapped / out.spans) * 100)}%) to the code map`);
console.log(`  real numbers for ${hopCount} hops, ${Object.keys(out.entries).length} entry points, ${Object.keys(out.queues).length} queues`);
for (const h of Object.values(out.hops).sort((x, y) => (y.p50 || 0) - (x.p50 || 0)).slice(0, 6)) console.log(`   ${(NODES[h.from]?.label + " → " + NODES[h.to]?.label).padEnd(34)} p50 ${String(h.p50 ?? "–").padStart(6)} ms  p95 ${String(h.p95 ?? "–").padStart(6)} ms  ${h.rps ?? "–"}/s${h.errorRate ? `  ${(h.errorRate * 100).toFixed(1)}% errors` : ""}`);
if (out.unexpected.length) { console.log(`\n  seen in production but not in the code map (${out.unexpected.length}) — worth a look:`); for (const u of out.unexpected.slice(0, 8)) console.log(`   ${u.fromLabel} → ${u.toLabel}  ${u.label}  ×${u.count}`); }
for (const n of out.notes) console.log(`  note: ${n}`);
console.log(`  wrote ${path.relative(process.cwd(), path.join(outDir, "measured.json"))} — rebuild to use it`);
if (out.spans && out.mapped / out.spans < 0.5) console.log(`\n  ⚠ under half the spans matched. Check service names: add "serviceMap": { "<service.name>": "<node id>" } to xray.config.json.`);
