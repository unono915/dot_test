# 학교 정보자산 관리

**개발 중인 소스 체크포인트입니다. 아직 설치하거나 업무에 사용할 수 있는 완성 앱·설치 파일·릴리스가 아닙니다.**

Windows 우선의 오프라인 단일 관리자용 Electron 프로그램을 개발합니다. 자산·사람·장소·IP 관리, 변경 이력, 실사, 검토형 엑셀 이관, 첨부, 백업·복원과 인계 자료가 목표입니다. LAN 스캔, 자동 수집, 클라우드 동기화, 원격 분석은 포함하지 않습니다.

- [제품 명세 및 수용 기준 45개](docs/specs/school-asset-desktop-review.md)
- [구현 계획과 검증 기준](docs/plans/school-asset-desktop-implementation-plan.md)
- [Windows 개발 재개 안내](docs/WINDOWS_HANDOFF.md)
- [Windows Codex에 붙여 넣을 프롬프트](docs/WINDOWS_CODEX_PROMPT.txt)

클라우드 개발은 중단되었고 Windows 11 x64 PC에서 이어서 개발합니다. 전체 제품 수용 기준 45개는 모두 미실행입니다.

## 현재 체크포인트 — 2026-10-06 (Windows)

| 항목 | 실제 상태 |
|---|---|
| 설계·합의 계획 | 검토 완료. 기능 구현 완료를 뜻하지 않습니다. |
| 안전한 앱 셸 (구현 1단계 첫 작업) | 구현·자동 시험 통과(아래 참조). `app://bundle` 전용 출처, 좁은 preload API(`getAppInfo` 1개), main의 IPC 발신자·main-frame·출처·요청 스키마 검증, 외부 탐색·새 창·다운로드·권한·네트워크 차단, 단일 인스턴스, SQLite 기반 데이터 폴더 잠금, 최소 한국어 화면. 업무 기능은 없습니다. |
| Windows 의존성 설치 | Windows 11 Education x64, Node 24.21.0 / npm 11.19.0에서 `npm ci` 종료 코드 0. better-sqlite3 설치 스크립트 때문에 Visual Studio 2022 Build Tools(C++ 워크로드)가 필요했습니다. npm 11의 `allowScripts` 정책으로 `better-sqlite3`, `electron-winstaller` 설치 스크립트만 `package.json`에 명시 허용했습니다. `npm audit` 중간 심각도 2건은 검토 전입니다. |
| Windows SQLite 도구 검사 | `check:sqlite:node`(Node 24.21.0)와 `check:sqlite:electron`(Electron 44.5.1 / 내장 Node 24.21.0) 각각 1개 통과, 실패·건너뜀 0, 종료 코드 0. SQLite 3.53.4. |
| Windows 최소 Electron 진단 | `electron-probe.cjs` 종료 코드 0. 한글 렌더링·백업 값, PRAGMA(FK 1·trusted_schema 0·WAL·synchronous 2), sandbox/contextIsolation true, nodeIntegration false, 렌더러 process/require undefined 확인. |
| 제품 기능·전체 수용 기준 | 미구현·미검증. 도메인 업무, 업무 화면, 파일 이관, 백업·복원 등의 통과를 주장하지 않습니다. AC-39는 셸 일부 항목만 시험했고 기준 전체는 미실행입니다. |
| Windows 설치·IME·배율·새 PC 복원·규모 | 미검증. 설치 파일과 릴리스는 아직 없습니다. |

실행 기록·로컬 상태·인증정보·실제 학교 자료는 저장소에 포함하지 않습니다.

## 개발 명령

Node 24.x (`>=24.19.0 <25`)와 npm이 필요합니다. Windows에서는 better-sqlite3 설치 스크립트 때문에 Visual Studio Build Tools의 C++ 워크로드도 필요했습니다. 공식 설치 출처와 주의사항은 [인계 안내](docs/WINDOWS_HANDOFF.md)를 따릅니다.

```sh
npm ci
npm run typecheck          # main/preload, renderer, 시험 코드 타입 검사
npm run test:unit          # Vitest 단위·통합 시험
npm run test:e2e           # 빌드 후 실제 Electron을 Playwright로 구동하는 시험
npm run check:sqlite:node
npm run check:sqlite:electron
npm start                  # 빌드 후 개발용 창 실행 (업무 기능 없음)
```

`test:e2e`와 `start`는 디스플레이가 있는 데스크톱 세션이 필요합니다. E2E 시험은 임시 합성 프로필 폴더를 사용하며 `SCHOOL_ASSET_DEV_USER_DATA` 환경 변수는 패키징되지 않은 개발 실행에서만 적용됩니다. 패키징·설치 프로그램 명령은 아직 없습니다.

SQLite 도구 검사는 임시 합성 DB에서 엔진 버전, PRAGMA, 실패 트랜잭션의 롤백, Online Backup을 확인합니다. Electron 검사는 `ELECTRON_RUN_AS_NODE=1`을 사용하며 창·렌더러·제품 저장 계층을 검증하지 않습니다. 디스플레이가 있는 터미널에서는 다음 최소 진단도 실행할 수 있습니다.

```sh
node node_modules/electron/cli.js tests/support/electron-probe.cjs
```

## 소스 구성

| 경로 | 내용 |
|---|---|
| `src/main/` | Electron main: 창·세션 보안, `app://bundle` 프로토콜, IPC 라우터·계약, 데이터 폴더 잠금 |
| `src/preload/index.cts` | sandbox preload. `window.schoolAsset.getAppInfo()`만 노출 |
| `src/renderer/` | React 한국어 화면(로컬 번들) |
| `tests/unit/` | 출처·경로·IPC 검증, 데이터 폴더 잠금(다른 프로세스·강제 종료 포함) |
| `tests/e2e/` | 실제 Electron: 보안 설정, CSP, 부정 출처 IPC, 탐색·새 창·다운로드·권한·네트워크 차단, 두 번째 인스턴스 |
| `tests/toolchain/`, `scripts/`, `tests/support/` | 기존 SQLite·Electron 도구 진단 |
