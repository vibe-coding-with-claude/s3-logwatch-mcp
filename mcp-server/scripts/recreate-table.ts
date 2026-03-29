/**
 * Athena DDL로 테이블을 재생성하는 스크립트
 *
 * 기존 fix-glue-table.ts를 대체합니다.
 * Glue SDK 대신 Athena DDL(DROP TABLE + CREATE EXTERNAL TABLE)을 사용합니다.
 *
 * 사용 시기:
 * - 테이블 스키마를 변경해야 할 때
 * - 파티션 설정을 변경해야 할 때
 * - 테이블이 손상되었을 때
 *
 * 실행 방법:
 *   npx tsx scripts/recreate-table.ts
 */

import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
} from "@aws-sdk/client-athena";
import { loadConfig } from "../src/config.js";

const config = loadConfig();
const REGION = process.env.E2E_REGION ?? loadConfig().region;
const athena = new AthenaClient({ region: REGION });

/** 데이터베이스 이름 */
const DATABASE_NAME = "s3_logwatch";
/** 테이블 이름 */
const TABLE_NAME = "logs";

/**
 * Athena DDL을 실행하고 완료까지 폴링합니다.
 * @param sql - 실행할 DDL SQL
 */
async function executeAthenaDDL(sql: string): Promise<void> {
  const start = await athena.send(new StartQueryExecutionCommand({
    QueryString: sql,
    WorkGroup: config.athena.workgroup,
    ResultConfiguration: { OutputLocation: config.athena.output_location },
  }));

  const queryId = start.QueryExecutionId!;

  // 완료까지 1초 간격으로 폴링
  while (true) {
    await new Promise(r => setTimeout(r, 1000));
    const status = await athena.send(new GetQueryExecutionCommand({
      QueryExecutionId: queryId,
    }));
    const state = status.QueryExecution?.Status?.State;
    if (state === "SUCCEEDED") break;
    if (state === "FAILED" || state === "CANCELLED") {
      throw new Error(`DDL 실패: ${status.QueryExecution?.Status?.StateChangeReason}`);
    }
  }
}

async function main() {
  // 1단계: 기존 테이블 삭제 (IF EXISTS로 없어도 에러 없음)
  console.log("기존 테이블 삭제 시도...");
  try {
    await executeAthenaDDL(`DROP TABLE IF EXISTS ${DATABASE_NAME}.${TABLE_NAME}`);
    console.log("기존 테이블 삭제 완료 (또는 존재하지 않음)");
  } catch (err) {
    console.log("테이블 삭제 실패 (무시하고 계속):", err);
  }

  // 2단계: 데이터베이스 생성 확인 (없으면 생성)
  console.log("데이터베이스 생성 확인...");
  await executeAthenaDDL(`CREATE DATABASE IF NOT EXISTS ${DATABASE_NAME}`);
  console.log(`데이터베이스 확인 완료: ${DATABASE_NAME}`);

  // 3단계: 새 테이블 생성 (Partition Projection 포함)
  // config.domains에서 도메인 이름 목록을 동적으로 추출
  const domainValues = config.domains.map(d => d.name).join(",");

  const createTableDDL = `
    CREATE EXTERNAL TABLE IF NOT EXISTS ${DATABASE_NAME}.${TABLE_NAME} (
      timestamp string,
      level string,
      service string,
      message string,
      trace_id string
    )
    PARTITIONED BY (domain string, year string, month string, day string)
    ROW FORMAT SERDE 'org.openx.data.jsonserde.JsonSerDe'
    WITH SERDEPROPERTIES ('case.insensitive' = 'true')
    LOCATION 's3://${config.s3.bucket}/${config.s3.base_prefix}'
    TBLPROPERTIES (
      'projection.enabled' = 'true',
      'projection.domain.type' = 'enum',
      'projection.domain.values' = '${domainValues}',
      'projection.year.type' = 'integer',
      'projection.year.range' = '2024,2030',
      'projection.month.type' = 'integer',
      'projection.month.range' = '1,12',
      'projection.month.digits' = '2',
      'projection.day.type' = 'integer',
      'projection.day.range' = '1,31',
      'projection.day.digits' = '2',
      'storage.location.template' = 's3://${config.s3.bucket}/${config.s3.base_prefix}\${domain}/\${year}/\${month}/\${day}/'
    )
  `;

  console.log("새 테이블 생성 중...");
  await executeAthenaDDL(createTableDDL);
  console.log(`테이블 재생성 완료: ${DATABASE_NAME}.${TABLE_NAME} (domain/year/month/day partition projection)`);
}

main().catch((err) => {
  console.error("실패:", err);
  process.exit(1);
});
