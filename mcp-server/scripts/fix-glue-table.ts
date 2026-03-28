import { GlueClient, DeleteTableCommand, CreateTableCommand } from "@aws-sdk/client-glue";
import { loadConfig } from "../src/config.js";

const config = loadConfig();
const glue = new GlueClient({ region: "us-east-1" });

async function main() {
  // 테이블 삭제
  try {
    await glue.send(new DeleteTableCommand({ DatabaseName: "s3_logwatch", Name: "logs" }));
    console.log("✅ 기존 테이블 삭제");
  } catch {
    console.log("⏭ 테이블 없음, 새로 생성");
  }

  // 파티션 키와 겹치는 컬럼 제거
  const partitionKeyNames = new Set(config.partitioning.keys);
  const columns = config.schema.columns
    .filter((c) => !partitionKeyNames.has(c.name))
    .map((c) => ({ Name: c.name, Type: c.type }));
  const partitionKeys = config.partitioning.keys.map((k) => ({ Name: k, Type: "string" }));

  const location = `s3://${config.s3.bucket}/${config.s3.prefix}`;

  await glue.send(
    new CreateTableCommand({
      DatabaseName: "s3_logwatch",
      TableInput: {
        Name: "logs",
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
          // Partition Projection 설정
          // Athena가 파티션을 자동 추론합니다 (MSCK REPAIR TABLE 불필요)
          "projection.enabled": "true",
          // level: 고정 enum 값
          "projection.level.type": "enum",
          "projection.level.values": "TRACE,DEBUG,INFO,WARN,ERROR,FATAL",
          // domain: 서비스 도메인 enum
          "projection.domain.type": "enum",
          "projection.domain.values": "payment,auth,order,user,notification",
          // year: 정수 범위
          "projection.year.type": "integer",
          "projection.year.range": "2024,2030",
          // month: 정수 범위 (01~12)
          "projection.month.type": "integer",
          "projection.month.range": "1,12",
          "projection.month.digits": "2",
          // day: 정수 범위 (01~31)
          "projection.day.type": "integer",
          "projection.day.range": "1,31",
          "projection.day.digits": "2",
          // 파티션 저장 위치 템플릿
          "storage.location.template": `s3://${config.s3.bucket}/${config.s3.prefix}level=\${level}/domain=\${domain}/year=\${year}/month=\${month}/day=\${day}/`,
        },
      },
    })
  );
  console.log("✅ 테이블 재생성 (integer partition projection)");
}

main().catch((err) => {
  console.error("실패:", err);
  process.exit(1);
});
