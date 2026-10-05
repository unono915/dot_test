# 학교 정보자산 관리

**개발 진행 중입니다. 아직 설치하거나 업무에 사용할 수 있는 완성 앱이 아닙니다.**

Windows 우선의 오프라인 단일 관리자용 Electron 프로그램을 개발합니다. 자산·사람·장소·IP 관리, 변경 이력, 실사, 검토형 엑셀 이관, 첨부, 백업·복원과 인계 자료가 목표입니다. LAN 스캔, 자동 수집, 클라우드 동기화, 원격 분석은 포함하지 않습니다.

- [제품 명세 및 수용 기준 45개](docs/specs/school-asset-desktop-review.md)
- [구현 계획과 검증 기준](docs/plans/school-asset-desktop-implementation-plan.md)

## 현재 체크포인트 — 2026-10-05

| 항목 | 실제 상태 |
|---|---|
| 설계·합의 계획 | 검토 완료. 기능 구현 완료를 뜻하지 않습니다. |
| 개발 의존성 | 고정 버전 설치 성공: 406개 패키지, 종료 코드 0. lockfile 포함. |
| 호스트 Node SQLite | Node 24.19.0에서 better-sqlite3 13.0.3 / SQLite 3.53.4 로딩 확인. |
| Electron Node 모드 SQLite | Electron 44.5.1 / 내장 Node 24.21.0에서 SQLite 3.53.4 로딩 확인. GUI 실행 검증과 다릅니다. |
| 합성 SQLite 도구 검사 | `check:sqlite:node`와 `check:sqlite:electron` 각각 1개 통과, 실패·건너뜀 0, 종료 코드 0. 버전·PRAGMA·롤백·Online Backup 확인. |
| Linux 최소 창·렌더러 도구 검사 | 일반 데스크톱 터미널의 실제 Electron에서 한글 렌더링·SQLite 백업 확인, 종료 코드 0. sandbox/contextIsolation 활성, nodeIntegration 비활성, 렌더러의 process/require 미노출 확인. 제품 GUI 시험과는 다릅니다. |
| 제품 기능·전체 수용 기준 | 미구현·미검증. 도메인 업무, 화면, 파일 이관, 복원 등의 통과를 주장하지 않습니다. |
| Windows 설치·IME·배율·새 PC 복원·규모 | 미검증. 설치 파일과 릴리스는 아직 없습니다. |

이 체크포인트에는 공개용 설계·계획, 의존성 정의·lockfile, 합성 SQLite 검사와 최소 Electron 진단 코드만 포함합니다. 실행 기록·로컬 상태·인증정보·실제 학교 자료는 포함하지 않습니다. 의존성 설치에는 사용 중단 경고가 있었으며 전체 의존성 보안 검토 완료를 의미하지 않습니다.

## 개발 도구 검증

Node 24.x에서:

```sh
npm ci
npm run check:sqlite:node
npm run check:sqlite:electron
```

첫 설치 또는 Electron 실행 파일 준비에는 공식 패키지·바이너리 다운로드가 필요합니다. 위 검사는 임시 합성 DB에서 엔진 버전, PRAGMA, 실패 트랜잭션의 롤백, Online Backup의 데이터를 확인합니다. Electron 검사는 `ELECTRON_RUN_AS_NODE=1`을 사용하며 **창·렌더러·제품 저장 계층을 검증하지 않습니다**. 실제 제품의 오프라인 동작과 Windows 검증은 별도 완료 조건입니다.

전체 앱 실행·빌드·제품 테스트 명령은 구현과 검증이 끝난 단계부터 추가합니다. 현재 `npm start`나 설치 프로그램은 제공하지 않습니다.

디스플레이에 연결된 개발용 터미널에서는 다음 최소 진단을 실행할 수 있습니다.

```sh
node node_modules/electron/cli.js tests/support/electron-probe.cjs
```

이 진단은 임시 합성 데이터와 숨겨진 최소 창을 사용해 실제 실행 결과를 JSON으로 출력하며 제품 업무 화면이 아닙니다. 검증 당시 격리된 명령 실행 환경의 디스플레이/headless 시도는 실패했으나, 일반 Linux 데스크톱 터미널에서는 성공했습니다. 보안 sandbox를 비활성화하는 옵션은 사용하지 않았습니다. D-Bus 경고는 해당 성공 실행에서 비치명적이었습니다.
