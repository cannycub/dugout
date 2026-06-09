import { describe, it, expect } from "vitest";
import { resolveSandboxImage, type RunCommand } from "./docker-image.js";

const ID = "sha256:a6a751cc5a02deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdead";

/** Fake docker CLI: scripted replies keyed by the subcommand, recording every invocation. */
function fakeDocker(replies: {
  inspect?: { exitCode: number; stdout: string };
  images?: { exitCode: number; stdout: string };
  tag?: { exitCode: number; stdout: string };
}): { run: RunCommand; calls: string[][] } {
  const calls: string[][] = [];
  const run: RunCommand = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const reply =
      args[0] === "image" && args[1] === "inspect"
        ? replies.inspect
        : args[0] === "images"
          ? replies.images
          : args[0] === "tag"
            ? replies.tag
            : undefined;
    if (!reply) throw new Error(`unexpected docker call: ${args.join(" ")}`);
    return { exitCode: reply.exitCode, stdout: reply.stdout };
  };
  return { run, calls };
}

describe("resolveSandboxImage (stale-tag immunity, #37)", () => {
  it("resolves a healthy tag to its immutable image ID", async () => {
    const docker = fakeDocker({ inspect: { exitCode: 0, stdout: `${ID}\n` } });

    const image = await resolveSandboxImage("dugout-sandbox-node:local", docker.run);

    expect(image).toBe(ID);
    expect(docker.calls).toEqual([
      ["docker", "image", "inspect", "dugout-sandbox-node:local", "--format", "{{.Id}}"],
    ]);
  });

  it("self-heals a stale tag: finds the ID in the image listing, re-tags, and returns the ID", async () => {
    // The #37 failure shape: inspect-by-tag 404s while `docker images` still lists the tag.
    const docker = fakeDocker({
      inspect: { exitCode: 1, stdout: "" },
      images: {
        exitCode: 0,
        stdout: `dugout-sandbox-node:other sha256:ffff\ndugout-sandbox-node:local ${ID}\n`,
      },
      tag: { exitCode: 0, stdout: "" },
    });

    const image = await resolveSandboxImage("dugout-sandbox-node:local", docker.run);

    expect(image).toBe(ID);
    expect(docker.calls).toContainEqual([
      "docker",
      "images",
      "dugout-sandbox-node",
      "--no-trunc",
      "--format",
      "{{.Repository}}:{{.Tag}} {{.ID}}",
    ]);
    // Heals the reference for the next caller (and for anything else that launches by tag).
    expect(docker.calls).toContainEqual(["docker", "tag", ID, "dugout-sandbox-node:local"]);
  });

  it("throws an operational error pointing at build:sandbox when the image is genuinely absent", async () => {
    const docker = fakeDocker({
      inspect: { exitCode: 1, stdout: "" },
      images: { exitCode: 0, stdout: "" },
    });

    await expect(resolveSandboxImage("dugout-sandbox-node:local", docker.run)).rejects.toThrow(
      /dugout-sandbox-node:local.*npm run build:sandbox/s,
    );
  });

  it("still returns the ID when the healing re-tag itself fails (best-effort)", async () => {
    const docker = fakeDocker({
      inspect: { exitCode: 1, stdout: "" },
      images: { exitCode: 0, stdout: `dugout-sandbox-node:local ${ID}\n` },
      tag: { exitCode: 1, stdout: "" },
    });

    await expect(resolveSandboxImage("dugout-sandbox-node:local", docker.run)).resolves.toBe(ID);
  });
});
