#!/usr/bin/env node
// Builds the simulator page: system.json (from scan.mjs) + xray.config.json -> xray.html
// One self-contained file, three.js inlined, works offline.
//
// Usage: node build.mjs <outDir>            (reads <outDir>/system.json, <outDir>/xray.config.json)
//        node build.mjs <outDir> --init     (writes a starter xray.config.json and stops)
//
// If no config exists, a starter one is written from the top candidate flows.
// Every number the config adds (latencies, base traffic) is an ESTIMATE and is
// labelled as one on screen. Numbers read from code (worker concurrency,
// partner timeouts, retry counts) carry their file:line evidence.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(here, "..");
const outDir = path.resolve(process.argv[2] || "xray-out");
const initOnly = process.argv.includes("--init");
const systemPath = path.join(outDir, "system.json");
const configPath = path.join(outDir, "xray.config.json");

if (!fs.existsSync(systemPath)) { console.error(`No ${systemPath}. Run scan.mjs first.`); process.exit(1); }
const system = JSON.parse(fs.readFileSync(systemPath, "utf8"));

// ---------- validate (hand-written maps go through the same door as scanned ones)
{
  const KINDS = new Set(["service", "app", "database", "bus", "queue", "partner", "external"]);
  const STEPS = new Set(["http", "call", "db-read", "db-write", "emit", "deliver", "enqueue", "consume", "partner"]);
  const errs = [];
  system.nodes ||= []; system.edges ||= []; system.candidateFlows ||= []; system.routes ||= []; system.unresolved ||= {};
  system.repo ||= path.basename(path.resolve(outDir, ".."));
  const ids = new Set();
  for (const n of system.nodes) {
    if (!n.id || !n.kind) { errs.push(`node without id/kind: ${JSON.stringify(n).slice(0, 80)}`); continue; }
    if (!KINDS.has(n.kind)) errs.push(`node ${n.id}: kind "${n.kind}" must be one of ${[...KINDS].join(", ")}`);
    if (n.kind === "bus" && n.id !== "bus:events") errs.push(`node ${n.id}: the event bus must have id "bus:events"`);
    n.label ||= n.id.split(":").pop();
    if (n.kind === "service" || n.kind === "app") { n.routes ||= []; n.emits ||= []; n.listens ||= []; n.workers ||= []; n.domains ||= []; n.fileCount ||= 0; }
    if (n.kind === "queue") n.consumers ||= [];
    ids.add(n.id);
  }
  system.candidateFlows.forEach((f, i) => {
    f.id ||= `flow:${i}`; f.trigger ||= f.id; f.title ||= f.steps?.[0]?.label || f.id; f.score ??= f.steps?.length || 0;
    (f.steps || []).forEach((st, j) => {
      const where = `flow "${f.title}" step ${j}`;
      if (!STEPS.has(st.kind)) errs.push(`${where}: kind "${st.kind}" must be one of ${[...STEPS].join(", ")}`);
      for (const k of ["from", "to"]) if (!ids.has(st[k])) errs.push(`${where}: ${k} "${st[k]}" is not a node id`);
      if (!st.evidence?.file || !st.evidence?.line) errs.push(`${where}: needs evidence { file, line } — every hop must point at real code`);
      st.label ||= st.kind;
    });
  });
  const st = (system.stats ||= {});
  st.files ??= 0; st.events ??= system.nodes.find((n) => n.kind === "bus")?.events?.length || 0;
  if (errs.length) { console.error("system.json problems:\n  " + errs.slice(0, 30).join("\n  ")); process.exit(1); }
}

