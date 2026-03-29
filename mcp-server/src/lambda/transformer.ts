/**
 * Firehose Lambda 변환 핸들러 (transformer.ts)
 *
 * 이 파일의 역할:
 * - Kinesis Data Firehose의 데이터 변환 Lambda로 동작합니다.
 * - CloudWatch Logs 구독 필터에서 전달된 레코드를 처리합니다.
 *
 * 처리 흐름:
 * 1. Firehose가 records 배열을 전달합니다.
 * 2. 각 record는 base64 인코딩 + gzip 압축된 CloudWatch Logs 데이터입니다.
 * 3. base64 디코딩 -> gzip 해제 -> JSON 파싱합니다.
 * 4. CloudWatch Logs 데이터 내 logEvents 배열을 개별 레코드로 분리합니다.
 * 5. 환경변수 DOMAIN_MAPPING에서 logGroup -> domain 매핑을 수행합니다.
 * 6. Firehose가 기대하는 반환 형식으로 변환합니다.
 *
 * 왜 Lambda 변환이 필요한가?
 * - CloudWatch Logs -> Firehose로 전달되는 데이터는 gzip 압축되어 있습니다.
 * - 하나의 레코드 안에 여러 logEvents가 배열로 들어있습니다.
 * - Athena에서 각 로그를 개별 행으로 쿼리하려면 레코드를 분리해야 합니다.
 * - logGroup 정보를 기반으로 domain을 매핑하여 동적 파티셔닝에 활용합니다.
 */

import { gunzipSync } from "node:zlib";

// =============================================================
// 타입 정의
// =============================================================

/**
 * CloudWatch Logs에서 Firehose로 전달되는 데이터 구조
 *
 * messageType:
 * - "DATA_MESSAGE": 실제 로그 데이터
 * - "CONTROL_MESSAGE": CloudWatch 내부 제어 메시지 (처리하지 않음)
 */
interface CloudWatchLogsData {
  messageType: string;
  logGroup: string;
  logStream: string;
  logEvents: CloudWatchLogEvent[];
}

/**
 * CloudWatch Logs 개별 로그 이벤트
 *
 * - id: CloudWatch가 부여한 고유 ID
 * - timestamp: 로그 발생 시간 (epoch milliseconds)
 * - message: 로그 메시지 본문
 */
interface CloudWatchLogEvent {
  id: string;
  timestamp: number;
  message: string;
}

/**
 * Firehose가 Lambda에 전달하는 이벤트 구조
 *
 * - records: 변환할 레코드 배열
 * - 각 레코드는 recordId와 base64 인코딩된 data를 포함합니다.
 */
interface FirehoseTransformationEvent {
  records: FirehoseInputRecord[];
}

/**
 * Firehose 입력 레코드
 *
 * - recordId: Firehose가 부여한 레코드 식별자 (반환 시 동일한 값을 사용해야 함)
 * - data: base64 인코딩된 원본 데이터
 */
interface FirehoseInputRecord {
  recordId: string;
  data: string;
}

/**
 * Lambda가 Firehose에 반환하는 응답 구조
 */
interface FirehoseTransformationResult {
  records: FirehoseOutputRecord[];
}

/**
 * Firehose 출력 레코드
 *
 * - recordId: 입력 레코드와 동일한 ID
 * - result: "Ok" (정상), "Dropped" (버림), "ProcessingFailed" (실패)
 * - data: base64 인코딩된 변환 결과 데이터
 */
interface FirehoseOutputRecord {
  recordId: string;
  result: "Ok" | "Dropped" | "ProcessingFailed";
  data: string;
}

/**
 * 변환 후 출력되는 개별 로그 레코드
 *
 * Firehose 동적 파티셔닝과 Athena 테이블 스키마에 맞춘 구조입니다.
 * - domain: logGroup에서 매핑된 도메인 (예: "payment", "user")
 * - log_group: 원본 CloudWatch Log Group 이름
 * - log_stream: 원본 CloudWatch Log Stream 이름
 * - timestamp: 로그 발생 시간 (ISO 8601 형식)
 * - message: 로그 메시지 본문
 */
interface TransformedRecord {
  domain: string;
  log_group: string;
  log_stream: string;
  timestamp: string;
  message: string;
}

// =============================================================
// 환경변수에서 도메인 매핑 로드
// =============================================================

/**
 * 환경변수 DOMAIN_MAPPING에서 logGroup -> domain 매핑을 파싱합니다.
 *
 * 환경변수 형식 (JSON):
 * {"\/ecs\/payment-api":"payment","\/ecs\/user-api":"user"}
 *
 * 왜 환경변수로 관리하나?
 * - Lambda 함수의 설정은 환경변수로 주입하는 것이 AWS 모범 사례입니다.
 * - 코드를 변경하지 않고도 매핑을 업데이트할 수 있습니다.
 * - init-infra 도구에서 Lambda 생성 시 config의 connections에서 매핑을 생성합니다.
 *
 * @returns logGroup을 키, domain을 값으로 하는 객체
 */
