#!/usr/bin/env node
// Records the tour to MP4. render(t) is a pure function of time, so every frame
// is seeked and captured — no dropped frames, however heavy the scene.
// Usage: node record.mjs <outDir> [--fps 30] [--scale 1.2] [--seconds N]
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { launchBrowser } from "./browser.mjs";

const a = process.argv.slice(2);
const outDir = path.resolve(a[0] || "xray-out");
const opt = (k, d) => { const i = a.indexOf(k); return i > -1 ? +a[i + 1] : d; };
const fps = opt("--fps", 30), scale = opt("--scale", 1.2);
const html = path.join(outDir, "xray.html");
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: scale });
page.on("pageerror", (e) => console.error("page error:", e.message));
await page.goto(pathToFileURL(html).href + "?record");
await page.waitForFunction(() => window.__xray && window.__xray.ready);
const duration = opt("--seconds", await page.evaluate(() => window.__xray.duration));
const frames = Math.round(duration * fps);
const out = path.join(outDir, "xray.mp4");
const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-i", "-",
  "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out], { stdio: ["pipe", "inherit", "inherit"] });
for (let f = 0; f < frames; f++) {
  await page.evaluate((t) => window.__xray.renderAt(t), f / fps);
  const buf = await page.screenshot({ type: "jpeg", quality: 92 });
  if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
  if (f % fps === 0) process.stdout.write(`\r  ${Math.round((f / frames) * 100)}%`);
}
ff.stdin.end();
await new Promise((r) => ff.on("close", r));
await browser.close();
console.log(`\rrecorded ${path.relative(process.cwd(), out)} · ${duration.toFixed(1)} s at ${fps} fps, ${Math.round(1600 * scale)}×${Math.round(900 * scale)}`);
