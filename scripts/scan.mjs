#!/usr/bin/env node
// xray scanner — reads a codebase and writes system.json: the one model every
// part of the simulator reads from. Every node, edge and flow step carries
// file:line evidence, so nothing on screen is invented.
//
// Usage: node scan.mjs <repoRoot> [--out xray-out/system.json]
//
// Regex-level, no AST, no dependencies. Covers:
//   JS/TS   Express, Koa, Fastify, Hono, NestJS, Next.js (pages, app router, server actions)
//           Prisma, Drizzle, TypeORM, Mongoose, Sequelize, Knex, Supabase, raw SQL, Redis
//           event emitters / buses, Nest events + microservices, Kafka, Redis pub/sub
//           BullMQ, Bull, Nest Bull
//   Python  FastAPI, Flask, Django (urls.py), SQLAlchemy, Django ORM, pymongo, Redis
//           Celery, Dramatiq, RQ, Redis pub/sub, Kafka, RabbitMQ
//   Both    SDK calls (Stripe, OpenAI, AWS, Twilio, …) and HTTP to other services or hosts
// Anything else: write system.json by hand (references/schema.md) — the build
// and the checks work the same.

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const root = path.resolve(args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--out") || ".");
const outIdx = args.indexOf("--out");
const outFile = path.resolve(outIdx > -1 ? args[outIdx + 1] : path.join(root, "xray-out/system.json"));

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "out", "coverage", ".turbo", "xray-out", "tests", "test", "__tests__", "__pycache__", ".venv", "venv", "env", "migrations", "e2e", "cypress", "storybook-static", ".svelte-kit", "vendor", "site-packages", "fixtures", "mocks", "__mocks__", "public", "static"]);
const JS = /\.(m?js|cjs|ts|tsx|jsx)$/, PY = /\.py$/;
const MAX_FILE_BYTES = 400_000;

// =============================================================== files
const walkCache = new Map();
function walk(dir) {
  if (walkCache.has(dir)) return walkCache.get(dir);
  const files = [];
  (function go(d) {
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".env")) continue; // never read secrets
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) go(p); }
      else if ((JS.test(e.name) || PY.test(e.name)) && !/\.(test|spec|stories|d)\.[jt]sx?$|^test_.*\.py$|_test\.py$|\.config\.[mc]?[jt]s$|^conftest\.py$/.test(e.name)) files.push(p);
    }
  })(dir);
  walkCache.set(dir, files);
  return files;
}
const rel = (p) => path.relative(root, p).split(path.sep).join("/");
const textCache = new Map();
function read(file) {
  if (!textCache.has(file)) { let t = ""; try { if (fs.statSync(file).size < MAX_FILE_BYTES) t = fs.readFileSync(file, "utf8"); } catch {} textCache.set(file, t); }
  return textCache.get(file);
}
const lineStarts = new Map();
function lineAt(file, offset) {
  if (!lineStarts.has(file)) { const t = read(file); const a = [0]; for (let i = 0; i < t.length; i++) if (t[i] === "\n") a.push(i + 1); lineStarts.set(file, a); }
  const a = lineStarts.get(file); let lo = 0, hi = a.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (a[m] <= offset) lo = m; else hi = m - 1; }
  return lo + 1;
}
function ev(file, offset) { const line = lineAt(file, offset); return { file: rel(file), line, code: redact((read(file).split("\n")[line - 1] || "").trim().slice(0, 160)) }; }
function redact(s) {
  return s.replace(/(["'`])(sk_|pk_|rk_|xox|ghp_|AKIA|AIza)[^"'`]{6,}\1/g, "$1[redacted]$1").replace(/(["'`])[A-Za-z0-9+/_-]{32,}\1/g, "$1[redacted]$1");
}
const readJSON = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1")); } catch { return null; } };

// bracket matching that skips strings and comments
function block(text, openIdx) {
  let depth = 0, q = null;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === "\\") i++; else if (c === q) q = null; continue; }
    if (c === "/" && text[i + 1] === "/") { const n = text.indexOf("\n", i); i = n < 0 ? text.length : n; continue; }
    if (c === "/" && text[i + 1] === "*") { const n = text.indexOf("*/", i + 2); i = n < 0 ? text.length : n + 1; continue; }
    if (c === '"' || c === "'" || c === "`") { q = c; continue; }
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") { depth--; if (depth === 0) return [openIdx, i + 1]; }
  }
  return [openIdx, text.length];
}
// python: the indented block of the def/class on the line containing idx
function pyBlock(text, idx) {
  const ls = text.lastIndexOf("\n", idx) + 1;
  const indent = text.slice(ls).match(/^[ \t]*/)[0].length;
  const first = text.indexOf("\n", idx); if (first < 0) return [ls, text.length];
  let end = first + 1;
  while (end < text.length) {
    const le = text.indexOf("\n", end); const line = text.slice(end, le < 0 ? text.length : le);
    if (line.trim() && line.match(/^[ \t]*/)[0].length <= indent && !/^\s*[)\]]/.test(line)) break;
    end = le < 0 ? text.length : le + 1;
  }
  return [ls, end];
}