function loadDomainMapping(): Record<string, string> {
  const raw = process.env.DOMAIN_MAPPING;
  if (!raw) {
    // 매핑이 없으면 빈 객체를 반환합니다.
    // 매핑되지 않은 logGroup의 레코드는 "unknown" 도메인으로 처리됩니다.
    return {};
  }
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    // JSON 파싱 실패 시 빈 객체를 반환합니다.
    // Lambda CloudWatch 로그에서 이 경고를 확인할 수 있습니다.
    console.error("DOMAIN_MAPPING 환경변수 JSON 파싱 실패:", raw);
    return {};
  }
}

// =============================================================
// Lambda 핸들러
// =============================================================

/**
 * Firehose Lambda 변환 핸들러
 *
 * Firehose가 이 함수를 호출하여 데이터를 변환합니다.
 * 변환 과정:
 * 1. base64 디코딩 -> gzip 해제 -> JSON 파싱
 * 2. CONTROL_MESSAGE는 Dropped 처리
 * 3. logEvents를 개별 레코드로 분리
 * 4. logGroup -> domain 매핑 적용
 * 5. 결과를 base64 인코딩하여 Firehose에 반환
 *
 * 중요: Firehose는 입력 recordId와 동일한 recordId를 반환해야 합니다.
 * 하나의 입력 레코드에서 여러 출력 레코드가 생성될 수 있습니다.
 * 이 경우 첫 번째 레코드에 원래 recordId를 사용하고,
 * 나머지는 새로운 recordId를 부여합니다 (Firehose가 허용).
 *
 * @param event - Firehose가 전달하는 변환 이벤트
 * @returns Firehose가 기대하는 변환 결과
 */
export async function handler(
  event: FirehoseTransformationEvent
): Promise<FirehoseTransformationResult> {
  // 환경변수에서 도메인 매핑 로드
  const domainMapping = loadDomainMapping();

  // 출력 레코드 배열
  const outputRecords: FirehoseOutputRecord[] = [];

  for (const record of event.records) {
    try {
      // 1단계: base64 디코딩
      const compressed = Buffer.from(record.data, "base64");

      // 2단계: gzip 해제
      const decompressed = gunzipSync(compressed);

      // 3단계: JSON 파싱 -> CloudWatch Logs 데이터 구조
      const cwData = JSON.parse(decompressed.toString("utf-8")) as CloudWatchLogsData;

      // CONTROL_MESSAGE는 CloudWatch 내부 제어용이므로 버립니다
      if (cwData.messageType === "CONTROL_MESSAGE") {
        outputRecords.push({
          recordId: record.recordId,
          result: "Dropped",
          data: record.data,
        });
        continue;
      }

      // DATA_MESSAGE가 아닌 알 수 없는 messageType도 버립니다
      if (cwData.messageType !== "DATA_MESSAGE") {
        outputRecords.push({
          recordId: record.recordId,
          result: "Dropped",
          data: record.data,
        });
        continue;
      }

      // 4단계: logGroup -> domain 매핑
      // 매핑이 없으면 "unknown" 도메인으로 분류합니다
      const domain = domainMapping[cwData.logGroup] ?? "unknown";

      // 5단계: logEvents를 개별 레코드로 분리
      // 각 logEvent가 하나의 Athena 행이 됩니다
      if (cwData.logEvents.length === 0) {
        // logEvents가 비어있으면 Dropped 처리
        outputRecords.push({
          recordId: record.recordId,
          result: "Dropped",
          data: record.data,
        });
        continue;
      }

      for (let i = 0; i < cwData.logEvents.length; i++) {
        const logEvent = cwData.logEvents[i];

        // 변환된 레코드 생성
        const transformed: TransformedRecord = {
          domain,
          log_group: cwData.logGroup,
          log_stream: cwData.logStream,
          // epoch milliseconds를 ISO 8601 형식으로 변환
          timestamp: new Date(logEvent.timestamp).toISOString(),
          message: logEvent.message,
        };

        // JSON 문자열로 변환 + 줄바꿈 추가 (JSON Lines 포맷)
        const jsonLine = JSON.stringify(transformed) + "\n";

        // base64 인코딩하여 Firehose 출력 레코드 생성
        outputRecords.push({
          // 첫 번째 레코드는 원래 recordId를 사용합니다
          // Firehose는 원래 recordId가 반드시 하나 포함되어야 합니다
          recordId: record.recordId,
          result: "Ok",
          data: Buffer.from(jsonLine, "utf-8").toString("base64"),
        });
      }
    } catch (error: unknown) {
      // 변환 실패 시 ProcessingFailed로 처리합니다
      // Firehose는 실패한 레코드를 ErrorOutputPrefix 경로에 저장합니다
      const message = error instanceof Error ? error.message : String(error);
      console.error(`레코드 변환 실패 (recordId: ${record.recordId}):`, message);
      outputRecords.push({
        recordId: record.recordId,
        result: "Dropped",
        data: record.data,
      });
    }
  }

  return { records: outputRecords };
}
