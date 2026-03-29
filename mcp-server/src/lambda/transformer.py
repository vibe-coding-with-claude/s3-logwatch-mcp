"""
Firehose Lambda 변환 핸들러

CloudWatch Logs → Firehose로 전달되는 gzip 압축 데이터를 풀고,
logGroup 이름에서 domain을 매핑하여 JSON 레코드로 변환합니다.

처리 흐름:
1. base64 디코딩 → gzip 해제 → JSON 파싱
2. CONTROL_MESSAGE는 Drop
3. logEvents 배열을 개별 레코드로 분리
4. logGroup → domain 매핑 (환경변수 DOMAIN_MAPPING)
5. Firehose 반환 형식으로 변환

앱 로그 포맷 제약 없음 — 어떤 형식이든 message 필드에 원본 그대로 보존.
"""

import base64
import gzip
import json
import os
from datetime import datetime, timezone


def load_domain_mapping():
    """환경변수 DOMAIN_MAPPING에서 logGroup → domain 매핑을 로드합니다."""
    raw = os.environ.get("DOMAIN_MAPPING", "{}")
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        print(f"DOMAIN_MAPPING JSON 파싱 실패: {raw}")
        return {}


# Lambda 콜드 스타트 시 1회만 로드 (핸들러 밖에서 초기화)
DOMAIN_MAPPING = load_domain_mapping()


def handler(event, context):
    """
    Firehose Lambda 변환 핸들러

    Parameters:
        event: Firehose가 전달하는 records 배열
        context: Lambda 실행 컨텍스트 (미사용)

    Returns:
        {"records": [...]} — Firehose가 기대하는 반환 형식
    """
    output_records = []

    for record in event["records"]:
        record_id = record["recordId"]

        try:
            # 1. base64 디코딩
            compressed = base64.b64decode(record["data"])

            # 2. gzip 해제
            decompressed = gzip.decompress(compressed)

            # 3. JSON 파싱 → CloudWatch Logs 데이터 구조
            cw_data = json.loads(decompressed.decode("utf-8"))

            # CONTROL_MESSAGE는 CloudWatch 내부 제어용 → 버림
            if cw_data.get("messageType") != "DATA_MESSAGE":
                output_records.append({
                    "recordId": record_id,
                    "result": "Dropped",
                    "data": record["data"],
                })
                continue

            # 4. logGroup → domain 매핑
            log_group = cw_data.get("logGroup", "")
            log_stream = cw_data.get("logStream", "")
            domain = DOMAIN_MAPPING.get(log_group, "unknown")

            log_events = cw_data.get("logEvents", [])

            if not log_events:
                output_records.append({
                    "recordId": record_id,
                    "result": "Dropped",
                    "data": record["data"],
                })
                continue

            # 5. logEvents를 개별 레코드로 분리
            for log_event in log_events:
                transformed = {
                    "domain": domain,
                    "log_group": log_group,
                    "log_stream": log_stream,
                    "timestamp": datetime.fromtimestamp(
                        log_event["timestamp"] / 1000, tz=timezone.utc
                    ).isoformat(),
                    "message": log_event.get("message", ""),
                }

                # JSON Lines 포맷 (줄바꿈 추가)
                json_line = json.dumps(transformed, ensure_ascii=False) + "\n"

                output_records.append({
                    "recordId": record_id,
                    "result": "Ok",
                    "data": base64.b64encode(
                        json_line.encode("utf-8")
                    ).decode("utf-8"),
                })

        except Exception as e:
            print(f"레코드 변환 실패 (recordId: {record_id}): {e}")
            output_records.append({
                "recordId": record_id,
                "result": "ProcessingFailed",
                "data": record["data"],
            })

    return {"records": output_records}
