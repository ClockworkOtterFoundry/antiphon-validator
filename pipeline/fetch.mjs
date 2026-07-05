// Dev-time only. Downloads the pinned upstream artifacts (pins.json), verifies sha256,
// and extracts the files the compile step needs into pipeline/work/.
// Fails loudly on any missing hash, hash mismatch, or missing zip entry.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";

const here = dirname(fileURLToPath(import.meta.url));
const pins = JSON.parse(await readFile(join(here, "pins.json"), "utf8"));
const cacheDir = join(here, "cache");
await mkdir(cacheDir, { recursive: true });

let failures = 0;

for (const [id, art] of Object.entries(pins.artifacts)) {
  if (!art.sha256 || art.sha256.length !== 64) {
    console.error(`FAIL ${id}: pins.json has no sha256 — refusing to fetch unpinned content`);
    failures++;
    continue;
  }
  const cachePath = join(cacheDir, art.sha256 + "-" + id);
  let bytes;
  if (existsSync(cachePath)) {
    bytes = await readFile(cachePath);
  } else {
    console.log(`fetch ${id} <- ${art.url}`);
    const res = await fetch(art.url, { redirect: "follow" });
    if (!res.ok) {
      console.error(`FAIL ${id}: HTTP ${res.status} for ${art.url}`);
      failures++;
      continue;
    }
    bytes = Buffer.from(await res.arrayBuffer());
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== art.sha256) {
    console.error(`FAIL ${id}: sha256 mismatch\n  expected ${art.sha256}\n  actual   ${digest}\n  (upstream changed under the pin, or download corrupted — do NOT just update the hash; re-run the inventory gate first)`);
    failures++;
    continue;
  }
  await writeFile(cachePath, bytes);

  if (art.kind === "file") {
    const target = join(here, art.target);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    console.log(`  ok  ${id} -> ${art.target}`);
  } else if (art.kind === "zip") {
    const entries = unzipSync(new Uint8Array(bytes));
    for (const [inner, target] of Object.entries(art.extract ?? {})) {
      if (!(inner in entries)) {
        console.error(`FAIL ${id}: zip entry not found: ${inner}`);
        failures++;
        continue;
      }
      const t = join(here, target);
      await mkdir(dirname(t), { recursive: true });
      await writeFile(t, entries[inner]);
      console.log(`  ok  ${id}: ${inner} -> ${target}`);
    }
    for (const [prefix, targetDir] of Object.entries(art.extractPrefix ?? {})) {
      let n = 0;
      for (const [name, data] of Object.entries(entries)) {
        if (!name.startsWith(prefix) || name.endsWith("/")) continue;
        const t = join(here, targetDir, name.slice(prefix.length));
        await mkdir(dirname(t), { recursive: true });
        await writeFile(t, data);
        n++;
      }
      if (n === 0) {
        console.error(`FAIL ${id}: no zip entries under prefix ${prefix}`);
        failures++;
      } else {
        console.log(`  ok  ${id}: ${n} files ${prefix}* -> ${targetDir}`);
      }
    }
  } else {
    console.error(`FAIL ${id}: unknown kind '${art.kind}'`);
    failures++;
  }
}

if (failures > 0) {
  console.error(`\nfetch FAILED (${failures} problem${failures > 1 ? "s" : ""})`);
  process.exit(1);
}
console.log("fetch OK — all pins verified");