// =============================================================== units
const hasCode = (dir) => walk(dir).length > 0;
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
function repoName() { const p = readJSON(path.join(root, "package.json")); if (p?.name) return p.name.replace(/^@[^/]+\//, ""); try { const t = fs.readFileSync(path.join(root, "pyproject.toml"), "utf8"); const m = t.match(/^name\s*=\s*["']([^"']+)/m); if (m) return m[1]; } catch {} return path.basename(root); }
function findUnits() {
  const units = [];
  const groupDirs = [["services", "service"], ["apps", "app"], ["packages", "package"], ["libs", "package"], ["workers", "service"], ["functions", "service"]];
  const singleDirs = [["backend", "service"], ["server", "service"], ["api", "service"], ["frontend", "app"], ["web", "app"], ["client", "app"], ["worker", "service"]];
  for (const [dir, kind] of groupDirs) {
    const base = path.join(root, dir); if (!isDir(base)) continue;
    for (const n of fs.readdirSync(base)) { const d = path.join(base, n); if (!n.startsWith(".") && isDir(d) && hasCode(d)) units.push({ id: `${kind}:${n}`, name: n, kind, dir: d }); }
  }
  for (const [dir, kind] of singleDirs) { const d = path.join(root, dir); if (isDir(d) && hasCode(d)) units.push({ id: `${kind}:${dir}`, name: dir, kind, dir: d }); }
  if (!units.filter((u) => u.kind !== "package").length) units.push({ id: `service:${slug(repoName())}`, name: repoName(), kind: "service", dir: root, isRoot: true });
  // a single backend? split it into its modules so the hops between them show
  const backends = units.filter((u) => u.kind === "service");
  if (backends.length === 1) {
    const u = backends[0]; const mods = findModules(u.dir);
    if (mods.length >= 2) { u.isCore = true; for (const m of mods) if (!units.some((x) => x.id === `service:${m.name}`)) units.push({ id: `service:${m.name}`, name: m.name, kind: "service", dir: m.dir, module: true, parent: u.id }); }
  }
  return units;
}
function findModules(base) {
  const tries = ["src/modules", "src/features", "src/domains", "modules", "app/modules", "src/app/modules", "src/services", "app/services", "services", "src/api", "app/api", "src/app/api", "pages/api", "src/pages/api"];
  for (const t of tries) {
    const d = path.join(base, t); if (!isDir(d)) continue;
    const subs = fs.readdirSync(d).filter((n) => !/^[._(]/.test(n) && isDir(path.join(d, n)) && hasCode(path.join(d, n)));
    if (subs.length >= 2) return subs.map((n) => ({ name: n.replace(/^\[|\]$/g, ""), dir: path.join(d, n) }));
  }
  const nest = [...new Set(walk(base).filter((f) => /\.module\.ts$/.test(f) && !/(^|\/)app\.module\.ts$/.test(rel(f))).map((f) => path.dirname(f)))];
  if (nest.length >= 2) return nest.map((d) => ({ name: path.basename(d), dir: d }));
  const dj = walk(base).filter((f) => path.basename(f) === "apps.py").map((f) => path.dirname(f));
  if (dj.length >= 2) return dj.map((d) => ({ name: path.basename(d), dir: d }));
  return [];
}
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const units = findUnits();
const unitOf = (file) => units.filter((u) => file === u.dir || file.startsWith(u.dir + path.sep)).sort((a, b) => b.dir.length - a.dir.length)[0] || units.find((u) => u.isRoot) || units[0];
const allFiles = [...new Set(units.flatMap((u) => walk(u.dir)))];

// =============================================================== tech detection
const deps = new Set();
for (const p of [root, ...units.map((u) => u.dir)]) {
  const pj = readJSON(path.join(p, "package.json")); if (pj) for (const k of Object.keys({ ...pj.dependencies, ...pj.devDependencies })) deps.add(k);
  for (const f of ["requirements.txt", "pyproject.toml", "Pipfile"]) { try { for (const m of fs.readFileSync(path.join(p, f), "utf8").matchAll(/^\s*"?([A-Za-z0-9_.-]+)/gm)) deps.add(m[1].toLowerCase()); } catch {} }
}
const prismaSchema = (() => { const c = []; (function find(d, n = 0) { if (n > 5) return; let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) find(path.join(d, e.name), n + 1); else if (e.name.endsWith(".prisma")) c.push(path.join(d, e.name)); } })(root); return c.map((f) => fs.readFileSync(f, "utf8")).join("\n"); })();
const has = (...names) => names.some((n) => deps.has(n));
const SQL_LABEL = /provider\s*=\s*"postgresql"/.test(prismaSchema) || has("pg", "postgres", "psycopg2", "psycopg2-binary", "psycopg", "asyncpg", "@neondatabase/serverless", "@vercel/postgres") ? "Postgres"
  : /provider\s*=\s*"mysql"/.test(prismaSchema) || has("mysql2", "mysql", "mysqlclient", "pymysql") ? "MySQL"
  : /provider\s*=\s*"sqlite"/.test(prismaSchema) || has("sqlite3", "better-sqlite3", "@libsql/client") ? "SQLite" : "Database";
const STORES = { sql: { id: "db:sql", label: SQL_LABEL }, mongo: { id: "db:mongo", label: "MongoDB" }, supabase: { id: "db:supabase", label: "Supabase" }, cache: { id: "cache:redis", label: "Redis" } };
const BUS_LABEL = has("kafkajs", "kafka-python", "confluent-kafka", "aiokafka") ? "Kafka" : has("amqplib", "pika", "aio-pika", "amqp-connection-manager") ? "RabbitMQ" : "Event bus";

// SDK calls that run locally (no network) — never drawn as a trip outside
const LOCAL_SDK_CALL = /webhooks\.constructEvent|\.(verify\w*|construct\w*|validate\w*|sign\w*|parse\w*|format\w*)$|Webhook\.construct_event|\.Webhook\.verify/;
// SDKs whose calls leave your system
const SDK_JS = [
  [/^stripe$/, "Stripe"], [/^openai$/, "OpenAI"], [/^@anthropic-ai\/sdk$/, "Anthropic"], [/^twilio$/, "Twilio"], [/^@sendgrid\/mail$/, "SendGrid"], [/^resend$/, "Resend"], [/^postmark$/, "Postmark"], [/^nodemailer$/, "Email (SMTP)"],
  [/^@aws-sdk\/client-(.+)$/, (m) => "AWS " + m[1].toUpperCase().replace(/-/g, " ")], [/^aws-sdk$/, "AWS"], [/^@google-cloud\/(.+)$/, (m) => "Google Cloud " + m[1]], [/^@google\/(?:generative-ai|genai)$/, "Gemini"], [/^firebase-admin/, "Firebase"],
  [/^plaid$/, "Plaid"], [/^@paypal\//, "PayPal"], [/^braintree$/, "Braintree"], [/^@slack\/web-api$/, "Slack"], [/^algoliasearch$/, "Algolia"], [/^@pinecone-database\/pinecone$/, "Pinecone"], [/^@octokit\//, "GitHub"], [/^@shopify\//, "Shopify"],
  [/^posthog-node$/, "PostHog"], [/^@segment\/analytics-node$/, "Segment"], [/^cloudinary$/, "Cloudinary"], [/^@clerk\/backend$/, "Clerk"], [/^auth0$/, "Auth0"], [/^@mailchimp\//, "Mailchimp"], [/^@hubspot\//, "HubSpot"], [/^@notionhq\/client$/, "Notion"], [/^@linear\/sdk$/, "Linear"], [/^razorpay$/, "Razorpay"], [/^@vercel\/blob$/, "Vercel Blob"], [/^@upstash\/qstash$/, "QStash"], [/^replicate$/, "Replicate"], [/^@mistralai\//, "Mistral"], [/^groq-sdk$/, "Groq"], [/^cohere-ai$/, "Cohere"], [/^@mux\/mux-node$/, "Mux"], [/^@lemonsqueezy\//, "Lemon Squeezy"],
];
const SDK_PY = [[/^stripe$/, "Stripe"], [/^openai$/, "OpenAI"], [/^anthropic$/, "Anthropic"], [/^boto3$/, "AWS"], [/^twilio/, "Twilio"], [/^sendgrid/, "SendGrid"], [/^resend$/, "Resend"], [/^slack_sdk/, "Slack"], [/^google\.cloud/, "Google Cloud"], [/^google\.(?:generativeai|genai)/, "Gemini"], [/^firebase_admin/, "Firebase"], [/^plaid/, "Plaid"], [/^shopify/, "Shopify"], [/^algoliasearch/, "Algolia"], [/^posthog/, "PostHog"], [/^pinecone/, "Pinecone"], [/^razorpay$/, "Razorpay"], [/^cohere$/, "Cohere"], [/^mistralai/, "Mistral"], [/^groq$/, "Groq"]];
function sdkName(spec, table) { for (const [re, n] of table) { const m = spec.match(re); if (m) return typeof n === "function" ? n(m) : n; } return null; }

// =============================================================== import resolution
const tsconfigs = new Map();
function aliasesFor(file) {
  let d = path.dirname(file);
  while (d.length >= root.length) {
    if (!tsconfigs.has(d)) {
      let cfg = null;
      for (const n of ["tsconfig.json", "jsconfig.json"]) { const p = path.join(d, n); if (fs.existsSync(p)) { const co = (readJSON(p) || {}).compilerOptions || {}; cfg = { base: path.resolve(d, co.baseUrl || "."), paths: co.paths || {}, hasBase: !!co.baseUrl }; break; } }
      tsconfigs.set(d, cfg);
    }
    if (tsconfigs.get(d)) return tsconfigs.get(d);
    if (d === root) break; d = path.dirname(d);
  }
  return null;
}
const workspacePkgs = (() => { const m = {}; for (const u of units) { const pj = readJSON(path.join(u.dir, "package.json")); if (pj?.name) m[pj.name] = u.dir; } return m; })();
function tryFile(base) {
  const b2 = base.replace(/\.(m?js|jsx)$/, "");
  for (const c of [base, b2 + ".ts", b2 + ".tsx", b2 + ".js", b2 + ".jsx", b2 + ".mjs", b2 + ".cjs", path.join(base, "index.ts"), path.join(base, "index.tsx"), path.join(base, "index.js"), path.join(base, "index.mjs")]) { try { if (fs.statSync(c).isFile()) return c; } catch {} }
  return null;
}
function resolveJs(fromFile, spec) {
  if (spec.startsWith(".")) return tryFile(path.resolve(path.dirname(fromFile), spec));
  const a = aliasesFor(fromFile);
  if (a) {
    for (const [pat, targets] of Object.entries(a.paths)) {
      const pre = pat.replace(/\*$/, "");
      if (pat.endsWith("*") ? spec.startsWith(pre) : spec === pat) for (const t of targets) { const r = tryFile(path.resolve(a.base, t.replace(/\*$/, "") + (pat.endsWith("*") ? spec.slice(pre.length) : ""))); if (r) return r; }
    }
    if (a.hasBase) { const r = tryFile(path.resolve(a.base, spec)); if (r) return r; }
  }
  if (spec.startsWith("~/") || spec.startsWith("@/")) { const u = unitOf(fromFile); return tryFile(path.resolve(u.dir, "src", spec.slice(2))) || tryFile(path.resolve(u.dir, spec.slice(2))); }
  for (const [name, dir] of Object.entries(workspacePkgs)) if (spec === name || spec.startsWith(name + "/")) return tryFile(path.join(dir, "src", spec.slice(name.length))) || tryFile(path.join(dir, spec.slice(name.length)));
  return null;
}
function resolvePy(fromFile, mod) {
  const dots = mod.match(/^\.*/)[0].length; const rest = mod.slice(dots).replace(/\./g, "/");
  const bases = dots ? [path.resolve(path.dirname(fromFile), "../".repeat(Math.max(0, dots - 1)))] : [unitOf(fromFile).dir, root, path.join(root, "src"), path.join(unitOf(fromFile).dir, "src"), path.dirname(fromFile)];
  for (const b of bases) for (const c of rest ? [path.join(b, rest + ".py"), path.join(b, rest, "__init__.py")] : [path.join(b, "__init__.py")]) if (fs.existsSync(c)) return c;
  return null;
}

// =============================================================== per-file context
const ctxCache = new Map();
const isPy = (f) => f.endsWith(".py");
const DB_CTORS = new Set(["PrismaClient", "drizzle", "knex", "Knex", "Pool", "createPool", "postgres", "neon", "Sequelize", "DataSource", "createConnection"]);
function ctx(file) {
  if (ctxCache.has(file)) return ctxCache.get(file);
  const c = { imports: {}, sdk: {}, db: {}, models: {}, queues: {}, fields: {}, fns: {} };
  ctxCache.set(file, c);
  const t = read(file);
  const inherit = () => {
    for (const [name, imp] of Object.entries(c.imports)) if (imp.file && imp.file !== file) {
      const o = ctx(imp.file);
      const dflt = (map) => Object.keys(map).find((x) => new RegExp(`export\\s+default\\s+${x}\\b|module\\.exports\\s*=\\s*${x}\\b`).test(read(imp.file)));
      const k = imp.orig === "default" ? dflt(o.sdk) || dflt(o.db) || dflt(o.models) || dflt(o.queues) || name : imp.orig || name;
      if (o.sdk[k] && !c.sdk[name]) c.sdk[name] = o.sdk[k];
      if (o.db[k] && !c.db[name]) c.db[name] = o.db[k];
      if (o.models[k] && !c.models[name]) c.models[name] = o.models[k];
      if (o.queues[k] && !c.queues[name]) c.queues[name] = o.queues[k];
    }
  };
  if (isPy(file)) {
    for (const m of t.matchAll(/^[ \t]*from\s+([.\w]+)\s+import\s+(\([^)]*\)|[^\n]+)/gm)) {
      const target = resolvePy(file, m[1]); const sdk = sdkName(m[1], SDK_PY);
      for (const part of m[2].replace(/[()]/g, "").split(",")) {
        const [a, b] = part.trim().split(/\s+as\s+/); const name = (b || a || "").trim(); if (!/^\w+$/.test(name)) continue;
        c.imports[name] = { spec: m[1], file: resolvePy(file, (m[1].endsWith(".") ? m[1] : m[1] + ".") + a.trim()) || target, orig: a.trim() };
        if (sdk) c.sdk[name] = sdk;
      }
    }
    for (const m of t.matchAll(/^[ \t]*import\s+([\w.]+)(?:\s+as\s+(\w+))?\s*$/gm)) { const name = m[2] || m[1].split(".")[0]; c.imports[name] = { spec: m[1], file: resolvePy(file, m[1]), orig: "*" }; const sdk = sdkName(m[1], SDK_PY); if (sdk) c.sdk[name] = sdk; }
    for (const m of t.matchAll(/^(?:async\s+)?def\s+(\w+)/gm)) c.fns[m[1]] = m.index;
    for (const m of t.matchAll(/^[ \t]*(?:self\.)?(\w+)\s*(?::[^=\n]+)?=\s*boto3\.(?:client|resource)\(\s*["']([\w-]+)/gm)) c.sdk[m[1]] = "AWS " + m[2].toUpperCase();
    for (const m of t.matchAll(/^[ \t]*(?:self\.)?(\w+)\s*(?::[^=\n]+)?=\s*(?:await\s+)?([\w.]+)\(/gm)) {
      const ctor = m[2].split(".").pop(), head = m[2].split(".")[0];
      if ((c.sdk[ctor] || c.sdk[head]) && !c.sdk[m[1]]) c.sdk[m[1]] = c.sdk[ctor] || c.sdk[head];
      if (/^(Redis|StrictRedis|from_url)$/.test(ctor) && /redis/i.test(m[2] + (c.imports[head]?.spec || ""))) c.db[m[1]] = "cache";
      if (/^(MongoClient|AsyncIOMotorClient)$/.test(ctor)) c.db[m[1]] = "mongo";
    }
    inherit();
    return c;
  }
  // ---- JS/TS imports (ESM + CJS)
  for (const m of t.matchAll(/import\s+(?!type\s)(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\}\s*)?(?:\*\s+as\s+(\w+)\s*)?from\s+["']([^"']+)["']/g)) {
    const target = resolveJs(file, m[4]); const sdk = sdkName(m[4], SDK_JS);
    const add = (name, orig) => { if (!name) return; name = name.trim(); if (!/^\w+$/.test(name)) return; c.imports[name] = { spec: m[4], file: target, orig }; if (sdk) c.sdk[name] = sdk; };
    add(m[1], "default"); add(m[3], "*");
    if (m[2]) for (const part of m[2].split(",")) { const p = part.replace(/^\s*type\s+/, ""); const [a, b] = p.split(/\s+as\s+/); add((b || a || "").trim(), (a || "").trim()); }
  }
  for (const m of t.matchAll(/(?:const|let|var)\s+(?:(\w+)|\{([^}]*)\})\s*=\s*require\(\s*["']([^"']+)["']\s*\)/g)) {
    const target = resolveJs(file, m[3]); const sdk = sdkName(m[3], SDK_JS);
    const names = m[1] ? [[m[1], "default"]] : m[2].split(",").map((x) => { const [a, b] = x.split(":"); return [(b || a).trim(), a.trim()]; });
    for (const [n, o] of names) { if (!/^\w+$/.test(n)) continue; c.imports[n] = { spec: m[3], file: target, orig: o }; if (sdk) c.sdk[n] = sdk; }
  }
  // ---- clients created in this file
  for (const m of t.matchAll(/(?:const|let|var)\s+(\w+)\s*(?::[^=;]+)?=\s*(?:await\s+)?(?:new\s+)?(\w+)(?:\.\w+)?\s*(?:<[^>]*>)?\(/g)) {
    const [, v, ctor] = m;
    if (c.sdk[ctor] && !c.sdk[v]) c.sdk[v] = c.sdk[ctor];
    if (DB_CTORS.has(ctor)) c.db[v] = "sql";
    const spec = c.imports[ctor]?.spec || "";
    if (ctor === "createClient" && /@supabase/.test(spec)) c.db[v] = "supabase";
    if ((ctor === "Redis" && /ioredis|redis/.test(spec)) || (ctor === "createClient" && /^redis$/.test(spec)) || (ctor === "Redis" && /@upstash\/redis/.test(spec))) c.db[v] = "cache";
    if (ctor === "MongoClient") c.db[v] = "mongo";
  }
  for (const m of t.matchAll(/(?:const|let|var)\s+(\w+)\s*(?::[^=;]+)?=\s*(?:mongoose\.)?model\s*(?:<[^>]*>)?\(\s*['"](\w+)/g)) c.models[m[1]] = { store: "mongo", model: m[2] };
  for (const m of t.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*\w+\.define\(\s*['"](\w+)/g)) c.models[m[1]] = { store: "sql", model: m[2] };
  for (const m of t.matchAll(/class\s+(\w+)\s+extends\s+Model\b/g)) c.models[m[1]] = { store: "sql", model: m[1] };
  for (const m of t.matchAll(/@Entity\([^)]*\)\s*(?:export\s+)?class\s+(\w+)/g)) c.models[m[1]] = { store: "sql", model: m[1] };
  for (const m of t.matchAll(/@Schema\([^)]*\)\s*(?:export\s+)?class\s+(\w+)/g)) c.models[m[1]] = { store: "mongo", model: m[1] };
  for (const m of t.matchAll(/(?:const|let|var)\s+(\w+)\s*(?::[^=;]+)?=\s*new\s+(?:Queue|Bull)\s*(?:<[^>]*>)?\(\s*([^,)]+)/g)) c.queues[m[1]] = resolveName(m[2]);
  // Nest DI: constructor(private readonly orders: OrdersService, @InjectRepository(Order) private repo: Repository<Order>, @InjectQueue('x') private q: Queue)
  for (const cm of t.matchAll(/constructor\s*\(/g)) {
    const [s, e] = block(t, cm.index + cm[0].length - 1);
    for (const p of t.slice(s + 1, e - 1).split(/,(?![^<(]*[>)])/)) {
      const m = p.match(/(?:@(\w+)\(\s*([^)]*)\)\s*)?(?:private|public|protected|readonly)\s+(?:readonly\s+)?(\w+)\s*:\s*([\w.]+)(?:\s*<\s*(\w+)\s*>)?/); if (!m) continue;
      const [, deco, decoArg, field, type, generic] = m;
      if (deco === "InjectRepository" || deco === "InjectModel") c.fields[field] = { db: deco === "InjectModel" ? "mongo" : "sql", model: (decoArg || generic || type).replace(/\.name$/, "").trim() };
      else if (deco === "InjectQueue") c.fields[field] = { queue: resolveName(decoArg) };
      else if (/Prisma|Drizzle|Database|Db/.test(type)) c.fields[field] = { dbVar: "sql" };
      else if (/Redis|Cache/.test(type)) c.fields[field] = { dbVar: "cache" };
      else if (c.sdk[type]) c.fields[field] = { sdk: c.sdk[type] };
      else if (/EventEmitter|ClientProxy|ClientKafka/.test(type)) c.fields[field] = { bus: true };
      else if (c.imports[type]?.file) c.fields[field] = { file: c.imports[type].file, type };
    }
  }
  for (const m of t.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)\s*\(|(?:^|\n)\s*(?:export\s+)?(?:const|let)\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*(?::[^=]+)?=>/g)) c.fns[m[1] || m[2]] = m.index;
  inherit();
  for (const n of ["prisma", "db"]) if (!c.db[n] && c.imports[n] && !c.imports[n].file) c.db[n] = "sql";
  return c;
}

// =============================================================== constants
const constants = {}, objConsts = {};
for (const f of allFiles) {
  const t = read(f);
  for (const m of t.matchAll(/(?:export\s+)?(?:const\s+)?\b([A-Z][A-Z0-9_]+)\s*(?::\s*\w+\s*)?=\s*["'`]([^"'`$\n]+)["'`]/g)) constants[m[1]] ??= m[2];
  for (const m of t.matchAll(/(?:export\s+)?(?:const|enum)\s+(\w+)\s*(?::[^={]+)?=?\s*\{/g)) {
    const o = t.indexOf("{", m.index); const [s, e] = block(t, o); if (e - s > 20000) continue; const o2 = {};
    for (const k of t.slice(s, e).matchAll(/(\w+)\s*[:=]\s*["'`]([^"'`$\n]+)["'`]/g)) o2[k[1]] = k[2];
    if (Object.keys(o2).length) objConsts[m[1]] = { ...(objConsts[m[1]] || {}), ...o2 };
  }
}
function resolveName(tok) {
  tok = (tok || "").trim();
  const s = tok.match(/^["'`](.+)["'`]$/); if (s) return s[1];
  const d = tok.match(/^(\w+)\.(\w+)$/); if (d) return objConsts[d[1]]?.[d[2]] ?? d[2];
  return constants[tok] || tok;
}
const NAME = String.raw`([A-Z]\w*\.\w+|'[^'\n]+'|"[^"\n]+"|\`[^\`$\n]+\`|[A-Z][A-Z0-9_]{2,})`;
const BUILTIN_EVENTS = new Set("data end error close finish open message connection connect disconnect ready listening exit SIGINT SIGTERM SIGHUP request response drain line change click load uncaughtException unhandledRejection beforeExit warning readable pipe timeout upgrade headers abort progress reconnecting completed failed active stalled waiting".split(" "));
const NOT_BUS = /^(socket|io|ws|wss|server|app|res|req|reply|stream|process|window|document|el|element|child|proc|rl|watcher|page|browser|conn|connection|db|redis|pubClient|subClient|worker|queue|job|router|program|cmd|spinner|form|input|button|map|mongoose|sequelize|knex|pool)$/i;

// =============================================================== registries
const queues = {}, workers = [], listeners = [], partnersDir = {}, routes = [], mounts = {}, tasks = {};
const queueVarGlobal = {};
const evBusTech = new Set();

function addWorker(name, unit, file, range, offset, text) {
  let concurrency = null, concurrencyEnv = null;
  const cm = (text || "").match(/concurrency\s*[:=]\s*(?:Number\(|parseInt\()?\s*process\.env\.(\w+)\s*(?:\|\||\?\?)\s*['"]?(\d+)/) || (text || "").match(/(?:const|let)\s+\w*[cC]oncurrency\w*\s*=\s*(?:Number\(|parseInt\()?\s*process\.env\.(\w+)\s*(?:\|\||\?\?)\s*['"]?(\d+)/);
  if (cm) { concurrencyEnv = cm[1]; concurrency = +cm[2]; }
  else { const lit = (text || "").match(/concurrency\s*[:=]\s*(\d+)/); if (lit) concurrency = +lit[1]; }
  workers.push({ queue: name, unit: unit.id, file, range, concurrency, concurrencyEnv, evidence: ev(file, offset) });
  queues[name] ||= { owner: unit.id, evidence: ev(file, offset) };
}

for (const f of allFiles) {
  const t = read(f), u = unitOf(f);
  if (isPy(f)) { pyRegistries(f, t, u); continue; }
  const c = ctx(f);
  for (const [v, q] of Object.entries(c.queues)) { queueVarGlobal[v] ||= q; const at = t.search(new RegExp(`\\b${v}\\s*(?::[^=;]+)?=\\s*new`)); if (at >= 0) queues[q] ||= { owner: u.id, evidence: ev(f, at) }; }
  for (const m of t.matchAll(/new\s+Worker\s*(?:<[^>]*>)?\(\s*([^,]+),/g)) { const [s, e] = block(t, m.index + m[0].indexOf("(")); addWorker(resolveName(m[1]), u, f, [s, e], m.index, t); }
  for (const m of t.matchAll(/\b(\w+)\.process\(/g)) { const q = c.queues[m[1]]; if (!q) continue; const [s, e] = block(t, m.index + m[0].length - 1); addWorker(q, u, f, [s, e], m.index, t.slice(s, e)); }
  for (const m of t.matchAll(/@Processor\(\s*([^)]+)\)[\s\S]*?class\s+\w+[^{]*\{/g)) { const [s, e] = block(t, m.index + m[0].length - 1); addWorker(resolveName(m[1].split(",")[0].replace(/\{\s*name\s*:\s*/, "")), u, f, [s, e], m.index, t); }
  for (const m of t.matchAll(new RegExp(String.raw`\b(\w+)\.(?:on|once|subscribe|addListener)\(\s*` + NAME + String.raw`\s*,`, "g"))) {
    const name = resolveName(m[2]); if (NOT_BUS.test(m[1]) || BUILTIN_EVENTS.has(name)) continue;
    const [s, e] = block(t, m.index + m[0].indexOf("(")); listeners.push({ event: name, unit: u.id, file: f, range: [s, e], evidence: ev(f, m.index) });
  }
  for (const m of t.matchAll(new RegExp(String.raw`@(OnEvent|EventPattern|MessagePattern)\(\s*` + NAME, "g"))) {
    const after = t.slice(m.index); const mm = after.match(/\)\s*(?:@\w+\([^)]*\)\s*)*(?:public\s+|private\s+)?(?:async\s+)?\w+\s*\([\s\S]*?\)\s*(?::\s*[^{]+)?\{/);
    if (!mm) continue; const [s, e] = block(t, m.index + mm.index + mm[0].length - 1);
    listeners.push({ event: resolveName(m[2]), unit: u.id, file: f, range: [s, e], evidence: ev(f, m.index) });
  }
  for (const m of t.matchAll(/\.subscribe\(\s*\{\s*topics?\s*:\s*\[?([^\]}]+)/g)) for (const tok of m[1].split(",")) { const name = resolveName(tok.trim()); if (!name || /^\w+$/.test(name) && name === tok.trim() && !/^[A-Z]/.test(name)) continue; listeners.push({ event: name, unit: u.id, file: f, range: [m.index, t.length], evidence: ev(f, m.index) }); evBusTech.add("kafka"); }
  const pm = rel(f).match(/\/partners\/([^/]+)\/index\.(?:m?js|ts)$/);
  if (pm && pm[1] !== "base") {
    const toEnv = t.match(/timeoutMs\s*:\s*(?:Number\()?process\.env\.(\w+)\s*\|\|\s*(\d+)/) || t.match(/timeoutMs\s*:\s*()(\d+)/) || [];
    const rt = t.match(/retry(?:Attempts|Count|ies)\s*:\s*(?:Number\()?(?:process\.env\.\w+\s*\|\|\s*)?(\d+)/i);
    partnersDir[pm[1]] = { unit: u.id, file: f, evidence: ev(f, toEnv.index ?? 0), baseUrlEnv: (t.match(/baseUrl\s*:\s*process\.env\.(\w+)/) || [])[1] || null, timeoutEnv: toEnv[1] || null, timeoutMs: toEnv[2] ? +toEnv[2] : null, retries: rt ? +rt[1] : null };
  }
  jsRoutes(f, t, u, c);
}

function jsRoutes(f, t, u, c) {
  const isServerFile = /from\s+["'](express|koa|@koa\/router|koa-router|fastify|hono|hono\/[\w-]+|@hono\/[\w-]+|restify|polka|h3|elysia)["']|require\(\s*["'](express|koa|@koa\/router|koa-router|fastify|hono|restify)["']\)|\bRouter\(\)|express\(\)|new Hono\b|[Ff]astify\(/.test(t);
  for (const m of t.matchAll(/\.(?:use|route)\(\s*["'`]([^"'`]+)["'`]\s*,\s*(?:[\w.]+\s*,\s*)*(\w+)\s*\)/g)) { const imp = c.imports[m[2]]; if (imp?.file) mounts[imp.file] = m[1]; }
  for (const m of t.matchAll(/\.register\(\s*(\w+)\s*,\s*\{\s*prefix\s*:\s*["'`]([^"'`]+)/g)) { const imp = c.imports[m[1]]; if (imp?.file) mounts[imp.file] = m[2]; }
  if (isServerFile) for (const m of t.matchAll(/\b(\w+)\.(get|post|put|patch|delete|all)\(\s*["'`](\/[^"'`]*)["'`]\s*,/g)) {
    if (/^(axios|http|https|client|api|fetch|got|ky|cache|map|redis|params|headers|searchParams|request|superagent|supertest|instance|httpClient|\$fetch|ofetch)$/i.test(m[1])) continue;
    const [s, e] = block(t, m.index + m[0].indexOf("("));
    routes.push({ unit: u.id, file: f, method: m[2].toUpperCase(), localPath: m[3], range: [s, e], offset: m.index, kind: "express" });
  }
  const ctl = t.match(/@Controller\(\s*(?:["'`]([^"'`]*)["'`]|\{[^}]*path\s*:\s*["'`]([^"'`]*)["'`][^}]*\})?\s*\)/);
  if (ctl) {
    const prefix = "/" + (ctl[1] ?? ctl[2] ?? "");
    for (const m of t.matchAll(/@(Get|Post|Put|Patch|Delete|All)\(\s*(?:["'`]([^"'`]*)["'`])?\s*\)/g)) {
      const after = t.slice(m.index); const mm = after.match(/\)\s*(?:@[\w.]+(?:\([^)]*\))?\s*)*(?:public\s+)?(?:async\s+)?(\w+)\s*\(/);
      if (!mm) continue; const po = m.index + mm.index + mm[0].length - 1; const [, pe] = block(t, po); const bo = t.indexOf("{", pe); if (bo < 0) continue; const [s, e] = block(t, bo);
      routes.push({ unit: u.id, file: f, method: m[1].toUpperCase(), path: (prefix + "/" + (m[2] || "")).replace(/\/+/g, "/").replace(/(.)\/$/, "$1"), range: [s, e], offset: m.index, kind: "nest" });
    }
  }
  const r = rel(f);
  const pages = r.match(/(?:^|\/)(?:src\/)?pages\/(api\/.+)\.(?:ts|js|tsx|jsx)$/);
  if (pages) routes.push({ unit: u.id, file: f, method: "ANY", path: "/" + pages[1].replace(/\/index$/, "").replace(/\[\.\.\.(\w+)\]/g, "*").replace(/\[(\w+)\]/g, ":$1"), range: [0, t.length], offset: Math.max(0, t.search(/export\s+default/)), kind: "next" });
  const app = r.match(/(?:^|\/)(?:src\/)?app\/(.*?)\/?route\.(?:ts|js)$/);
  if (app) for (const m of t.matchAll(/export\s+(?:async\s+)?(?:function\s+|const\s+)(GET|POST|PUT|PATCH|DELETE)\b[^{]*\{/g)) {
    const [s, e] = block(t, m.index + m[0].length - 1);
    const p = "/" + app[1].split("/").filter((x) => !/^\(.*\)$/.test(x)).join("/").replace(/\[\.\.\.(\w+)\]/g, "*").replace(/\[(\w+)\]/g, ":$1");
    routes.push({ unit: u.id, file: f, method: m[1], path: p.replace(/\/$/, "") || "/", range: [s, e], offset: m.index, kind: "next" });
  }
  if (/^\s*["']use server["']/.test(t)) for (const m of t.matchAll(/export\s+async\s+function\s+(\w+)\s*\([^)]*\)[^{]*\{/g)) {
    const [s, e] = block(t, m.index + m[0].length - 1);
    routes.push({ unit: u.id, file: f, method: "ACTION", path: m[1], range: [s, e], offset: m.index, kind: "action" });
  }
}

function pyRegistries(f, t, u) {
  const routerPrefix = {};
  for (const m of t.matchAll(/^(\w+)\s*=\s*(?:APIRouter|Blueprint)\(([^)]*)\)/gm)) { const p = m[2].match(/(?:url_)?prefix\s*=\s*["']([^"']+)/); routerPrefix[m[1]] = p ? p[1] : ""; }
  for (const m of t.matchAll(/^[ \t]*@(\w+)\.(get|post|put|patch|delete|route|api_route)\(\s*["']([^"']*)["']([^)]*)\)/gm)) {
    const rest = t.slice(m.index); const d = rest.search(/^[ \t]*(?:async\s+)?def\s+/m); if (d < 0) continue;
    let method = m[2].toUpperCase(); if (method === "ROUTE" || method === "API_ROUTE") { const ms = m[4].match(/methods\s*=\s*\[\s*["'](\w+)/); method = ms ? ms[1].toUpperCase() : "GET"; }
    routes.push({ unit: u.id, file: f, method, path: ((routerPrefix[m[1]] || "") + m[3]).replace(/\/+/g, "/") || "/", range: pyBlock(t, m.index + d), offset: m.index, kind: "py" });
  }
  if (/urls\.py$/.test(f)) for (const m of t.matchAll(/(?:re_)?path\(\s*r?["']([^"']*)["']\s*,\s*([\w.]+)/g)) {
    if (/include$/.test(m[2])) continue;
    const parts = m[2].split("."); const fn = parts.pop().replace(/\.as_view$/, ""); const c = ctx(f);
    const target = parts.length ? c.imports[parts[0]]?.file : c.imports[fn]?.file; if (!target) continue;
    const tt = read(target); const dm = new RegExp(`^(?:async\\s+)?def\\s+${fn}\\b|^class\\s+${fn}\\b`, "m").exec(tt); if (!dm) continue;
    routes.push({ unit: u.id, file: target, method: "ANY", path: "/" + m[1].replace(/<(?:\w+:)?(\w+)>/g, ":$1"), range: pyBlock(tt, dm.index), offset: dm.index, kind: "py", routeEvidence: ev(f, m.index) });
  }
  for (const m of t.matchAll(/^[ \t]*@(?:[\w.]+\.)?(task|shared_task|actor)\b(\([^)]*\))?[ \t]*\n(?:[ \t]*@[^\n]*\n)*[ \t]*(?:async\s+)?def\s+(\w+)/gm)) {
    const q = (m[2] || "").match(/queue(?:_name)?\s*=\s*["']([^"']+)/); const qn = q ? q[1] : (m[1] === "actor" ? "dramatiq" : "celery");
    tasks[m[3]] = { queue: qn, unit: u.id, file: f, range: pyBlock(t, m.index + m[0].lastIndexOf("def")), evidence: ev(f, m.index) };
    queues[qn] ||= { owner: u.id, evidence: ev(f, m.index) };
    if (!workers.some((w) => w.queue === qn && w.unit === u.id)) { const conc = allFiles.filter(isPy).map(read).join("\n").match(/(?:worker_)?concurrency\s*=\s*(\d+)/); workers.push({ queue: qn, unit: u.id, file: f, range: null, concurrency: conc ? +conc[1] : null, concurrencyEnv: null, evidence: ev(f, m.index), py: true }); }
  }
  for (const m of t.matchAll(/\.subscribe\(\s*["']([^"']+)["']|KafkaConsumer\(\s*["']([^"']+)["']|basic_consume\([^)]*queue\s*=\s*["']([^"']+)["']/g)) listeners.push({ event: m[1] || m[2] || m[3], unit: u.id, file: f, range: [m.index, t.length], evidence: ev(f, m.index) });
  for (const m of t.matchAll(/@receiver\(\s*(\w+)\s*,\s*sender\s*=\s*(\w+)/g)) { const d = t.slice(m.index).search(/def\s/); listeners.push({ event: `${m[2]}.${m[1]}`, unit: u.id, file: f, range: pyBlock(t, m.index + d), evidence: ev(f, m.index) }); }
}

// =============================================================== effects
const WRITE = /^(create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany|insert|insertMany|save|remove|softDelete|destroy|bulkCreate|findByIdAndUpdate|findOneAndUpdate|findByIdAndDelete|findOneAndDelete|updateOne|deleteOne|del|add|add_all|merge|bulk_create|get_or_create|update_or_create|insert_one|insert_many|update_one|update_many|delete_one|delete_many|replace_one|set|setex|hset|incr|expire|lpush|rpush|zadd|increment)$/;
function fnBody(file, name, method) {
  const t = read(file); if (!t) return null;
  const n = method || name;
  if (isPy(file)) { if (!n || n === "default" || n === "*") return null; const m = new RegExp(`^[ \\t]*(?:async\\s+)?def\\s+${n}\\s*\\(`, "m").exec(t); return m ? pyBlock(t, m.index) : null; }
  if (!n) return null;
  if (n === "default") {
    const m = t.match(/export\s+default\s+(?:async\s+)?function\s*\w*\s*\(/) || t.match(/export\s+default\s+(?:async\s+)?\(/);
    if (m) {
      const [, pe] = block(t, m.index + m[0].length - 1); const rest = t.slice(pe, pe + 300);
      const ar = rest.match(/^\s*(?::\s*[^={;]+?)?\s*(=>)?\s*(\{)?/);
      if (ar && ar[2]) return block(t, pe + rest.indexOf("{"));
      if (ar && ar[1]) { const end = t.slice(pe).search(/;\s*(?:\n|$)|\n\s*(?:export|const|let|function)\b/); return [pe, end < 0 ? t.length : pe + end]; }
      return null;
    }
    const id = t.match(/export\s+default\s+(\w+)\s*;?\s*$/m); if (id && id[1] !== "default") return fnBody(file, id[1]);
    return null;
  }
  const res = [
    new RegExp(`(?:async\\s+)?function\\s*\\*?\\s*${n}\\s*(?:<[^>]*>)?\\(`),
    new RegExp(`(?:const|let|var)\\s+${n}\\s*(?::[^=]+)?=\\s*(?:async\\s+)?(?:function\\s*)?(?:<[^>]*>)?\\(`),
    new RegExp(`(?:^|[\\s,{;])(?:public\\s+|private\\s+|protected\\s+|static\\s+|override\\s+)*(?:async\\s+)?${n}\\s*(?:<[^>]*>)?\\(`, "m"),
    new RegExp(`(?:^|[\\s,{])${n}\\s*:\\s*(?:async\\s*)?(?:function\\s*)?\\(`, "m"),
  ];
  for (const re of res) {
    const m = re.exec(t); if (!m) continue;
    const po = m.index + m[0].length - 1; const [, pe] = block(t, po);
    const rest = t.slice(pe, pe + 300); const ar = rest.match(/^\s*(?::\s*[^={;]+?)?\s*(=>)?\s*(\{)?/);
    if (ar && ar[2]) return block(t, pe + rest.indexOf("{"));
    if (ar && ar[1]) { const end = t.slice(pe).search(/\n\s*(?:export|const|let|function|async function|\})\b|;\s*\n/); return [pe, end < 0 ? t.length : pe + end]; }
  }
  return null;
}
function classifyUrl(raw) {
  const url = raw.trim();
  const env = url.match(/^\$?\{\s*(?:process\.env\.|import\.meta\.env\.|env\.|settings\.|config\.(?:\w+\.)*|os\.environ\[["']|os\.getenv\(["'])?([A-Za-z_]\w*)/);
  if (env) {
    const name = env[1]; const rest = url.replace(/^\$?\{[^}]*\}/, "");
    const key = name.toLowerCase().replace(/_/g, "");
    const unit = units.find((u) => u.kind !== "package" && u.name.length > 2 && key.includes(u.name.toLowerCase().replace(/[-_]/g, "")));
    if (unit) return { to: unit.id, path: rest || "/", internal: true };
    if (/^(NEXT_PUBLIC_|VITE_|REACT_APP_)?(API|BASE|BACKEND|SERVER|APP|SITE|PUBLIC)(_\w*)?(URL|URI|HOST|ENDPOINT)?$/i.test(name) || /^(baseUrl|apiUrl|API_URL|BASE_URL)$/i.test(name)) return { to: null, path: rest || "/", internal: true };
    const p = name.replace(/^(NEXT_PUBLIC_|VITE_|REACT_APP_)/, "").replace(/_?(API_)?(BASE_)?(URL|URI|HOST|ENDPOINT|ADDR|ADDRESS)$/i, "");
    return { to: "partner:" + slug(p), label: p.toLowerCase().replace(/_/g, " "), path: rest };
  }
  if (url.startsWith("/")) return { to: null, path: url, internal: true };
  const h = url.match(/^https?:\/\/([^/:$`{]+)(?::\d+)?(\/[^?#]*)?/); if (!h) return null;
  const host = h[1];
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(host)) return { to: null, path: h[2] || "/", internal: true };
  const unit = units.find((u) => u.kind !== "package" && host.split(".")[0] === u.name);
  if (unit) return { to: unit.id, path: h[2] || "/", internal: true };
  const name = host.replace(/^(api|www|app|hooks|rest|graph|gateway)\./, "").split(".").slice(0, -1).join(".") || host;
  return { to: "partner:" + slug(name), label: name, path: h[2] || "/" };
}

function effects(file, s = 0, e = null, depth = 0, seen = new Set()) {
  const t = read(file); e ??= t.length;
  const key = `${file}:${s}:${e}`; if (seen.has(key) || depth > 7) return []; seen.add(key);
  const chunk = t.slice(s, e); const u = unitOf(file); const c = ctx(file);
  const out = []; const taken = new Set();
  const push = (idx, obj) => { if (taken.has(idx)) return; taken.add(idx); out.push({ pos: s + idx, ...obj, evidence: ev(file, s + idx), unit: u.id }); };
  const db = (idx, store, model, op) => push(idx, { type: "db", store, model, op, write: WRITE.test(op) });
  const follow = (idx, target, label, range) => { if (!target || !range) return; push(idx, { type: "call", target: rel(target), label, toUnit: unitOf(target).id, children: effects(target, range[0], range[1], depth + 1, seen) }); };
  if (isPy(file)) { pyEffects(file, chunk, push, db, follow, c); return out.sort((a, b) => a.pos - b.pos); }

  // ---- databases
  for (const m of chunk.matchAll(/\b(?:this\.)?(\w+)\.(\w+)\.(findUnique|findUniqueOrThrow|findFirst|findFirstOrThrow|findMany|create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany|count|aggregate|groupBy)\(/g)) {
    const store = c.db[m[1]] || c.fields[m[1]]?.dbVar || (/^(prisma|db|tx|trx|database)$/.test(m[1]) ? "sql" : null); if (store && store !== "cache") db(m.index, store, m[2], m[3]);
  }
  for (const m of chunk.matchAll(/\b(\w+)\.(insert|update|delete)\(\s*(\w+)\s*\)/g)) if (c.db[m[1]] === "sql" || /^(db|tx)$/.test(m[1])) db(m.index, "sql", m[3], m[2]);
  for (const m of chunk.matchAll(/\b(\w+)\s*\.select\([^)]*\)\s*\.from\(\s*(\w+)\s*\)/g)) if (c.db[m[1]] === "sql" || /^(db|tx)$/.test(m[1])) db(m.index, "sql", m[2], "select");
  for (const m of chunk.matchAll(/\b(\w+)\.query\.(\w+)\.(findMany|findFirst)\(/g)) if (c.db[m[1]] === "sql" || m[1] === "db") db(m.index, "sql", m[2], m[3]);
  for (const m of chunk.matchAll(/\b(\w+)\(\s*["'](\w+)["']\s*\)\s*\.\s*(select|insert|update|del|delete|where|first|increment)\b/g)) if (c.db[m[1]] === "sql" || /^(knex|db)$/.test(m[1])) db(m.index, "sql", m[2], m[3] === "where" || m[3] === "first" ? "select" : m[3]);
  for (const m of chunk.matchAll(/\b(\w+)\s*\.from\(\s*["'](\w+)["']\s*\)\s*\.\s*(select|insert|update|upsert|delete)\b/g)) if (c.db[m[1]] === "supabase" || /supabase/i.test(m[1])) db(m.index, "supabase", m[2], m[3]);
  for (const m of chunk.matchAll(/\b(\w+)\.(find|findOne|findById|findByIdAndUpdate|findOneAndUpdate|findByIdAndDelete|findAll|findByPk|findAndCountAll|create|insertMany|updateOne|updateMany|deleteOne|deleteMany|destroy|count|countDocuments|aggregate|bulkCreate|upsert)\(/g)) { const mod = c.models[m[1]]; if (mod) db(m.index, mod.store, mod.model, m[2]); }
  for (const m of chunk.matchAll(/this\.(\w+)\.(find|findOne|findOneBy|findBy|findAndCount|findOneOrFail|save|insert|update|delete|remove|softDelete|count|create|findById|updateOne|deleteOne|createQueryBuilder)\(/g)) { const fd = c.fields[m[1]]; if (fd?.db) db(m.index, fd.db, fd.model, m[2] === "createQueryBuilder" ? "query" : m[2]); }
  for (const m of chunk.matchAll(/\.(?:query|execute|raw|unsafe)\(\s*[`'"]\s*(SELECT|INSERT|UPDATE|DELETE)\b[\s\S]{0,240}?\b(?:FROM|INTO|UPDATE)\s+["`]?(\w+)/gi)) db(m.index, "sql", m[2], m[1].toLowerCase());
  for (const m of chunk.matchAll(/\bsql`\s*(SELECT|INSERT|UPDATE|DELETE)\b[\s\S]{0,240}?\b(?:FROM|INTO|UPDATE)\s+["`]?(\w+)/gi)) db(m.index, "sql", m[2], m[1].toLowerCase());
  for (const m of chunk.matchAll(/\b(?:this\.)?(\w+)\.(get|set|setex|del|hget|hset|hgetall|incr|expire|mget|lpush|rpush|zadd|zrange)\(/g)) if (c.db[m[1]] === "cache" || c.fields[m[1]]?.dbVar === "cache" || /^(redis|cache|redisClient|kv)$/.test(m[1])) db(m.index, "cache", "cache", m[2]);

  // ---- events / messages out
  for (const m of chunk.matchAll(new RegExp(String.raw`\b(?:this\.)?(\w+)\.(emit|publish|dispatch|emitAsync|send)\(\s*` + NAME, "g"))) {
    const v = m[1]; if (NOT_BUS.test(v) && !c.fields[v]?.bus) continue;
    if (m[2] === "send" && !c.fields[v]?.bus && !/bus|broker|nats|producer|client|events?/i.test(v)) continue;
    const name = resolveName(m[3]); if (BUILTIN_EVENTS.has(name)) continue;
    push(m.index, { type: "emit", event: name });
  }
  for (const m of chunk.matchAll(/\.send\(\s*\{\s*topic\s*:\s*([^,}]+)/g)) { push(m.index, { type: "emit", event: resolveName(m[1]) }); evBusTech.add("kafka"); }
  // ---- background jobs
  for (const m of chunk.matchAll(/\b(?:this\.)?(\w+)\.(add|addBulk)\(/g)) {
    const q = c.queues[m[1]] || c.fields[m[1]]?.queue || queueVarGlobal[m[1]]; if (!q) continue;
    const [as, ae] = block(chunk, m.index + m[0].length - 1); const dm = chunk.slice(as, ae).match(/delay\s*:\s*(\d[\d_]*)/);
    push(m.index, { type: "enqueue", queue: q, delayMs: dm ? +dm[1].replace(/_/g, "") : null });
  }
  // ---- outbound HTTP
  for (const m of chunk.matchAll(/\b(fetch|axios|got|ky|ofetch|\$fetch|(?:this\.)?(?:http|httpClient|api|apiClient)\.(?:get|post|put|patch|delete|request)|axios\.(?:get|post|put|patch|delete))\(\s*([`'"])([^`'"]*)\2/g)) {
    const cls = classifyUrl(m[3]); if (!cls) continue;
    let method = (m[1].match(/\.(get|post|put|patch|delete)$/) || [])[1];
    if (!method) { const o = chunk.indexOf("(", m.index); const [as, ae] = block(chunk, o); method = (chunk.slice(as, ae).match(/method\s*:\s*["'`](\w+)/) || [])[1] || "GET"; }
    push(m.index, { type: "http", method: method.toUpperCase(), path: (cls.path || "/").replace(/\$\{[^}]+\}/g, ":x").split("?")[0], to: cls.to, internal: !!cls.internal, label: cls.label });
  }
  // ---- SDK partners
  for (const m of chunk.matchAll(/\b(?:this\.)?(\w+)((?:\.\w+)+)\(/g)) {
    const p = c.sdk[m[1]] || c.fields[m[1]]?.sdk; if (!p || (m.index > 0 && chunk[m.index - 1] === ".") || LOCAL_SDK_CALL.test(m[1] + m[2])) continue;
    push(m.index, { type: "partner", partner: slug(p), label: p, method: m[1] + m[2] });
  }
  for (const [name, imp] of Object.entries(c.imports)) {
    const pd = imp.file && rel(imp.file).match(/\/partners\/([^/]+)\//); if (!pd || !partnersDir[pd[1]]) continue;
    for (const m of chunk.matchAll(new RegExp(`(?<![\\w.])${name}\\.(\\w+)\\(`, "g"))) push(m.index, { type: "partner", partner: pd[1], label: pd[1], method: `${pd[1]}.${m[1]}` });
  }

  // ---- follow calls
  for (const m of chunk.matchAll(/\bwrappers?\.(\w+)\.(\w+)\(/g)) {
    const bases = [path.join(u.dir, "src/wrappers"), path.join(u.dir, "wrappers")];
    const verb = bases.map((b) => tryFile(path.join(b, m[1], m[2]))).find(Boolean);
    if (verb) { follow(m.index, verb, `wrappers.${m[1]}.${m[2]}`, [0, read(verb).length]); continue; }
    const mono = bases.map((b) => tryFile(path.join(b, m[1]))).find(Boolean);
    if (mono) follow(m.index, mono, `wrappers.${m[1]}.${m[2]}`, fnBody(mono, null, m[2]));
  }
  for (const [name, imp] of Object.entries(c.imports)) {
    if (!imp.file || c.sdk[name] || c.db[name] || c.models[name] || c.queues[name] || /^wrappers?$/.test(name) || rel(imp.file).includes("/partners/")) continue;
    for (const m of chunk.matchAll(new RegExp(`(?<![\\w.])${name}(?:\\.(\\w+))?\\s*\\(`, "g"))) {
      const method = m[1];
      let range = null;
      if (method) range = fnBody(imp.file, null, method);
      else range = fnBody(imp.file, imp.orig === "default" ? "default" : imp.orig || name);
      if (!range && !method && imp.orig === "default") range = [0, read(imp.file).length];
      if (range) follow(m.index, imp.file, method ? `${name}.${method}` : name, range);
    }
  }
  for (const m of chunk.matchAll(/this\.(\w+)\.(\w+)\(/g)) { const fd = c.fields[m[1]]; if (fd?.file) follow(m.index, fd.file, `${fd.type}.${m[2]}`, fnBody(fd.file, null, m[2])); }
  for (const name of Object.keys(c.fns)) {
    const r = fnBody(file, name); if (!r || (r[0] <= s && r[1] >= e) || (r[0] >= s && r[1] <= e)) continue;
    for (const m of chunk.matchAll(new RegExp(`(?<![\\w.])${name}\\s*\\(`, "g"))) follow(m.index, file, name, r);
  }
  return out.sort((a, b) => a.pos - b.pos);
}

function pyEffects(file, chunk, push, db, follow, c) {
  for (const m of chunk.matchAll(/\b(\w+)\.objects\.(\w+)\(/g)) db(m.index, "sql", m[1], m[2]);
  const varModel = {}; for (const m of chunk.matchAll(/\b(\w+)\s*=\s*([A-Z]\w+)\(/g)) varModel[m[1]] = m[2];
  for (const m of chunk.matchAll(/\b(?:self\.)?(?:session|db|db_session|async_session|sess)\.(add|add_all|delete|merge|query|get|scalars|scalar|execute)\(\s*(?:select\(\s*)?(\w+)?/g)) { const model = m[2] && /^[A-Z]/.test(m[2]) ? m[2] : varModel[m[2]] || null; if (model || /add|delete|merge/.test(m[1])) db(m.index, "sql", model || "rows", m[1]); }
  for (const m of chunk.matchAll(/(?<![\w.])(insert|update|delete)\(\s*([A-Z]\w+)\s*\)/g)) db(m.index, "sql", m[2], m[1]);
  for (const m of chunk.matchAll(/\b([A-Z]\w+)\.(create|get_or_create|filter|get|all|bulk_create|select|insert|update)\(/g)) if (c.imports[m[1]] && /models?|schemas?|entities/.test(c.imports[m[1]].spec)) db(m.index, "sql", m[1], m[2]);
  for (const m of chunk.matchAll(/\b(\w+)\.(\w+)\.(find|find_one|insert_one|insert_many|update_one|update_many|delete_one|delete_many|aggregate|count_documents|replace_one)\(/g)) if (c.db[m[1]] === "mongo" || /^(db|mongo|database)$/.test(m[1])) db(m.index, "mongo", m[2], m[3]);
  for (const m of chunk.matchAll(/\b(?:self\.)?(\w+)\.(get|set|setex|delete|hget|hset|incr|expire|lpush|rpush)\(/g)) if (c.db[m[1]] === "cache" || /^(redis|r|cache|redis_client|rds)$/.test(m[1])) db(m.index, "cache", "cache", m[2]);
  for (const m of chunk.matchAll(/\.publish\(\s*["']([^"']+)["']|producer\.send(?:_and_wait)?\(\s*["']([^"']+)["']|basic_publish\([^)]*routing_key\s*=\s*["']([^"']+)["']/g)) push(m.index, { type: "emit", event: m[1] || m[2] || m[3] });
  for (const m of chunk.matchAll(/\b(\w+)\.(delay|apply_async|send|send_with_options)\(/g)) { const tk = tasks[m[1]]; if (tk) { const cd = chunk.slice(m.index, m.index + 200).match(/countdown\s*=\s*(\d+)/); push(m.index, { type: "enqueue", queue: tk.queue, task: m[1], delayMs: cd ? +cd[1] * 1000 : null }); } }
  for (const m of chunk.matchAll(/\.enqueue(?:_in|_at)?\(\s*(?:timedelta\([^)]*\)\s*,\s*)?(\w+)/g)) {
    const imp = c.imports[m[1]]; if (!imp?.file) continue; const uu = unitOf(imp.file);
    tasks[m[1]] ||= { queue: "rq", unit: uu.id, file: imp.file, range: fnBody(imp.file, imp.orig || m[1]), evidence: ev(imp.file, Math.max(0, read(imp.file).search(new RegExp(`def\\s+${imp.orig || m[1]}\\b`)))) };
    queues.rq ||= { owner: unitOf(file).id, evidence: ev(file, 0) };
    if (!workers.some((w) => w.queue === "rq")) workers.push({ queue: "rq", unit: uu.id, file: imp.file, range: null, concurrency: null, concurrencyEnv: null, evidence: tasks[m[1]].evidence, py: true });
    push(m.index, { type: "enqueue", queue: "rq", task: m[1] });
  }
  for (const m of chunk.matchAll(/\b(?:requests|httpx|session|client|self\.client|self\.http|http)\.(get|post|put|patch|delete|request)\(\s*f?["']([^"']*)["']/g)) {
    const cls = classifyUrl(m[2]); if (!cls) continue;
    push(m.index, { type: "http", method: m[1].toUpperCase(), path: (cls.path || "/").replace(/\{[^}]+\}/g, ":x"), to: cls.to, internal: !!cls.internal, label: cls.label });
  }
  for (const m of chunk.matchAll(/\b(?:self\.)?(\w+)((?:\.\w+)+)\(/g)) { const p = c.sdk[m[1]]; if (!p || (m.index > 0 && chunk[m.index - 1] === ".") || LOCAL_SDK_CALL.test(m[1] + m[2])) continue; push(m.index, { type: "partner", partner: slug(p), label: p, method: m[1] + m[2] }); }
  for (const [name, imp] of Object.entries(c.imports)) {
    if (!imp.file || c.sdk[name] || tasks[name]) continue;
    for (const m of chunk.matchAll(new RegExp(`(?<![\\w.])${name}(?:\\.(\\w+))?\\s*\\(`, "g"))) {
      const fn = m[1] || (imp.orig && imp.orig !== "*" ? imp.orig : name); const r = fnBody(imp.file, fn); if (r) follow(m.index, imp.file, m[1] ? `${name}.${m[1]}` : name, r);
    }
  }
  for (const name of Object.keys(c.fns)) {
    const r = fnBody(file, name); if (!r) continue;
    for (const m of chunk.matchAll(new RegExp(`(?<![\\w.])${name}\\s*\\(`, "g"))) { if (chunk.slice(Math.max(0, m.index - 4), m.index).includes("def")) continue; follow(m.index, file, name, r); }
  }
}

// flatten nested calls into ordered effects, marking where execution crosses
// into another unit (module or service) so the hop shows
function flat(list, unit) {
  const out = [];
  for (const x of list) {
    if (x.type !== "call") { out.push(x); continue; }
    const tu = units.find((u) => u.id === x.toUnit);
    const crosses = tu && x.toUnit !== unit && tu.kind !== "package" && !tu.isCore;
    if (crosses) { out.push({ type: "cross", from: unit, to: x.toUnit, label: x.label, evidence: x.evidence }); out.push(...flat(x.children, x.toUnit)); out.push({ type: "return" }); }
    else out.push(...flat(x.children, unit));
  }
  return out;
}

// =============================================================== routes → ids, callers
for (const r of routes) {
  if (r.kind === "express") { const prefix = mounts[r.file] || ""; r.path = (prefix + (r.localPath === "/" && prefix ? "" : r.localPath)).replace(/\/+/g, "/") || "/"; }
  r.id = `route:${r.unit.split(":")[1]}:${r.method} ${r.path}`;
  r.audience = /webhook|callback|\bhooks?\b|\/events?$/i.test(r.path) ? "webhook" : /admin/i.test(r.path) ? "admin" : "client";
  r.evidence = r.routeEvidence || ev(r.file, r.offset);
  r._effects = effects(r.file, ...r.range);
  // handler passed by reference: router.post("/", create) / ctrl.create / [auth, handler]
  if (r.kind === "express") {
    const t = read(r.file); const inner = t.slice(r.range[0] + 1, r.range[1] - 1);
    const parts = []; let depth = 0, cur = "";
    for (const ch of inner) { if ("([{".includes(ch)) depth++; if (")]}".includes(ch)) depth--; if (ch === "," && depth === 0) { parts.push(cur); cur = ""; } else cur += ch; }
    parts.push(cur);
    const last = parts.at(-1).trim().replace(/^\[|\]$/g, "").split(",").at(-1).trim();
    const m = last.match(/^(\w+)(?:\.(\w+))?$/);
    if (m) {
      const c = ctx(r.file); const imp = c.imports[m[1]];
      let target = null, range = null;
      if (imp?.file) { target = imp.file; range = m[2] ? fnBody(imp.file, null, m[2]) : fnBody(imp.file, imp.orig === "default" ? "default" : imp.orig || m[1]) || (imp.orig === "default" ? [0, read(imp.file).length] : null); }
      else if (c.fns[m[1]]) { target = r.file; range = fnBody(r.file, m[1]); }
      if (target && range) { r.handlerFile = target; r._effects = [...r._effects, { type: "call", target: rel(target), label: last, toUnit: unitOf(target).id, pos: r.range[1], children: effects(target, ...range) }]; }
    }
  }
}
const norm = (x) => ((x || "/").replace(/\/:[^/]+/g, "/*").replace(/\/+$/, "") || "/").toLowerCase();
function routeFor(unitId, method, p) {
  const cands = routes.filter((r) => (!unitId || r.unit === unitId) && r.kind !== "action" && norm(r.path) === norm(p));
  return cands.find((r) => r.method === method) || cands.find((r) => r.method === "ANY") || null;
}
const callers = [];
for (const f of allFiles) {
  const u = unitOf(f); const t = read(f);
  const inServer = routes.filter((r) => r.file === f);
  for (const x of effects(f)) if (x.type === "http" && x.internal) {
    if (inServer.some((r) => x.pos >= r.range[0] && x.pos < r.range[1])) continue;
    const r = routeFor(x.to, x.method, x.path);
    if (r) callers.push({ from: r.unit === u.id || u.kind !== "app" ? "external:browser" : u.id, route: r.id, evidence: x.evidence });
  }
  if (/\.(tsx|jsx)$/.test(f)) for (const r of routes.filter((r) => r.kind === "action" && r.file !== f)) { const i = t.search(new RegExp(`\\b${r.path}\\s*\\(|action=\\{${r.path}\\}`)); if (i >= 0) callers.push({ from: "external:browser", route: r.id, evidence: ev(f, i) }); }
}

// =============================================================== flows
const FAIL = /FAIL|ERROR|REJECT|DECLIN|EXPIR|TIMEOUT|CANCEL|DEAD/i;
const MAX_STEPS = 40;
function traceFrom(startList, originUnit) {
  const steps = []; const seenL = new Set(), seenW = new Set();
  const q = [{ start: originUnit, list: flat(startList, originUnit), branch: null }];
  while (q.length && steps.length < MAX_STEPS) {
    const { start, list, branch: inherited } = q.shift();
    let current = start; const stack = [];
    for (const fx of list) {
      if (steps.length >= MAX_STEPS) break;
      if (fx.type === "cross") { steps.push({ from: current, to: fx.to, kind: "call", label: fx.label, evidence: fx.evidence, ...(inherited ? { branch: inherited } : {}) }); stack.push(current); current = fx.to; continue; }
      if (fx.type === "return") { current = stack.pop() || current; continue; }
      const at = current;
      const branch = inherited || (fx.type === "emit" && FAIL.test(fx.event) ? "failure" : null);
      const before = steps.length;
      if (fx.type === "db") steps.push({ from: at, to: STORES[fx.store].id, kind: fx.write ? "db-write" : "db-read", label: `${fx.model}.${fx.op}`, evidence: fx.evidence });
      else if (fx.type === "partner") steps.push({ from: at, to: `partner:${fx.partner}`, kind: "partner", label: fx.method, partnerLabel: fx.label, evidence: fx.evidence });
      else if (fx.type === "http") {
        if (fx.internal) { const r = routeFor(fx.to, fx.method, fx.path); if (r && r.unit !== at) { steps.push({ from: at, to: r.unit, kind: "http", label: `${r.method} ${r.path}`, evidence: fx.evidence }); q.push({ start: r.unit, list: flat(r._effects, r.unit), branch }); } }
        else if (fx.to) steps.push({ from: at, to: fx.to, kind: "partner", label: `${fx.method} ${fx.path || "/"}`, partnerLabel: fx.label, evidence: fx.evidence });
      } else if (fx.type === "enqueue") {
        steps.push({ from: at, to: `queue:${fx.queue}`, kind: "enqueue", label: fx.task || fx.queue, evidence: fx.evidence, ...(fx.delayMs ? { delayMs: fx.delayMs } : {}) });
        const tk = fx.task && tasks[fx.task];
        if (tk) { if (!seenW.has(fx.task)) { seenW.add(fx.task); steps.push({ from: `queue:${fx.queue}`, to: tk.unit, kind: "consume", label: fx.task, evidence: tk.evidence, async: true, ...(fx.delayMs ? { delayMs: fx.delayMs } : {}) }); if (tk.range) q.push({ start: tk.unit, list: flat(effects(tk.file, ...tk.range), tk.unit), branch }); } }
        else for (const w of workers.filter((w) => w.queue === fx.queue && w.range)) { if (seenW.has(w.file)) continue; seenW.add(w.file); steps.push({ from: `queue:${fx.queue}`, to: w.unit, kind: "consume", label: path.basename(w.file), evidence: w.evidence, async: true, ...(fx.delayMs ? { delayMs: fx.delayMs } : {}) }); q.push({ start: w.unit, list: flat(effects(w.file, ...w.range), w.unit), branch }); }
      } else if (fx.type === "emit") {
        steps.push({ from: at, to: "bus:events", kind: "emit", label: fx.event, evidence: fx.evidence });
        for (const l of listeners.filter((l) => l.event === fx.event)) { const k = `${l.file}:${l.range[0]}`; if (seenL.has(k)) continue; seenL.add(k); steps.push({ from: "bus:events", to: l.unit, kind: "deliver", label: fx.event, evidence: l.evidence, async: true }); q.push({ start: l.unit, list: flat(effects(l.file, ...l.range), l.unit), branch }); }
      }
      if (branch) for (let i = before; i < steps.length; i++) steps[i].branch = branch;
    }
  }
  return steps;
}
const flows = [];
function scoreOf(steps) {
  const touched = new Set(steps.flatMap((s) => [s.from, s.to]));
  return steps.length + 3 * [...touched].filter((x) => x.startsWith("service:")).length + 2 * steps.filter((s) => s.async).length + 3 * steps.filter((s) => s.kind === "partner").length + (steps.some((s) => s.kind === "db-write") ? 2 : 0);
}
for (const r of routes) {
  const caller = callers.find((c) => c.route === r.id);
  const entry = caller ? caller.from : r.kind === "action" ? "external:browser" : r.audience === "webhook" ? "external:webhook" : "external:client";
  const steps = [{ from: entry, to: r.unit, kind: "http", label: r.kind === "action" ? `${r.path}()` : `${r.method === "ANY" ? "" : r.method + " "}${r.path}`, evidence: caller ? caller.evidence : r.evidence }, ...traceFrom(r._effects, r.unit)];
  flows.push({ id: `flow:${r.unit.split(":")[1]}:${r.method}:${r.path}`, trigger: r.id, title: steps[0].label, steps, score: scoreOf(steps) });
}
for (const l of listeners) {
  if (flows.some((f) => f.steps.some((s) => s.kind === "deliver" && s.label === l.event))) continue;
  const steps = [{ from: "external:producer", to: l.unit, kind: "deliver", label: l.event, evidence: l.evidence }, ...traceFrom(effects(l.file, ...l.range), l.unit)];
  if (steps.length > 2) flows.push({ id: `flow:${l.unit.split(":")[1]}:on:${l.event}`, trigger: `listener:${l.event}`, title: `on ${l.event}`, steps, score: scoreOf(steps) });
}
flows.sort((a, b) => b.score - a.score);

// =============================================================== nodes & edges
const nodes = new Map(); const addNode = (n) => { if (!nodes.has(n.id)) nodes.set(n.id, n); return nodes.get(n.id); };
const allSteps = flows.flatMap((f) => f.steps);
const domainRe = /\/(?:wrappers|services|domains|modules|features|controllers|routes|routers|handlers|api|models|jobs|workers|resolvers|actions)\/([^/.]+)(?:\/|\.(?:m?js|ts|tsx|py)$)/;
// the floors of a block: domain folders, else file roles (orders.controller.ts → controller), else main files
function partsOf(files) {
  const junk = /^(index|utils?|helpers?|types?|__init__|constants?|config|\[.*\]|main|app|server)$/;
  const doms = [...new Set(files.map((f) => (rel(f).match(domainRe) || [])[1]).filter((d) => d && !junk.test(d)))];
  if (doms.length >= 2) return doms.slice(0, 12);
  const roles = [...new Set(files.map((f) => (path.basename(f).match(/\.(controller|service|entity|model|repository|listener|processor|gateway|resolver|handler|consumer|producer|worker|subscriber|guard|dto|schema|router|routes|views|tasks|serializers)\.\w+$/) || [])[1]).filter(Boolean))];
  if (roles.length >= 2) return roles.slice(0, 12);
  return [...new Set(files.map((f) => path.basename(f).replace(/\.\w+$/, "")).filter((n) => !junk.test(n)))].slice(0, 7);
}
for (const u of units) {
  if (u.kind === "package") continue;
  const own = walk(u.dir).filter((f) => unitOf(f) === u);
  const ur = routes.filter((r) => r.unit === u.id);
  const used = ur.length || workers.some((w) => w.unit === u.id) || listeners.some((l) => l.unit === u.id) || allSteps.some((s) => s.from === u.id || s.to === u.id);
  if (!used && units.filter((x) => x.kind !== "package").length > 1) continue;
  const kind = ur.length || u.kind === "service" || workers.some((w) => w.unit === u.id) ? "service" : "app";
  addNode({ id: u.id, kind, label: u.isCore ? `${u.name}` : u.name, core: !!u.isCore, path: rel(u.dir) || ".", fileCount: own.length,
    routes: ur.map(({ id, method, path: p, audience, evidence }) => ({ id, method, path: p, audience, evidence })),
    emits: [], listens: listeners.filter((l) => l.unit === u.id).map((l) => ({ event: l.event, evidence: l.evidence })),
    workers: workers.filter((w) => w.unit === u.id).map((w) => ({ queue: w.queue, file: rel(w.file), concurrency: w.concurrency, concurrencyEnv: w.concurrencyEnv, evidence: w.evidence })),
    domains: partsOf(own) });
}
for (const [k, st] of Object.entries(STORES)) if (allSteps.some((s) => s.to === st.id)) {
  const n = addNode({ id: st.id, kind: "database", label: st.label, store: k, models: [...new Set(allSteps.filter((s) => s.to === st.id).map((s) => s.label.split(".")[0]))] });
  if (k === "sql" && prismaSchema) n.models = [...prismaSchema.matchAll(/^model\s+(\w+)/gm)].map((m) => m[1]);
}
if (allSteps.some((s) => s.to === "bus:events" || s.from === "bus:events")) addNode({ id: "bus:events", kind: "bus", label: evBusTech.has("kafka") ? "Kafka" : BUS_LABEL, events: [...new Set([...listeners.map((l) => l.event), ...allSteps.filter((s) => s.kind === "emit").map((s) => s.label)])] });
for (const [name, q] of Object.entries(queues)) {
  if (!allSteps.some((s) => s.to === `queue:${name}`) && !workers.some((w) => w.queue === name && nodes.has(w.unit))) continue;
  const w = workers.filter((x) => x.queue === name);
  addNode({ id: `queue:${name}`, kind: "queue", label: name, owner: nodes.has(q.owner) ? q.owner : (w[0]?.unit || q.owner), evidence: q.evidence, consumers: [...new Set(w.map((x) => x.unit))],
    concurrency: w.reduce((a, x) => a + (x.concurrency || 0), 0) || null, concurrencyEnv: w.map((x) => x.concurrencyEnv).filter(Boolean) });
}
for (const s of allSteps) if (s.to.startsWith("partner:")) {
  const key = s.to.slice(8); const pd = partnersDir[key] || {};
  addNode({ id: s.to, kind: "partner", label: s.partnerLabel || key, owner: pd.unit || s.from, evidence: pd.evidence || s.evidence, baseUrlEnv: pd.baseUrlEnv || null, timeoutMs: pd.timeoutMs ?? null, timeoutEnv: pd.timeoutEnv || null, retries: pd.retries ?? null });
}
const EXT = { "external:webhook": "Webhooks", "external:client": "API clients", "external:browser": "Browser", "external:producer": "Upstream" };
for (const s of allSteps) for (const id of [s.from, s.to]) {
  if (EXT[id]) addNode({ id, kind: "external", label: EXT[id] });
  else if (!nodes.has(id)) { const u = units.find((x) => x.id === id); if (u) addNode({ id, kind: u.kind === "app" ? "app" : "service", label: u.name, path: rel(u.dir), fileCount: walk(u.dir).length, routes: [], emits: [], listens: [], workers: [], domains: [] }); }
}
const edges = new Map();
for (const f of flows) for (const s of f.steps) {
  const id = `${s.from}->${s.to}:${s.kind}`;
  const e = edges.get(id) || { id, from: s.from, to: s.to, kind: s.kind, labels: [], evidence: [] };
  if (!e.labels.includes(s.label) && e.labels.length < 20) e.labels.push(s.label);
  if (e.evidence.length < 6 && !e.evidence.some((x) => x.file === s.evidence.file && x.line === s.evidence.line)) e.evidence.push(s.evidence);
  edges.set(id, e);
  if (s.kind === "emit") { const n = nodes.get(s.from); if (n?.emits && !n.emits.some((x) => x.event === s.label)) n.emits.push({ event: s.label, evidence: s.evidence }); }
}

const langs = { js: allFiles.filter((f) => JS.test(f)).length, py: allFiles.filter((f) => PY.test(f)).length };
const system = {
  version: 2, repo: repoName(), scannedAt: new Date().toISOString(),
  stats: { files: allFiles.length, languages: langs, routes: routes.length, events: nodes.get("bus:events")?.events.length || 0, listeners: listeners.length, queues: [...nodes.values()].filter((n) => n.kind === "queue").length, partners: [...nodes.values()].filter((n) => n.kind === "partner").length },
  nodes: [...nodes.values()], edges: [...edges.values()],
  routes: routes.map(({ id, unit, method, path: p, audience, evidence, kind }) => ({ id, unit, method, path: p, audience, kind, evidence })),
  unresolved: {
    eventsWithoutListener: [...new Set(allSteps.filter((s) => s.kind === "emit").map((s) => s.label))].filter((e) => !listeners.some((l) => l.event === e)),
    queuesWithoutWorker: Object.keys(queues).filter((q) => !workers.some((w) => w.queue === q)),
    listenersNeverTriggered: listeners.filter((l) => !allSteps.some((s) => s.kind === "emit" && s.label === l.event)).map((l) => ({ event: l.event, evidence: l.evidence })),
  },
  candidateFlows: flows.slice(0, 30),
};
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(system, null, 2));

// =============================================================== summary
const st = system.stats;
console.log(`xray scan: ${system.repo}`);
console.log(`  ${st.files} files (${langs.js} js/ts, ${langs.py} py) · ${st.routes} entry points · ${st.listeners} listeners · ${st.queues} queues · ${st.partners} outside services`);
console.log(`  nodes: ${system.nodes.map((n) => n.id).join("  ")}`);
console.log(`  top candidate flows:`);
for (const f of flows.slice(0, 8)) {
  const touched = [...new Set(f.steps.flatMap((x) => [x.from, x.to]))].filter((x) => !x.startsWith("external"));
  console.log(`   ${String(f.score).padStart(3)}  ${f.title.slice(0, 38).padEnd(38)} ${String(f.steps.length).padStart(2)} steps  ${touched.join(" → ")}`);
}
if (!routes.length && !listeners.length) console.log(`\n  ⚠ no entry points found — this stack isn't covered by the scanner. See references/adapting.md, or write system.json by hand (references/schema.md).`);
else if (flows.length && flows.slice(0, 5).every((f) => f.steps.length <= 2)) console.log(`\n  ⚠ flows stop after one hop — calls aren't being followed. See references/adapting.md.`);
const un = system.unresolved;
if (un.eventsWithoutListener.length || un.queuesWithoutWorker.length || un.listenersNeverTriggered.length) console.log(`  unresolved: ${un.eventsWithoutListener.length} events nobody listens to · ${un.queuesWithoutWorker.length} queues with no worker · ${un.listenersNeverTriggered.length} listeners nothing triggers`);
console.log(`  wrote ${path.relative(process.cwd(), outFile) || outFile}`);
