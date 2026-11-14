/**
 * Tests for the embed script's fail-closed behaviour, run by spawning
 * the script with secrets missing: it must refuse with a clear
 * message and a non-zero exit, never guess at a database or a key,
 * and never print a secret. The happy path — embedding the seeded
 * memories — runs against the live database and is covered by
 * search.integration.test.ts.
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** The embed script, resolved from this test file's location. */
const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "embed-memories.mjs",
);

/**
 * Run the embed script with the given environment and return its exit
 * code and combined output. A spawn failure or a timeout counts as an
 * exit code of 1, so the test fails on the code, not on a crash.
 */
function runScript(env: NodeJS.ProcessEnv): Promise<{
  code: number;
  output: string;
}> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT],
      { env, timeout: 15000 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : (error.code as number | null) ?? 1;
        resolve({ code, output: `${stdout}${stderr}` });
      },
    );
  });
}

/**
 * An environment with both secrets removed, whatever the shell holds,
 * plus any extras the test wants to set.
 */
function envWithoutSecrets(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.MONGODB_URI;
  delete env.VOYAGE_API_KEY;
  return env;
}

describe("embed-memories script", () => {
  /** With neither secret set, the script refuses and names both. */
  it("refuses to run with neither secret set", async () => {
    const { code, output } = await runScript(envWithoutSecrets());
    expect(code).toBe(1);
    expect(output).toMatch("MONGODB_URI");
    expect(output).toMatch("VOYAGE_API_KEY");
  });

  /**
   * With only one secret set, it refuses on the missing one — and
   * never prints the secret it was given.
   */
  it("refuses to run with only one secret set", async () => {
    const dbOnly = await runScript(
      envWithoutSecrets({ MONGODB_URI: "mongodb://localhost:27017" }),
    );
    expect(dbOnly.code).toBe(1);
    expect(dbOnly.output).toMatch("VOYAGE_API_KEY");
    expect(dbOnly.output).not.toContain("mongodb://localhost:27017");
    const keyOnly = await runScript(
      envWithoutSecrets({ VOYAGE_API_KEY: "test-key" }),
    );
    expect(keyOnly.code).toBe(1);
    expect(keyOnly.output).toMatch("MONGODB_URI");
    expect(keyOnly.output).not.toContain("test-key");
  });
});
