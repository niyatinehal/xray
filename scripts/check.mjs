#!/usr/bin/env node
// Check it like a critic before showing anyone.
// Usage: node check.mjs <outDir> [--repo <repoRoot>]
//  1. Evidence: every flow step's file:line still exists and contains what we claim.
//  2. Stills: renders the tour at every beat (start, middle, end) to <outDir>/check/*.png
//  3. Console: any page error fails the check.
//  4. Labels: overlapping labels are listed per still.
//  5. Scrub: steps the tour at 0.2 s and flags any frame that takes > 50 ms to render.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { launchBrowser } from "./browser.mjs";

const outDir = path.resolve(process.argv[2] || "xray-out");
const ri = process.argv.indexOf("--repo");
const repo = path.resolve(ri > -1 ? process.argv[ri + 1] : path.join(outDir, ".."));
const QUICK = process.argv.includes("--quick"); // one still per beat, coarse scrub — for fast iteration
const html = path.join(outDir, "xray.html");
if (!fs.existsSync(html)) { console.error(`No ${html}. Run build.mjs first.`); process.exit(1); }

const problems = [];
// ---------- 1. evidence ----------
const system = JSON.parse(fs.readFileSync(path.join(outDir, "system.json"), "utf8"));
const config = JSON.parse(fs.readFileSync(path.join(outDir, "xray.config.json"), "utf8"));
const byId = Object.fromEntries(system.candidateFlows.map((f) => [f.id, f]));
let checked = 0;
for (const cf of config.flows) {
  for (const s of cf.steps || byId[cf.from]?.steps || []) {
    const e = s.evidence; if (!e) { problems.push(`[evidence] "${cf.title}" step ${s.kind} ${s.label} has no evidence`); continue; }
    const f = path.join(repo, e.file);
    if (!fs.existsSync(f)) { problems.push(`[evidence] ${e.file} not found`); continue; }
    const line = (fs.readFileSync(f, "utf8").split("\n")[e.line - 1] || "").trim();
    // the cited line must mention what the step claims (any distinctive word of its label)
    const words = s.label.split(/[^A-Za-z0-9]+/).filter((w) => w.length >= 3 && !/^(GET|POST|PUT|PATCH|DELETE|ANY|create|update|delete|find|get|set|add|send|call)$/i.test(w));
    const checkable = ["emit", "deliver", "db-read", "db-write", "partner", "call"].includes(s.kind) && words.length;
    if (!line) problems.push(`[evidence] ${e.file}:${e.line} is empty or past the end of the file`);
    else if (checkable && !words.some((w) => line.toLowerCase().includes(w.toLowerCase()))) problems.push(`[evidence] ${e.file}:${e.line} doesn't mention ${words.join("/")} — line is: ${line.slice(0, 90)}`);
    checked++;
  }
}
console.log(`evidence: ${checked} steps checked against the code`);

// ---------- 2-5. render ----------
const stillsDir = path.join(outDir, "check"); fs.mkdirSync(stillsDir, { recursive: true });
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
await page.goto(pathToFileURL(html).href + "?record");
await page.waitForFunction(() => window.__xray && window.__xray.ready, null, { timeout: 30000 });
const { duration, beats } = await page.evaluate(() => ({ duration: window.__xray.duration, beats: window.__xray.beats }));
console.log(`tour: ${duration.toFixed(1)} s, ${beats.length} beats`);

const stills = [];
for (const [i, b] of beats.entries()) {
  for (const [tag, k] of QUICK ? [["mid", 0.55]] : [["start", 0.15], ["mid", 0.55], ["end", 0.92]]) {
    const t = b.t0 + b.dur * k;
    await page.evaluate((t) => window.__xray.renderAt(t), t);
    const file = path.join(stillsDir, `${String(i).padStart(2, "0")}-${b.kind}-${tag}.png`);
    await page.screenshot({ path: file });
    const rects = await page.evaluate(() => window.__xray.labelRects());
    const overlaps = [];
    for (let a = 0; a < rects.length; a++) for (let c = a + 1; c < rects.length; c++) {
      const A = rects[a], B = rects[c];
      const ix = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x), iy = Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y);
      if (ix > 6 && iy > 6) overlaps.push(`${A.id} × ${B.id}`);
    }
    const hiddenHot = await page.evaluate(() => window.__xray.hiddenImportant());
    if (hiddenHot.length) problems.push(`[labels] ${path.basename(file)}: label hidden for an active part — ${hiddenHot.join(", ")}`);
    const offscreen = rects.filter((r) => r.x < 0 || r.y < 0 || r.x + r.w > 1600 || r.y + r.h > 900).map((r) => r.id);
    if (overlaps.length) problems.push(`[labels] ${path.basename(file)}: ${overlaps.length} overlapping — ${overlaps.slice(0, 4).join(", ")}${overlaps.length > 4 ? " …" : ""}`);
    if (offscreen.length) problems.push(`[labels] ${path.basename(file)}: off screen ${offscreen.join(", ")}`);
    stills.push(file);
  }
}
// scrub
let slow = 0, worst = 0;
const STEP = QUICK ? 1 : 0.2;
for (let t = 0; t < duration; t += STEP) {
  const ms = await page.evaluate((t) => { const a = performance.now(); window.__xray.renderAt(t); return performance.now() - a; }, t);
  worst = Math.max(worst, ms); if (ms > 50) slow++;
}
console.log(`scrub: ${Math.ceil(duration / STEP)} frames, worst ${worst.toFixed(0)} ms${slow ? `, ${slow} over 50 ms` : ""}`);
await browser.close();

// contact sheet
try {
  const { execFileSync } = await import("node:child_process");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-pattern_type", "glob", "-i", path.join(stillsDir, "*-mid.png"), "-vf", "scale=640:-1,tile=3x" + Math.ceil(beats.length / 3), "-frames:v", "1", path.join(outDir, "contact-sheet.png")]);
  console.log(`contact sheet: ${path.relative(process.cwd(), path.join(outDir, "contact-sheet.png"))}`);
} catch { console.log("contact sheet skipped (ffmpeg not available)"); }

for (const e of errors) problems.push(`[console] ${e}`);
console.log(`stills: ${stills.length} in ${path.relative(process.cwd(), stillsDir)}/`);
if (problems.length) { console.log(`\n${problems.length} problem(s):`); for (const p of problems) console.log("  " + p); process.exitCode = 1; }
else console.log("\nno problems found");
