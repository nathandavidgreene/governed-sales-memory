/**
 * Tests for the API docs generator, run by spawning the script into a
 * temporary directory: it must write one page per source module plus
 * an index, carry each module's docstring and a declaration's
 * signature and docstring through unchanged, and leave test files out.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** The generator script, resolved from this test file's location. */
const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "gen-api-docs.mjs",
);

/** The temporary output directory the generator writes into. */
let outDir: string;

/** The generator's exit code, so a failed run fails the tests clearly. */
let exitCode: number;

/**
 * Run the generator into `dir` and resolve with its exit code; a spawn
 * failure or a timeout counts as 1.
 */
function runGenerator(dir: string): Promise<number> {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, dir], { timeout: 20000 }, (error) => {
      resolve(error === null ? 0 : typeof error.code === "number" ? error.code : 1);
    });
  });
}

beforeAll(async () => {
  outDir = await mkdtemp(path.join(os.tmpdir(), "api-docs-"));
  exitCode = await runGenerator(outDir);
});

afterAll(async () => {
  await rm(outDir, { recursive: true, force: true });
});

describe("gen-api-docs script", () => {
  /** Every module has a docstring, so the run succeeds. */
  it("exits zero when every module is documented", () => {
    expect(exitCode).toBe(0);
  });

  /** One page per non-test module plus the index, and no test pages. */
  it("writes a page per source module and none for tests", async () => {
    const pages = await readdir(outDir);
    expect(pages).toContain("index.md");
    expect(pages).toContain("src-chat.md");
    expect(pages).toContain("scripts-gen-api-docs.md");
    expect(pages.some((page) => page.includes("test"))).toBe(false);
  });

  /** The module docstring and a declaration's docstring appear as written. */
  it("carries docstrings and signatures through unchanged", async () => {
    const chat = await readFile(path.join(outDir, "src-chat.md"), "utf8");
    expect(chat).toContain("The chat agent: a model with governed tools, working for one owner.");
    expect(chat).toContain("## `MAX_MODEL_CALLS`");
    expect(chat).toContain("export const MAX_MODEL_CALLS");
    expect(chat).toContain("Most model calls one chat turn may make before failing closed.");
  });

  /** The index links each module with the first sentence of its docstring. */
  it("lists every module in the index with its summary", async () => {
    const index = await readFile(path.join(outDir, "index.md"), "utf8");
    expect(index).toContain("| [`src/index.ts`](src-index.md) | Worker entry point for the governed sales memory app. |");
  });
});
