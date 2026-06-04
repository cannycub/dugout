// Deterministically download + extract Electron's prebuilt binary and write the
// `path.txt` pointer that Playwright's `electron.launch` reads to locate it.
//
// Why this exists: Electron 42 ships no postinstall, so its binary is fetched
// lazily on first launch by node_modules/electron/install.js. That script
// downloads and checksum-validates the zip, then extracts it via a *floating*
// promise (`downloadArtifact().then(extractFile)` with no top-level await).
// Under Node 24 in CI the process exits right after the download is cached —
// before extract-zip finishes — leaving dist/ empty and path.txt unwritten, so
// Playwright fails with `electron.launch: ENOENT … node_modules/electron/path.txt`.
//
// This mirrors install.js but (a) awaits the download and (b) extracts with the
// system `unzip` instead of Electron's bundled extract-zip — under Node 24 in CI
// that extract-zip promise never settles on the (checksum-valid) zip, hanging the
// install ("unsettled top-level await"). @electron/get's download works fine, so
// we keep it and only swap the extractor. No-op when the binary already exists
// (e.g. local dev), so this never needs `unzip` on a machine that already has it.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const elDir = path.resolve("node_modules/electron");
const require = createRequire(path.join(elDir, "install.js"));
const { downloadArtifact } = require("@electron/get");
const { version } = require(path.join(elDir, "package.json"));
const checksums = require(path.join(elDir, "checksums.json"));

// Mirrors install.js's getPlatformPath(): the executable's path within dist/.
const platformPath = {
  darwin: "Electron.app/Contents/MacOS/Electron",
  mas: "Electron.app/Contents/MacOS/Electron",
  linux: "electron",
  freebsd: "electron",
  openbsd: "electron",
  win32: "electron.exe",
}[process.platform];
if (!platformPath) throw new Error(`Electron builds are not available on platform: ${process.platform}`);

const distPath = path.join(elDir, "dist");
const pathTxt = path.join(elDir, "path.txt");

if (fs.existsSync(path.join(distPath, platformPath)) && fs.existsSync(pathTxt)) {
  console.log("electron binary already installed; nothing to do");
} else {
  const zip = await downloadArtifact({
    version,
    artifactName: "electron",
    platform: process.platform,
    arch: process.arch,
    checksums,
  });
  fs.mkdirSync(distPath, { recursive: true });
  // Synchronous extraction — no promise to leave unsettled. `unzip` ships on the
  // ubuntu runners; -o overwrites, -q is quiet.
  execFileSync("unzip", ["-oq", zip, "-d", distPath], { stdio: "inherit" });
  fs.chmodSync(path.join(distPath, platformPath), 0o755);
  await fs.promises.writeFile(pathTxt, platformPath);
  console.log(`electron extracted to ${distPath}; wrote path.txt -> ${platformPath}`);
}
