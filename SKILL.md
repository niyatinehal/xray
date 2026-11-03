---
name: xray
description: Turn any codebase into a live 3D simulator of the running system — services and modules as machines, queues as tanks, an event bus, databases, and outside services (Stripe, OpenAI, AWS…) beyond a wall — where you watch one real request travel hop by hop, push traffic until a queue backs up, and take an outside service down to watch the failure spread. Every block, pipe and number is read from the code with file:line evidence. Produces one offline HTML page with a self-running tour, plus an MP4. Use whenever someone wants to visualize, map, explain, demo, animate or "x-ray" their backend, architecture, codebase, monorepo, microservices, or request/event flow; wants an architecture diagram that isn't static; wants a launch, LinkedIn, README or onboarding video of how their system works — even if they never say "simulator" or "3D". Reads JS/TS (Express, Fastify, Hono, NestJS, Next.js) and Python (FastAPI, Flask, Django) automatically; other languages are traced by hand into the same format.
---

# xray

Builds a working 3D model of a software system from its code. The viewer can orbit it, follow one request through every hop, push traffic until something breaks, and take outside services offline. Left alone, a cursor drives the page by itself; any click hands over control.

The promise to the person: **nothing on screen is invented.** Structure comes from the code; every hop carries `file:line`; every number that is a guess is labelled as one. Protect that above polish. Engineers will check, and one made-up arrow ruins the whole thing.

## Setup (once)

```bash
cd <skill-dir> && npm install && npx playwright install chromium
```
`ffmpeg` is needed only for the contact sheet and the MP4 — install it if missing. Below, `X=<skill-dir>/scripts`; output goes to `<repo>/xray-out/`.

## Workflow

### 1. Scan

```bash
node $X/scan.mjs <repo>
```
Prints what it found, the top candidate flows, and anything unresolved; writes `xray-out/system.json` (format: `references/schema.md`).

Read the summary like a reviewer, then pick a path:

- **Flows cross several hops** → go to step 2.
- **Few entry points, or flows stop after one hop** → the repo uses a pattern the scanner doesn't know. Read `references/adapting.md` and extend `scan.mjs` (usually one regex) — better than hand-writing for big JS/TS/Python repos.
- **Language the scanner doesn't read** (Go, Java, Kotlin, Ruby, PHP, C#, Rust, Elixir…) or the scan finds nothing → trace by hand: `references/manual.md`. The build, viewer and checks work identically on a hand-written map.

`unresolved` entries are findings, not noise — events nobody listens to and listeners nothing triggers are often dead code or broken wiring. Mention them to the person.

How the scanner splits a repo: monorepo folders (`services/*`, `apps/*`, …) become separate blocks. A single app is split into its modules (`src/modules/*`, Nest `*.module.ts` folders, Django apps, `app/api/*`…) so the hops between them show. If it guessed the units wrong, say so and fix it in `system.json` or the scanner.

### 2. Verify the flows before drawing anything

Pick 2–4 candidate flows that tell the story of the product: what users do most, where money or data comes in, anything that crosses several units or touches a queue or an outside service (those make the tour worth watching).

For each, **open the cited files and read the code at every step.** The scanner works on patterns, not a full parse, so check:
- steps inside `if` / `catch` / error paths — conditional. Emits named like FAIL/ERROR/REJECT are auto-tagged `branch: "failure"`; tag others by hand.
- order of steps, and steps pulled in from a helper that the real path doesn't call
- anything missed (a raw socket, a cron, a call through an unusual client)

If a flow is wrong, give it explicit `steps` in the config (copy the candidate's steps, keep the evidence objects, edit). If a step can't be confirmed in code, drop it. Tell the person what you checked and changed.

### 3. Configure

```bash
node $X/build.mjs xray-out
```
The first run writes a starter `xray-out/xray.config.json` and builds. Edit it (fields in `references/schema.md`):

- `title`, `subtitle` — the product's name, not the repo slug.
- `flows[].title` — a sentence anyone understands ("A rider requests a ride", not `POST /rides/`); `caption` — the path in plain words.
- `traffic.flowMix` — how often each flow happens relative to the others.
- `estimates` — latencies and capacities. They're guesses (LLM calls start at 2.5 s, payments 450 ms, email 300 ms). Ask the person once if they have real p50s from monitoring; otherwise leave them and they stay labelled "est." on screen.
- `redact: true` — **ask before anything is shared publicly.** It swaps file paths for `file-01.js` and blanks code lines. Service and partner names still show; if those are sensitive, rename node labels in `system.json` before building.

Rebuild after every edit.

### 4. Check it like a critic

```bash
node $X/check.mjs xray-out --repo <repo>          # add --quick while iterating
```
Re-verifies every step's evidence against the code; renders stills of every tour beat into `xray-out/check/` and a `contact-sheet.png`; flags page errors, overlapping or clipped labels, hidden labels on active parts, slow frames.

Then **look at the contact sheet yourself** and read the captions. Ask:
- does the big number agree with what the scene shows?
- does the traffic beat make a queue turn red? If not, check worker concurrency was found and the estimates are realistic. (Apps with no queue skip this beat — that's fine.)
- do the captions name the right worker, outside service, timeout and retry count?

Fix with numbers in the config or a scanner fix — never by hiding a problem with the camera. Report what you checked and fixed, and show the contact sheet.

### 5. Deliver

- `xray-out/xray.html` — one offline file (~700 KB). Open it in a browser.
- Video: `node $X/record.mjs xray-out` → `xray-out/xray.mp4` (1920×1080, 30 fps, H.264). Frames are rendered one by one, not screen-recorded, so nothing drops. `--fps 60`, `--seconds 30` to trim for social posts.

Tell the person how to drive it: click a request on the left to follow it, click any block to open it, drag Traffic, take an outside service down, H hides the panels, 1–9 replays flows, 25 s idle restarts the tour.

## How the numbers work (so you can explain them)

- **Queue drain rate** = concurrency × 1000 / ms per job. Concurrency is read from the worker (`concurrency: Number(process.env.X || 10)` → 10, env name shown; Celery `worker_concurrency`). Ms per job = the worker's own steps, usually dominated by an outside call.
- **Delayed jobs** (`delay:`, Celery `countdown`) show a steady "scheduled" count by Little's law: rate × delay.
- **Outside service down**: each call takes timeout × retries (read from code when present, otherwise 15 s × 3, labelled assumed). Failures per second can't exceed the rate of the queue in front of the call.
- **End to end** = sum of hops + queue wait (depth ÷ drain rate) + a penalty on busy units; stops at a delayed job.

## Privacy

The scanner never opens `.env*` files and blanks secret-looking strings in evidence lines. The output still shows the shape of a private system — treat it as internal until the person decides to share it, and use `redact`.
