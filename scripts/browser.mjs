// Finds a headless Chromium: the skill's own playwright install, then a global one.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
export async function launchBrowser() {
  const tries = [() => createRequire(path.join(here, "../package.json"))("playwright"), () => import("playwright")];
  for (const t of tries) {
    try {
      const pw = await t();
      const chromium = pw.chromium || pw.default?.chromium;
      return await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
    } catch (e) { if (!/Cannot find|ERR_MODULE_NOT_FOUND/.test(String(e))) throw e; }
  }
  throw new Error("Playwright not found. In the skill folder run: npm install && npx playwright install chromium");
}
