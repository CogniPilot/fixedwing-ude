// Copies the browser files of the pinned @cognipilot/rumoca package into
// public/vendor/rumoca (generated, not committed). Runs on `npm install`.
import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, "node_modules/@cognipilot/rumoca");
const target = path.join(here, "public/vendor/rumoca");
const FILES = ["rumoca_bind_wasm.js", "rumoca_bind_wasm_bg.wasm", "modelica_language.js", "rumoca_package_meta.json", "LICENSE"];

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
for (const file of FILES) await cp(path.join(source, file), path.join(target, file));
console.log(`vendored ${FILES.length} Rumoca files into ${path.relative(here, target)}`);
