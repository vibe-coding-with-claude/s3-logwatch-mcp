# T-007 결과: Claude Code에 MCP Server 등록

## 수정/생성된 파일

| 파일 | 변경 | 설명 |
|---|---|---|
| `.mcp.json` | 신규 | MCP Server 등록 설정 |

## 왜 `.mcp.json`인가?

- `.claude/settings.local.json`은 permissions, hooks, env 같은 **Claude Code 설정 전용**
- MCP 서버 등록은 별도의 `.mcp.json` 파일에 해야 함 (Claude Code 표준)
- 프로젝트 루트에 위치하면 이 프로젝트에서만 활성화됨

## 등록 구조

```json
{
  "mcpServers": {
    "s3-logwatch": {
      "command": "npx",
      "args": ["tsx", "/Users/seungjae/Desktop/work/mcp-server/src/index.ts"]
    }
  }
}
```

- `npx tsx` — TypeScript 소스를 빌드 없이 직접 실행 (개발 중 편리)
- 절대 경로 — 어디서 실행해도 서버를 찾을 수 있음
- stdio transport — Claude Code가 자식 프로세스로 서버를 띄우고 stdin/stdout으로 통신

## Claude Code가 MCP Server를 인식하는 과정

1. Claude Code 시작 시 `.mcp.json` 파일을 읽음
2. `npx tsx src/index.ts` 명령으로 자식 프로세스 생성
3. 서버가 stdio transport로 연결되면 도구 목록을 요청
4. 사용자가 자연어로 질문하면 Claude가 적절한 도구를 자동 선택하여 호출
