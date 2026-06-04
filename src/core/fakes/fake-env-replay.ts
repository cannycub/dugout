import type { EnvHandle, EnvReplayPort } from "../ports/env-replay.js";

/** In-memory env/replay adapter returning a canned env handle and S3 URI. */
export class FakeEnvReplay implements EnvReplayPort {
  async provision(branch: string): Promise<EnvHandle> {
    return { id: `fake-env-for-${branch}` };
  }

  async runReplay(env: EnvHandle, corpus: string): Promise<string> {
    return `s3://fake-replay-output/${env.id}/${corpus}`;
  }
}
