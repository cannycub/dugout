/**
 * Env/replay port — provisions an environment and runs a replay (data-pipeline reprocessing
 * verified by humans via Athena). Stubbed/mocked in v1: replay is triggered and verified
 * manually outside Dugout; automatic triggering is v1.5 (needs ephemeral environments).
 */

export interface EnvHandle {
  id: string;
}

export interface EnvReplayPort {
  provision(branch: string): Promise<EnvHandle>;
  /** Replay a recorded corpus through the stack; returns the S3 URI of the output. */
  runReplay(env: EnvHandle, corpus: string): Promise<string>;
}
