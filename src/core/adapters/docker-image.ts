/**
 * Stale-tag-immune sandbox image resolution (#37).
 *
 * On Docker Desktop's containerd image store the `dugout-sandbox-*:local` tag intermittently stops
 * resolving by name even though the image is present and inspectable by ID (a tag-reference GC
 * quirk; see issue #37). Sand Castle preflights the image by name, so a stale tag kills execute
 * mode at sandbox start. Resolving the tag to its immutable image ID once per execute run — and
 * passing the *ID* to the provider — makes the launch immune to the tag going stale in between.
 */

/** Minimal command runner seam so resolution is unit-testable without a Docker daemon. */
export type RunCommand = (
  cmd: string,
  args: string[],
) => Promise<{ exitCode: number; stdout: string }>;

/**
 * Resolve an image tag to its immutable `sha256:…` ID.
 *
 * Healthy tag → the ID straight from `docker image inspect`. Stale tag (the #37 shape: inspect
 * 404s while `docker images` still lists it) → recover the ID from the listing, re-tag to heal the
 * reference (best-effort — the ID we return doesn't depend on it), and return the ID. Genuinely
 * absent → throw operational with the rebuild instruction; never let Sand Castle's preflight be
 * the one to report it.
 */
export async function resolveSandboxImage(tag: string, run: RunCommand): Promise<string> {
  const byTag = await run("docker", ["image", "inspect", tag, "--format", "{{.Id}}"]);
  if (byTag.exitCode === 0) return byTag.stdout.trim();

  const repository = tag.slice(0, tag.lastIndexOf(":"));
  const listing = await run("docker", [
    "images",
    repository,
    "--no-trunc",
    "--format",
    "{{.Repository}}:{{.Tag}} {{.ID}}",
  ]);
  const id = listing.stdout
    .split("\n")
    .find((line) => line.startsWith(`${tag} `))
    ?.split(" ")[1];
  if (!id) {
    throw new Error(
      `Sandbox image ${tag} not found — build it with \`npm run build:sandbox\` (see issue #37).`,
    );
  }
  await run("docker", ["tag", id, tag]); // heal the stale reference; failure is non-fatal
  return id;
}
