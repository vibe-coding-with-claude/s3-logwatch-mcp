import { describe, it, expect } from "vitest";
import { buildCreateTableDDL } from "../tools/init.js";
import { DEFAULT_CONFIG, type AppConfig } from "../config.js";

describe("buildCreateTableDDL", () => {
  it("should include CREATE EXTERNAL TABLE in the output", () => {
    const ddl = buildCreateTableDDL(DEFAULT_CONFIG);
    expect(ddl).toContain("CREATE EXTERNAL TABLE");
  });

  it("should include IF NOT EXISTS for idempotency", () => {
    const ddl = buildCreateTableDDL(DEFAULT_CONFIG);
    expect(ddl).toContain("IF NOT EXISTS");
  });

  it("should reflect domain names in projection.domain.values", () => {
    const config: AppConfig = {
      ...DEFAULT_CONFIG,
      domains: [
        { name: "user", s3_prefix: "seungjae/user/" },
        { name: "order", s3_prefix: "seungjae/order/" },
      ],
    };
    const ddl = buildCreateTableDDL(config);
    expect(ddl).toContain("'projection.domain.values' = 'user,order'");
  });

  it("should include all configured domain names in projection.domain.values", () => {
    const ddl = buildCreateTableDDL(DEFAULT_CONFIG);
    const expectedValues = DEFAULT_CONFIG.domains.map((d) => d.name).join(",");
    expect(ddl).toContain(`'projection.domain.values' = '${expectedValues}'`);
  });

  it("should include base_prefix in storage.location.template", () => {
    const ddl = buildCreateTableDDL(DEFAULT_CONFIG);
    expect(ddl).toContain(DEFAULT_CONFIG.s3.base_prefix);
    expect(ddl).toContain("storage.location.template");
  });

  it("should include the S3 bucket name in the LOCATION clause", () => {
    const config: AppConfig = {
      ...DEFAULT_CONFIG,
      s3: { bucket: "my-test-bucket", base_prefix: "prefix/" },
    };
    const ddl = buildCreateTableDDL(config);
    expect(ddl).toContain("s3://my-test-bucket/prefix/");
  });

  it("should produce empty domain values when domains array is empty", () => {
    const config: AppConfig = {
      ...DEFAULT_CONFIG,
      domains: [],
    };
    const ddl = buildCreateTableDDL(config);
    expect(ddl).toContain("'projection.domain.values' = ''");
  });

  it("should include partition projection settings for year, month, and day", () => {
    const ddl = buildCreateTableDDL(DEFAULT_CONFIG);
    expect(ddl).toContain("projection.year.type");
    expect(ddl).toContain("projection.month.type");
    expect(ddl).toContain("projection.day.type");
  });

  it("should use JsonSerDe for row format", () => {
    const ddl = buildCreateTableDDL(DEFAULT_CONFIG);
    expect(ddl).toContain("JsonSerDe");
  });
});