// ---------- starter config ----------
function starterConfig() {
  const picked = []; const seenTrigger = new Set();
  for (const f of system.candidateFlows) {
    const svc = String(f.trigger || f.id).split(":")[1];
    if (seenTrigger.has(svc) && picked.length >= 2) continue;
    if (f.steps.length < 3 && system.candidateFlows.length > 1) continue;
    picked.push(f); seenTrigger.add(svc);
    if (picked.length === 3) break;
  }
  const partners = system.nodes.filter((n) => n.kind === "partner");
  // rough, labelled guesses by kind of service — replace with real p50s if you have them
  const guessMs = (p) => /openai|anthropic|gemini|mistral|groq|cohere|replicate|llm|gpt|claude/i.test(p.label + p.id) ? 2500
    : /email|smtp|resend|sendgrid|postmark|mailchimp|ses\b/i.test(p.label + p.id) ? 300
    : /stripe|paypal|braintree|razorpay|plaid|payment|pay\b/i.test(p.label + p.id) ? 450
    : /s3|storage|blob|cloudinary/i.test(p.label + p.id) ? 150 : 350;
  const pretty = (s) => s.replace(/[-_]+/g, " ").replace(/\b(api|app|monorepo|backend|server|service)\b/gi, "").trim().replace(/\b\w/g, (c) => c.toUpperCase()) || s;
  return {
    title: pretty(system.repo),
    subtitle: "Every block, pipe and gauge below is read from the code.",
    flows: picked.map((f) => ({ from: f.id, title: f.title, caption: "", hideBranches: ["failure"] })),
    traffic: { baseRps: 8, maxMultiplier: 20, flowMix: Object.fromEntries(picked.map((f) => [f.id, 1])) },
    estimates: {
      note: "Hop latencies are estimates, not measurements. Replace with real p50s from your APM to make the gauges honest.",
      hopMs: { http: 35, call: 1, "db-read": 4, "db-write": 9, emit: 2, deliver: 12, enqueue: 3, consume: 25, partner: 400 },
      serviceCapacityRps: Object.fromEntries(system.nodes.filter((n) => n.kind === "service").map((n) => [n.id, 400])),
      partnerLatencyMs: Object.fromEntries(partners.map((p) => [p.id, guessMs(p)])),
      partnerRetries: Object.fromEntries(partners.map((p) => [p.id, 3])),
    },
    redact: false,
    assumptions: [],
  };
}
if (!fs.existsSync(configPath) || initOnly) {
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(starterConfig(), null, 2));
    console.log(`wrote starter ${path.relative(process.cwd(), configPath)} — edit flows, titles and captions, then build again`);
  } else console.log(`${configPath} already exists`);
  if (initOnly) process.exit(0);
}
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

// ---------- resolve flows ----------
const byId = Object.fromEntries(system.candidateFlows.map((f) => [f.id, f]));
const problems = [];
const flows = config.flows.map((cf, i) => {
  let steps = cf.steps || byId[cf.from]?.steps;
  if (!steps) { problems.push(`flow ${i} ("${cf.title}"): no candidate flow "${cf.from}" and no inline steps`); return null; }
  steps = steps.filter((s) => !(cf.hideBranches || []).includes(s.branch));
  if (cf.include) steps = cf.include.map((k) => steps[k]).filter(Boolean);
  return { id: cf.from || `flow:${i}`, title: cf.title, caption: cf.caption || "", steps, failureSteps: (cf.steps || byId[cf.from]?.steps || []).filter((s) => s.branch === "failure") };
}).filter(Boolean);

const nodeIds = new Set(system.nodes.map((n) => n.id));
for (const f of flows) for (const s of f.steps) for (const id of [s.from, s.to]) if (!nodeIds.has(id)) problems.push(`flow "${f.title}": step references unknown node ${id}`);
if (problems.length) { console.error("config problems:\n  " + problems.join("\n  ")); process.exit(1); }

// ---------- redaction (for posting publicly) ----------
let data = { system, config, flows, builtAt: new Date().toISOString() };
if (config.redact) {
  const mapFile = new Map();
  const hide = (f) => { if (!mapFile.has(f)) mapFile.set(f, `file-${String(mapFile.size + 1).padStart(2, "0")}.js`); return mapFile.get(f); };
  const walk = (o) => {
    if (Array.isArray(o)) return o.map(walk);
    if (o && typeof o === "object") {
      const r = {};
      for (const [k, v] of Object.entries(o)) {
        if (k === "file" && typeof v === "string") r[k] = hide(v);
        else if (k === "code") r[k] = "";
        else if (k === "path" && typeof v === "string" && v.includes("/")) r[k] = v.split("/").slice(0, 2).join("/");
        else r[k] = walk(v);
      }
      return r;
    }
    return o;
  };
  data = walk(data);
}

// ---------- inline three.js ----------
const require = createRequire(path.join(skillRoot, "package.json"));
let three;
const threeCands = [path.join(skillRoot, "node_modules/three/build/three.min.js")];
try { threeCands.push(path.join(path.dirname(require.resolve("three")), "three.min.js")); } catch {}
try { three = fs.readFileSync(threeCands.find((p) => fs.existsSync(p)), "utf8"); }
catch { console.error("three.js not found. Run `npm install` in the skill folder."); process.exit(1); }

const template = fs.readFileSync(path.join(skillRoot, "assets/viewer.html"), "utf8");
const json = JSON.stringify(data).replace(/</g, "\\u003c");
const html = template
  .replace("/*__THREE__*/", () => three)
  .replace("/*__XRAY_DATA__*/null", () => json)
  .replace("__XRAY_TITLE__", () => (config.title || system.repo).replace(/[<>&]/g, ""));
const outFile = path.join(outDir, "xray.html");
fs.writeFileSync(outFile, html);
const kb = Math.round(Buffer.byteLength(html) / 1024);
console.log(`built ${path.relative(process.cwd(), outFile)} (${kb} KB, ${flows.length} flows, ${system.nodes.length} nodes)${config.redact ? " [redacted]" : ""}`);
if (kb > 1024) console.log("  warning: over 1 MB — link previews on social sites may not render");
