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
// This mirrors install.js but awaits each step, so the process cannot exit until
// extraction and the path.txt write have completed. It reuses Electron's own
// bundled @electron/get + extract-zip (resolved via install.js's module context),
// and is a no-op when the binary is already present (e.g. local dev).
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const elDir = path.resolve("node_modules/electron");
const require = createRequire(path.join(elDir, "install.js"));
const { downloadArtifact } = require("@electron/get");
const extract = require("extract-zip");
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
  await extract(zip, { dir: distPath });
  await fs.promises.writeFile(pathTxt, platformPath);
  console.log(`electron extracted to ${distPath}; wrote path.txt -> ${platformPath}`);
}
