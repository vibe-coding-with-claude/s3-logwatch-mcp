/**
 * init-infra 도구 로직을 직접 실행하는 스크립트
 * MCP 프로토콜 없이 AWS 리소스를 생성합니다.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../src/tools/index.js";

const server = new McpServer({ name: "s3-logwatch-init", version: "0.1.0" });
registerTools(server);

// MCP Server의 내부 도구 핸들러를 직접 호출할 수 없으므로,
// init.ts의 로직을 재사용하기 위해 동일한 AWS SDK 호출을 수행합니다.

import { S3Client, CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { GlueClient, CreateDatabaseCommand, GetDatabaseCommand, CreateTableCommand, GetTableCommand } from "@aws-sdk/client-glue";
import { AthenaClient, CreateWorkGroupCommand, GetWorkGroupCommand } from "@aws-sdk/client-athena";
import { loadConfig } from "../src/config.js";

const REGION = process.env.E2E_REGION ?? "us-east-1";
const config = loadConfig();

async function main() {
  console.log("\n=== init-infra 실행 ===\n");
  console.log(`리전: ${REGION}`);
  console.log(`S3 버킷: ${config.s3.bucket}`);
  console.log(`Athena 워크그룹: ${config.athena.workgroup}\n`);

  const s3 = new S3Client({ region: REGION });
  const glue = new GlueClient({ region: REGION });
  const athena = new AthenaClient({ region: REGION });

  // 1. S3 버킷
  try {
    await s3.send(new HeadBucketCommand({ Bucket: config.s3.bucket }));
    console.log(`⏭ S3 버킷 이미 존재: ${config.s3.bucket}`);
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: config.s3.bucket }));
    console.log(`✅ S3 버킷 생성: ${config.s3.bucket}`);
  }

  // 2. Glue 데이터베이스
  try {
    await glue.send(new GetDatabaseCommand({ Name: "s3_logwatch" }));
    console.log(`⏭ Glue DB 이미 존재: s3_logwatch`);
  } catch {
    await glue.send(new CreateDatabaseCommand({
      DatabaseInput: { Name: "s3_logwatch", Description: "s3-logwatch log analysis" }
    }));
    console.log(`✅ Glue DB 생성: s3_logwatch`);
  }

  // 3. Glue 테이블 (JSON SerDe + Partition Projection)
  try {
    await glue.send(new GetTableCommand({ DatabaseName: "s3_logwatch", Name: "logs" }));
    console.log(`⏭ Glue 테이블 이미 존재: s3_logwatch.logs`);
  } catch {
    const columns = config.schema.columns.map(c => ({ Name: c.name, Type: c.type }));
    const partitionKeys = config.partitioning.keys.map(k => ({ Name: k, Type: "string" }));
    const location = `s3://${config.s3.bucket}/${config.s3.prefix}`;

    await glue.send(new CreateTableCommand({
      DatabaseName: "s3_logwatch",
      TableInput: {
        Name: "logs",
        Description: "s3-logwatch 로그 테이블 (JSON SerDe + Partition Projection)",
        StorageDescriptor: {
          Columns: columns,
          Location: location,
          InputFormat: "org.apache.hadoop.mapred.TextInputFormat",
          OutputFormat: "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat",
          SerdeInfo: {
            SerializationLibrary: "org.openx.data.jsonserde.JsonSerDe",
            Parameters: { "case.insensitive": "true" },
          },
          Compressed: false,
          StoredAsSubDirectories: false,
        },
        PartitionKeys: partitionKeys,
        TableType: "EXTERNAL_TABLE",
        Parameters: {
          classification: "json",
          "projection.enabled": "true",
          "projection.level.type": "enum",
          "projection.level.values": "TRACE,DEBUG,INFO,WARN,ERROR,FATAL",
          "projection.domain.type": "injected",
          "projection.year.type": "date",
          "projection.year.format": "yyyy",
          "projection.year.range": "2024,2030",
          "projection.year.interval": "1",
          "projection.year.interval.unit": "YEARS",
          "projection.month.type": "date",
          "projection.month.format": "MM",
          "projection.month.range": "01,12",
          "projection.month.interval": "1",
          "projection.month.interval.unit": "MONTHS",
          "projection.day.type": "date",
          "projection.day.format": "dd",
          "projection.day.range": "01,31",
          "projection.day.interval": "1",
          "projection.day.interval.unit": "DAYS",
          "storage.location.template": `s3://${config.s3.bucket}/${config.s3.prefix}level=\${level}/domain=\${domain}/year=\${year}/month=\${month}/day=\${day}/`,
        },
      },
    }));
    console.log(`✅ Glue 테이블 생성: s3_logwatch.logs (JSON SerDe + Partition Projection)`);
  }

  // 4. Athena 워크그룹
  try {
    await athena.send(new GetWorkGroupCommand({ WorkGroup: config.athena.workgroup }));
    console.log(`⏭ Athena 워크그룹 이미 존재: ${config.athena.workgroup}`);
  } catch {
    await athena.send(new CreateWorkGroupCommand({
      Name: config.athena.workgroup,
      Description: "s3-logwatch Athena workgroup",
      Configuration: {
        ResultConfiguration: { OutputLocation: config.athena.output_location },
        EnforceWorkGroupConfiguration: true,
        PublishCloudWatchMetricsEnabled: true,
      },
    }));
    console.log(`✅ Athena 워크그룹 생성: ${config.athena.workgroup}`);
  }

  console.log("\n=== init-infra 완료 ===\n");
}

main().catch((err) => {
  console.error("init-infra 실패:", err);
  process.exit(1);
});
