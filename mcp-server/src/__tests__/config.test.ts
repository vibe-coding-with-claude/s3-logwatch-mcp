import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  validateConfig,
  DEFAULT_CONFIG,
  mergeWithDefaults,
  loadConfig,
  type AppConfig,
} from "../config.js";

// ---------------------------------------------------------------------------
// loadConfig: 파일 없을 때 기본값 반환
// ---------------------------------------------------------------------------
describe("loadConfig", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should return default config when config file does not exist", () => {
    // fs.existsSync를 mock하여 디렉토리는 존재하지만 파일은 없는 상황 시뮬레이션
    vi.mock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        existsSync: vi.fn((path: string) => {
          if (typeof path === "string" && path.endsWith("config.yaml")) {
            return false;
          }
          // 디렉토리는 존재한다고 가정
          return true;
        }),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      };
    });

    const config = loadConfig();

    expect(config.s3.bucket).toBe(DEFAULT_CONFIG.s3.bucket);
    expect(config.s3.base_prefix).toBe(DEFAULT_CONFIG.s3.base_prefix);
    expect(config.domains).toEqual(DEFAULT_CONFIG.domains);
    expect(config.firehose).toEqual(DEFAULT_CONFIG.firehose);

    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// validateConfig
// ---------------------------------------------------------------------------
describe("validateConfig", () => {
  it("should return no errors for a valid config", () => {
    const errors = validateConfig(DEFAULT_CONFIG);
    expect(errors).toHaveLength(0);
  });

  it("should return an error when s3.bucket is empty", () => {
    const config: AppConfig = {
      ...DEFAULT_CONFIG,
      s3: { ...DEFAULT_CONFIG.s3, bucket: "" },
    };
    const errors = validateConfig(config);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("bucket"))).toBe(true);
  });

  it("should return an error when s3.base_prefix is empty", () => {
    const config: AppConfig = {
      ...DEFAULT_CONFIG,
      s3: { ...DEFAULT_CONFIG.s3, base_prefix: "" },
    };
    const errors = validateConfig(config);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("base_prefix"))).toBe(true);
  });

  it("should return an error when domains is an empty array", () => {
    const config: AppConfig = {
      ...DEFAULT_CONFIG,
      domains: [],
    };
    const errors = validateConfig(config);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("domains"))).toBe(true);
  });

  it("should return an error when firehose.delivery_stream is empty", () => {
    const config: AppConfig = {
      ...DEFAULT_CONFIG,
      firehose: { ...DEFAULT_CONFIG.firehose, delivery_stream: "" },
    };
    const errors = validateConfig(config);
    expect(errors.some((e) => e.includes("delivery_stream"))).toBe(true);
  });

  it("should return an error when firehose.buffer_interval is 0 or negative", () => {
    const config: AppConfig = {
      ...DEFAULT_CONFIG,
      firehose: { ...DEFAULT_CONFIG.firehose, buffer_interval: 0 },
    };
    const errors = validateConfig(config);
    expect(errors.some((e) => e.includes("buffer_interval"))).toBe(true);
  });

  it("should return an error when firehose.buffer_size is 0 or negative", () => {
    const config: AppConfig = {
      ...DEFAULT_CONFIG,
      firehose: { ...DEFAULT_CONFIG.firehose, buffer_size: -1 },
    };
    const errors = validateConfig(config);
    expect(errors.some((e) => e.includes("buffer_size"))).toBe(true);
  });

  it("should return an error when schema.columns is empty", () => {
    const config: AppConfig = {
      ...DEFAULT_CONFIG,
      schema: { columns: [] },
    };
    const errors = validateConfig(config);
    expect(errors.some((e) => e.includes("columns"))).toBe(true);
  });

  it("should return an error when partitioning.keys is empty", () => {
    const config: AppConfig = {
      ...DEFAULT_CONFIG,
      partitioning: { keys: [] },
    };
    const errors = validateConfig(config);
    expect(errors.some((e) => e.includes("partitioning"))).toBe(true);
  });

  it("should return an error when athena.workgroup is empty", () => {
    const config: AppConfig = {
      ...DEFAULT_CONFIG,
      athena: { ...DEFAULT_CONFIG.athena, workgroup: "" },
    };
    const errors = validateConfig(config);
    expect(errors.some((e) => e.includes("workgroup"))).toBe(true);
  });

  it("should return an error when athena.output_location is empty", () => {
    const config: AppConfig = {
      ...DEFAULT_CONFIG,
      athena: { ...DEFAULT_CONFIG.athena, output_location: "" },
    };
    const errors = validateConfig(config);
    expect(errors.some((e) => e.includes("output_location"))).toBe(true);
  });

  it("should return an error when connections is not an array", () => {
    const config = {
      ...DEFAULT_CONFIG,
      connections: "not-an-array" as unknown as AppConfig["connections"],
    };
    const errors = validateConfig(config);
    expect(errors.some((e) => e.includes("connections"))).toBe(true);
  });

  it("should return an error when a domain entry is missing name", () => {
    const config: AppConfig = {
      ...DEFAULT_CONFIG,
      domains: [{ name: "", s3_prefix: "seungjae/test/" }],
    };
    const errors = validateConfig(config);
    expect(errors.some((e) => e.includes("name"))).toBe(true);
  });

  it("should return an error when a domain entry is missing s3_prefix", () => {
    const config: AppConfig = {
      ...DEFAULT_CONFIG,
      domains: [{ name: "test", s3_prefix: "" }],
    };
    const errors = validateConfig(config);
    expect(errors.some((e) => e.includes("s3_prefix"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_CONFIG passes validation
// ---------------------------------------------------------------------------
describe("DEFAULT_CONFIG", () => {
  it("should pass validateConfig without errors", () => {
    const errors = validateConfig(DEFAULT_CONFIG);
    expect(errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// mergeWithDefaults
// ---------------------------------------------------------------------------
describe("mergeWithDefaults", () => {
  it("should fill missing fields with default values", () => {
    const partial = {
      s3: { bucket: "my-custom-bucket", base_prefix: "custom/" },
    };
    const result = mergeWithDefaults(partial);

    // Provided fields should be used
    expect(result.s3.bucket).toBe("my-custom-bucket");
    expect(result.s3.base_prefix).toBe("custom/");

    // Missing fields should fall back to defaults
    expect(result.firehose).toEqual(DEFAULT_CONFIG.firehose);
    expect(result.athena).toEqual(DEFAULT_CONFIG.athena);
    expect(result.domains).toEqual(DEFAULT_CONFIG.domains);
    expect(result.schema).toEqual(DEFAULT_CONFIG.schema);
    expect(result.partitioning).toEqual(DEFAULT_CONFIG.partitioning);
    expect(result.connections).toEqual(DEFAULT_CONFIG.connections);
  });

  it("should use default domains when partial.domains is empty", () => {
    const partial = { domains: [] as AppConfig["domains"] };
    const result = mergeWithDefaults(partial);
    expect(result.domains).toEqual(DEFAULT_CONFIG.domains);
  });

  it("should use provided domains when partial.domains is non-empty", () => {
    const customDomains = [{ name: "custom", s3_prefix: "seungjae/custom/" }];
    const partial = { domains: customDomains };
    const result = mergeWithDefaults(partial);
    expect(result.domains).toEqual(customDomains);
  });

  it("should use default schema columns when partial.schema.columns is empty", () => {
    const partial = { schema: { columns: [] } };
    const result = mergeWithDefaults(partial);
    expect(result.schema.columns).toEqual(DEFAULT_CONFIG.schema.columns);
  });

  it("should use default partitioning keys when partial.partitioning.keys is empty", () => {
    const partial = { partitioning: { keys: [] as string[] } };
    const result = mergeWithDefaults(partial);
    expect(result.partitioning.keys).toEqual(DEFAULT_CONFIG.partitioning.keys);
  });

  it("should return a complete AppConfig from an empty partial", () => {
    const result = mergeWithDefaults({});
    const errors = validateConfig(result);
    expect(errors).toHaveLength(0);
  });
});
