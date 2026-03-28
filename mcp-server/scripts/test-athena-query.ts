/**
 * Athena 쿼리 테스트 스크립트
 * mock 데이터가 정상적으로 쿼리되는지 검증합니다.
 */

import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
} from "@aws-sdk/client-athena";
import { loadConfig } from "../src/config.js";

const REGION = process.env.E2E_REGION ?? "us-east-1";
const config = loadConfig();
const athena = new AthenaClient({ region: REGION });

async function runQuery(sql: string): Promise<void> {
  console.log(`\n📊 쿼리: ${sql}\n`);

  const start = await athena.send(
    new StartQueryExecutionCommand({
      QueryString: sql,
      WorkGroup: config.athena.workgroup,
      QueryExecutionContext: { Database: "s3_logwatch" },
    })
  );

  const queryId = start.QueryExecutionId!;

  // 폴링
  let state = "QUEUED";
  while (state === "QUEUED" || state === "RUNNING") {
    await new Promise((r) => setTimeout(r, 1000));
    const status = await athena.send(
      new GetQueryExecutionCommand({ QueryExecutionId: queryId })
    );
    state = status.QueryExecution?.Status?.State ?? "UNKNOWN";

    if (state === "FAILED") {
      console.error(`❌ 쿼리 실패: ${status.QueryExecution?.Status?.StateChangeReason}`);
      return;
    }
  }

  // 결과
  const results = await athena.send(
    new GetQueryResultsCommand({ QueryExecutionId: queryId })
  );

  const rows = results.ResultSet?.Rows ?? [];
  if (rows.length === 0) {
    console.log("(결과 없음)");
    return;
  }

  // 헤더
  const header = rows[0].Data?.map((d) => d.VarCharValue ?? "") ?? [];
  console.log(header.join("\t|\t"));
  console.log("-".repeat(header.join("\t|\t").length));

  // 데이터
  for (let i = 1; i < rows.length; i++) {
    const values = rows[i].Data?.map((d) => d.VarCharValue ?? "") ?? [];
    console.log(values.join("\t|\t"));
  }

  // 스캔량/비용
  const exec = await athena.send(
    new GetQueryExecutionCommand({ QueryExecutionId: queryId })
  );
  const scanned = exec.QueryExecution?.Statistics?.DataScannedInBytes ?? 0;
  const cost = (scanned / Math.pow(1024, 4)) * 5;
  console.log(`\nScanned: ${(scanned / 1024 / 1024).toFixed(2)} MB  Cost: $${cost.toFixed(6)}`);
}

async function main() {
  console.log("=== Athena Query Tests (domain-based routing) ===");

  // Test 1: domain별 집계
  await runQuery(
    "SELECT domain, count(*) as cnt FROM s3_logwatch.logs GROUP BY domain ORDER BY cnt DESC"
  );

  // Test 2: 특정 domain 조회 (user)
  await runQuery(
    "SELECT timestamp, level, service, message FROM s3_logwatch.logs WHERE domain='user' LIMIT 5"
  );

  // Test 3: domain + level 집계 (payment)
  await runQuery(
    "SELECT domain, level, count(*) as cnt FROM s3_logwatch.logs WHERE domain='payment' GROUP BY domain, level ORDER BY cnt DESC"
  );

  // Test 4: domain + 날짜 파티션 필터 (order, 2026-03)
  await runQuery(
    "SELECT count(*) as total FROM s3_logwatch.logs WHERE domain='order' AND year='2026' AND month='03'"
  );

  console.log("\n=== Tests complete ===\n");
}

main().catch((err) => {
  console.error("테스트 실패:", err);
  process.exit(1);
});
