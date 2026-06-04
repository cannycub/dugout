import { describe, it, expect } from "vitest";
import { FakeEnvReplay } from "./fake-env-replay.js";

// The env/replay port is stubbed in v1 (replay is triggered/verified manually outside Dugout),
// but the seam must exist with a working fake for later slices to plug into.
describe("FakeEnvReplay", () => {
  it("provisions an env handle and returns a canned S3 URI for a replay", async () => {
    const envReplay = new FakeEnvReplay();

    const env = await envReplay.provision("dugout/DUG-1/pipeline");
    expect(env.id).toContain("DUG-1");

    const uri = await envReplay.runReplay(env, "corpus-2026-06");
    expect(uri).toMatch(/^s3:\/\//);
    expect(uri).toContain("corpus-2026-06");
  });
});
