import { describe, it, expect } from "vitest";
import { parseRepoConfig, readRepoConfig } from "./repo-config.js";

const valid = `testCommand: npm test -- --reporter=json
reportFormat: vitest-json
toolchain: node
`;

describe("parseRepoConfig", () => {
  it("parses a valid .dugout/config.yaml into the three Repo-config fields", () => {
    expect(parseRepoConfig(valid)).toEqual({
      testCommand: "npm test -- --reporter=json",
      reportFormat: "vitest-json",
      toolchain: "node",
    });
  });

  it("throws a fix-it error naming the file when testCommand is missing", () => {
    const noCmd = "reportFormat: vitest-json\ntoolchain: node\n";
    expect(() => parseRepoConfig(noCmd)).toThrow(/testCommand/);
    expect(() => parseRepoConfig(noCmd)).toThrow(/config\.yaml/);
  });

  it("throws when reportFormat is not a known ReportParser discriminant", () => {
    const bad = "testCommand: x\nreportFormat: junit\ntoolchain: node\n";
    expect(() => parseRepoConfig(bad)).toThrow(/reportFormat/);
  });

  it("throws when toolchain is not a known image target", () => {
    const bad = "testCommand: x\nreportFormat: trx\ntoolchain: erlang\n";
    expect(() => parseRepoConfig(bad)).toThrow(/toolchain/);
  });

  it("throws on a non-mapping document (e.g. empty file)", () => {
    expect(() => parseRepoConfig("")).toThrow(/config\.yaml/);
  });

  it("throws on invalid YAML syntax", () => {
    expect(() => parseRepoConfig("testCommand: [unclosed\n")).toThrow();
  });
});

describe("readRepoConfig", () => {
  it("reads and parses .dugout/config.yaml relative to the clone root", async () => {
    const reads: string[] = [];
    const cfg = await readRepoConfig("/ws/api", {
      readFile: async (p) => {
        reads.push(p);
        return valid;
      },
    });
    expect(cfg.reportFormat).toBe("vitest-json");
    expect(reads).toEqual(["/ws/api/.dugout/config.yaml"]);
  });

  it("throws a fix-it error when the config file is absent", async () => {
    const enoent = Object.assign(new Error("no such file"), { code: "ENOENT" });
    const promise = readRepoConfig("/ws/api", {
      readFile: async () => {
        throw enoent;
      },
    });
    await expect(promise).rejects.toThrow(/config\.yaml/);
  });
});
