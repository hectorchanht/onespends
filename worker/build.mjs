#!/usr/bin/env node
// Bundle src/worker.js + @dawn-studio/auth (dist) into the single-file
// Worker script at ./dist/worker.js (uploaded by tools/deploy-worker.py).
// Uses the esbuild that ships with the dawn-auth checkout (no extra installs).
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const esbuild = path.join(here, "..", "dawn-auth", "node_modules", ".bin", "esbuild");
const authDist = path.join(here, "..", "dawn-auth", "dist", "index.js");
const outfile = path.join(here, "dist", "worker.js");

execFileSync(
  esbuild,
  [
    path.join(here, "src", "worker.js"),
    "--bundle",
    "--format=esm",
    "--platform=neutral",
    "--target=es2022",
    `--alias:@dawn-studio/auth=${authDist}`,
    `--outfile=${outfile}`,
  ],
  { stdio: "inherit" }
);
console.log("built", outfile);
