# Windows 개발 인계

기준일: 2026-10-05

**클라우드 개발은 사용자 요청으로 중단했습니다. Windows에서 기존 설계를 이어서 구현하기 위한 소스 체크포인트이며, 완성 앱·설치 파일·릴리스가 아닙니다.**

저장소: [unono915/dot_test](https://github.com/unono915/dot_test), 인계 브랜치: `main`.
Windows Codex에 [일반 텍스트 프롬프트](WINDOWS_CODEX_PROMPT.txt)를 붙여 넣으면 됩니다. 이전 개발 환경의 목표·실행 상태나 인증정보를 복사할 필요가 없습니다.

## 1. 먼저 읽을 문서와 실제 파일

1. [제품 명세와 수용 기준 45개](specs/school-asset-desktop-review.md)
2. [승인된 구현 계획](plans/school-asset-desktop-implementation-plan.md)
3. [README의 실제 검사 결과와 한계](../README.md), 이 문서, `package.json`

요구사항 인터뷰나 전체 계획을 처음부터 반복하지 않습니다. 승인된 설계를 유지하고 실제 코드가 없는 다음 단계부터 진행합니다. 중요한 모순이나 변경 필요가 발견되면 해당 쟁점만 확인합니다.

현재 공개 파일은 다음 11개입니다.

```text
.gitignore
README.md
docs/WINDOWS_HANDOFF.md
docs/WINDOWS_CODEX_PROMPT.txt
docs/specs/school-asset-desktop-review.md
docs/plans/school-asset-desktop-implementation-plan.md
package.json
package-lock.json
scripts/check-electron-sqlite.cjs
tests/toolchain/sqlite-smoke.cjs
tests/support/electron-probe.cjs
```

`src/`, 업무 DB 스키마·명령, 실제 앱 화면, TypeScript/Vite/Vitest/Playwright 설정, 제품 시험, 빌드·패키징 설정은 아직 없습니다. 관련 패키지가 설치되었다고 해당 기능이 구현된 것은 아닙니다. 현재 npm 스크립트는 `check:sqlite:node`, `check:sqlite:electron` 두 개뿐입니다. `npm start`, `npm test`, 앱 빌드·타입 검사·lint 명령은 아직 제공하지 않습니다.

## 2. Windows 준비와 clone

목표 환경은 **실제 Windows 11 x64**입니다. WSL/Linux에서의 성공은 Windows 실행 증거로 대체하지 않습니다.

- Git은 [Git 공식 Windows 설치 페이지](https://git-scm.com/install/windows)의 x64 배포본을 사용합니다.
- Node.js는 [공식 다운로드](https://nodejs.org/en/download)에서 Windows x64용 **24.x LTS 중 `>=24.19.0 <25`를 만족하는 버전**을 선택합니다. 최신이라는 이유로 다른 major 버전을 선택하지 않습니다. 이 범위는 저장소의 `engines.node` 요구입니다.
- npm도 필요합니다. [npm 공식 설치 안내](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm/)에 따라 Node.js와 npm을 준비하고 실제 버전을 확인합니다. 기존 정상 설치를 우선 사용하며 전역 npm 업그레이드는 이 인계의 필수 단계가 아닙니다.
- 개발용 clone/의존성 다운로드에는 인터넷이 필요합니다. 완성 제품의 설치 후 오프라인 요구와 개발 도구 설치는 별개입니다. 설치·네트워크·권한 승인이 필요하면 먼저 사용자에게 요청합니다.

아래는 **Windows 명령 프롬프트(cmd.exe)** 기준입니다. 쓰기 가능한 로컬 개발 폴더에서 실행하고, 각 명령이 실패하면 다음 단계로 넘어가지 않습니다. 이미 clone한 작업 폴더를 덮어쓰지 않습니다.

```bat
git --version
node --version
npm --version
git clone https://github.com/unono915/dot_test.git
cd dot_test
git remote -v
git status --short --branch
git fetch origin
git log -1 --oneline origin/main
git switch -c work/windows-foundation origin/main
npm ci
npm run check:sqlite:node
npm run check:sqlite:electron
```

예시 브랜치가 이미 있으면 다른 고유 이름을 사용합니다. 기존 작업 폴더에서는 먼저 변경사항과 현재 브랜치를 확인하고, 사용자의 미커밋 작업을 보존한 뒤 원격 변경을 검토합니다. `reset --hard`나 강제 push로 맞추지 않습니다.

[`npm ci` 공식 동작](https://docs.npmjs.com/cli/v11/commands/npm-ci/)은 lockfile에 따른 설치이며 기존 `node_modules`는 교체됩니다. 따라서 개인 작업물을 그 안에 보관하지 않습니다. manifest와 lockfile이 불일치하면 오류 원인을 확인하고, lockfile 삭제·임의 버전 변경으로 우회하지 않습니다. Electron과 시험 도구를 포함한 개발 의존성도 설치해야 합니다.

네이티브 모듈 다운로드/빌드가 실패하면 Node/Electron 버전, OS/아키텍처, 실패 로그를 먼저 확인합니다. 추가 컴파일 도구가 실제로 필요한 경우 공식 출처와 변경 범위를 설명하고 승인받습니다. 사설 미러, 인증서 검증 해제, 관리자 실행이나 보안 정책 완화를 기본 해결책으로 삼지 않습니다. Linux의 `node_modules`나 인증 설정을 복사하지 않습니다.

### 선택: 실제 Electron 최소 진단

일반 Windows 데스크톱 터미널에서, `ELECTRON_RUN_AS_NODE`가 설정되지 않은 상태로 실행합니다.

```bat
node node_modules/electron/cli.js tests/support/electron-probe.cjs
```

숨겨진 최소 창과 임시 합성 SQLite를 사용합니다. 실제 업무 UI가 열리는 앱 실행 명령이 아닙니다. 종료 코드와 출력 JSON의 엔진 버전, PRAGMA, 한글 값, 백업 값, `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, 렌더러의 `process`/`require`가 `undefined`인지 확인합니다. 종료 코드 0만으로 제품 보안 전체가 검증되었다고 판정하지 않습니다. OS 임시 폴더에 진단 자료가 남을 수 있습니다.

## 3. 확인된 결과와 미완료 범위

다음은 **Linux에서 실제 확인한 결과**입니다. Windows에서 같은 명령을 새로 실행하고 결과를 별도로 기록해야 합니다.

| 검사 | 확인된 증거와 한계 |
|---|---|
| 고정 의존성 설치 | `npm install`로 406개 패키지 설치, 종료 코드 0. lockfile 포함. Windows `npm ci` 또는 새 clone의 설치 성공을 주장하지 않습니다. |
| Node SQLite 검사 | `npm run check:sqlite:node`: 1개 통과, 실패/건너뜀 0, 종료 코드 0. Node 24.19.0, better-sqlite3 13.0.3, SQLite 3.53.4. 인계 직전 재실행도 통과했습니다. |
| Electron Node 모드 검사 | `npm run check:sqlite:electron`: 1개 통과, 실패/건너뜀 0, 종료 코드 0. Electron 44.5.1, 내장 Node 24.21.0, SQLite 3.53.4. 인계 직전 재실행도 통과했습니다. |
| 위 두 SQLite 검사 내용 | 실제 네이티브 로딩, 엔진 버전/소스 ID, FK ON·trusted_schema OFF·WAL·synchronous FULL, 실패 트랜잭션 롤백, Online Backup의 합성 행과 `integrity_check=ok`. 제품 저장 계층은 아직 없습니다. |
| CJS 문법 | 위 목록의 CJS 파일 3개 각각 `node --check` 종료 코드 0. 타입 검사·lint·제품 빌드와는 다릅니다. |
| 일반 Linux 데스크톱의 Electron 진단 | 기존 실행 기록의 종료 코드 0과 JSON을 재확인했습니다. 실제 Electron의 한글 렌더러·SQLite 백업, sandbox/contextIsolation true, nodeIntegration false, 렌더러 process/require 미노출 확인. 전체 앱 GUI 시험은 아닙니다. |
| 격리 실행 환경의 GUI 시도 | 디스플레이 연결 실패 및 headless 렌더러 초기화 실패로 종료 코드 1. 일반 데스크톱 성공과 구분합니다. 보안 sandbox 비활성화로 우회하지 않았습니다. |
| 경고 | 설치 시 전이 의존성 사용 중단 경고, 검사 시 npm 환경 설정 경고가 있었습니다. 성공한 데스크톱 진단의 D-Bus 경고는 비치명적이었습니다. 전체 의존성 보안 검토 완료를 뜻하지 않습니다. |

**제품 수용 기준 AC-01~AC-45는 전부 미실행입니다.** 업무 기능·UI·이관·첨부·백업 번들·복원·성능·패키징은 미구현/미검증입니다. 도구 검사의 SQLite Online Backup 성공을 제품의 DB·첨부·설정 일관 백업 성공으로 바꾸어 해석하지 않습니다.

## 4. 바로 다음 구현 작업

**안전한 실제 Electron 앱 셸과 재현 가능한 시험 기반을 먼저 구현합니다.** 현재 진단 코드를 완성 앱으로 포장하지 않습니다.

1. 공개 명세의 보안·단일 인스턴스 요구를 실행 가능한 행동 시험으로 옮깁니다. 실제 Electron을 구동할 TypeScript/Vite/Vitest/Playwright 기반을 구성하고, 부정 출처 IPC와 탐색 차단 시험의 RED를 실제로 확인합니다.
2. 로컬 번들 전용 `app://bundle` 출처, 최소 한국어 창, 좁은 preload API를 만듭니다. sandbox/contextIsolation은 켜고 nodeIntegration은 끕니다. main에서 등록된 webContents·main-frame·정확한 출처 및 요청 스키마를 확인합니다.
3. 외부 탐색·새 창·자동 다운로드·불필요한 권한·네트워크 요청을 차단합니다. 렌더러에 원시 SQL·임의 경로·셸·전체 IPC API를 노출하지 않습니다. 데이터 경로와 단일 인스턴스 보호를 검증합니다.
4. 최소 구현 뒤 GREEN과 회귀 검사를 실행하고 실제 Windows Electron에서 네이티브 SQLite 로딩을 재확인합니다. 실행·빌드·타입·시험 스크립트는 해당 구현이 존재하고 작동할 때만 추가합니다. 기존 검사도 유지합니다.

첫 결과 보고에는 변경 파일, RED/GREEN 명령·종료 코드, 실제 Windows 실행 결과, 남은 실패를 포함합니다. 이 단계만으로 45개 수용 기준 또는 완성 제품을 통과 처리하지 않습니다.

## 5. 나머지 구현 순서

아래는 공개 구현 계획을 실행하기 위한 순서입니다. 범위를 축소하거나 전체 계획을 새로 작성하는 지시가 아닙니다. 각 단계는 시험 우선(RED → 최소 구현 → GREEN → 회귀)으로 진행합니다.

1. **앱·저장 공통 기반:** 안전한 셸 다음 업무 DB 스키마, 독립 세대 카탈로그, 데이터 루트 잠금·단일 writer, PRAGMA, 명령 ID/기대 버전/세대 epoch, 업무·감사·명령 결과·revision의 원자적 커밋, 취소·응답 유실·재시작 계약.
2. **기본 자산·사람·장소:** 개별 자산 ID, 공식 번호/serial, 계층·비활성화, 조회·상세 관계 ID와 같은 스냅샷의 버전. 재시작 후 공개 조회만으로 현재 관계를 다시 찾을 수 있어야 합니다.
3. **망·인터페이스·IP:** 비중첩 실제망/별칭, IPv4 범위·정책, 예약·활성·해제 대기·확인 근거·최종 해제·원자적 이전. 실제 점유 IP가 필요한 배정/반납 시험보다 먼저 구현합니다.
4. **전체 자산 업무:** 배정·일반 반납·이동·대여/반납·수리·분실 확인/회수·퇴역/폐기·이력 정정. 운영·담당·임시 점유·위치·물리 확인을 구분하고 IP와 감사 이력을 보존합니다.
5. **독립 관측·실사·미해결:** 관측 회차와 배정 분리, 실사 시작 기준 고정, 현재 장부와 비교, 종료 세션 보존, 후속 보정. 재시작 후 세션을 조회하고 미해결 원인으로 이동하는 흐름까지 구현합니다.
6. **검토형 XLSX 이관·출력:** 파일 접근 승인·내부 복사·제한 파싱, 매핑/안정키/원본 해시, 동일 원본 재이관 무변경, stale 검토 거절, 선택 묶음 전체 원자성, 출력 스냅샷·안전 문자열. 50,000행 응답성 기준을 통과한 뒤 후속 UI에 연결합니다. 과거 세대 출력은 지정한 세대만 사용합니다.
7. **첨부·백업·복원:** 불변 첨부, 쓰기 잠금/진행/취소, Online Backup과 manifest, 적대적 경로·해시·스키마·도메인 검사, 비활성 세대 준비/전환, 새 epoch, 강제 종료 복구, 이전 세대 열람/롤백, 사용 중 세대를 보호하는 정리.
8. **한국어 전체 UI 통합:** 공개 API 기반 업무 연결, 관계·세션·세대 재발견, 키보드/포커스/IME, 긴 한글, 빈 상태·오류·충돌·취소·반복 저장·응답 유실. 비공개 테스트 API로만 가능한 업무는 완성으로 인정하지 않습니다.
9. **Windows 품질·배포·인계:** 네이티브 모듈을 포함한 패키징, 일반 사용자 설치·재설치·제거와 데이터 보존, 오프라인·규모/성능, 라이선스 고지/도움말/합성 예제, 처음 이관부터 업무·인계·빈 새 PC 복원까지 통합 검증.

AC-01~AC-45의 원문·파일 상한·측정 조건은 공개 명세/계획을 그대로 유지합니다. 수용 기준마다 통과/실패/미실행과 증거를 기록합니다. 시험용 데이터는 유효한 합성 상태여야 하며, 미구현 handler를 가짜로 성공시키거나 시험을 건너뛰어 GREEN을 만들지 않습니다. 이후 실제 업무 명령으로 동일 흐름을 증명합니다.

## 6. 반드시 유지할 경계

- Windows 11 x64의 오프라인 단일 관리자 제품입니다. 스캔/자동 수집/교사 에이전트/웹 서버/다중 사용자/클라우드 동기화/자동 업데이트/원격 분석을 추가하지 않습니다.
- 실제 학교 자료·학생정보·비밀번호·인증정보·방문 기록을 사용하거나 게시하지 않습니다. 테스트는 합성 자료만 사용합니다.
- main이 SQLite와 최종 전이를 소유합니다. 감사나 결과 저장 실패도 업무 변경 전체를 롤백해야 합니다. 명령 ID·기대 버전·epoch를 우회하지 않습니다.
- `pending_release`는 계속 점유입니다. 퇴직·전원 꺼짐·실사 미발견·반납을 IP 해제 근거로 삼지 않습니다. 최종 해제/이전은 명세의 확인 근거와 원자성을 요구하며 실제 LAN 무충돌을 보장한다고 표현하지 않습니다.
- 관측은 배정을 덮어쓰지 않고 실사는 시작 기준을 바꾸지 않습니다. 실사 미발견을 자동 분실/폐기로 바꾸지 않습니다.
- 이관 검토는 DB를 쓰지 않습니다. 오래된 검토·안정키 없는 애매한 매칭·원본 재실행이 최근 수정을 덮어쓰지 못하게 합니다.
- 복원은 현재 자료를 바로 덮어쓰지 않습니다. 세대를 검증·전환하고 항상 새 epoch를 발급하여 이전 폼·작업·파일 승인을 무효화합니다.
- 성능을 이유로 원자성·보안·입력 상한을 약화하거나 일부 적용을 전체 성공으로 표시하지 않습니다.

## 7. Windows Codex와 목표 설정

사용자의 Windows Codex에서 설치 버전, 사용 가능한 모델과 추론 수준, 승인/샌드박스 설정을 실제로 확인합니다. **GPT-6-Astra와 Ultra가 해당 환경에서 제공되면 사용**하고, 확인되지 않으면 사용 중이라고 주장하거나 몰래 다른 모델로 바꾸지 말고 사용자에게 알립니다.

OMX/Ultragoal은 이 저장소의 npm 의존성이 아닙니다. Windows에 이미 설치되어 있는지, 설치 버전의 공식 도움말·스킬과 실제 목표 기능이 작동하는지 먼저 확인합니다. 가능할 때만 공개 명세·이 문서의 남은 작업을 바탕으로 **새 Windows 목표**를 만듭니다. clone으로 이전 환경의 활성 목표·진행 상태가 이어진다고 가정하지 않습니다.

없거나 동작하지 않으면 사실대로 보고하고 일반 단계별 TDD로 진행할지, 별도 설치 승인을 받을지 확인합니다. 런타임·잠금/식별자·개인 설정·인증정보를 옮기거나 지원되지 않는 목표 기능을 흉내 내지 않습니다. 자동 설치, 승인 우회, sandbox 해제, 신뢰/권한의 묵시적 확장은 금지합니다.

## 8. Windows에서의 필수 완료 증거와 게시

실제 Windows 네이티브 모듈/렌더러 실행, 한글 IME 조합 중 Enter·키보드·배율, 일반 계정 설치/재설치/제거·데이터 보존, 패키지 내 addon, 설치 후 오프라인 전 업무, 강제 종료/복구, 새 PC 복원은 모두 남아 있습니다. Linux·WSL·크로스 빌드 결과를 그 대신으로 표시하지 않습니다. 성능은 공개 명세의 PC/자료 규모와 반복 횟수로 측정합니다.

검증한 작은 단위로 **같은 저장소 `https://github.com/unono915/dot_test.git`**에 commit/push합니다. cloud 구현은 중단되었지만 사용자나 다른 작업의 변경 가능성은 있으므로 별도 feature branch를 권장합니다. 게시 직전 `git fetch origin`, 원격 주소·현재 head·차이·stage된 전체 diff를 확인하고 사용자의 변경을 보존합니다. 명시적으로 검토한 파일만 stage하며 강제 push를 하지 않습니다. push 후 원격 SHA를 다시 확인하고 보고합니다. `main` 통합은 원격 변경과 검증 결과를 검토한 뒤 수행합니다.

런타임 상태·내부 지시/개인 프롬프트·인증/기계 설정·로그·node_modules·캐시·빌드 결과·실제 DB/학교 자료는 게시하지 않습니다. 이 저장소의 공개 인계 프롬프트는 제품 개발 요청만 담은 별도 문서입니다. 각 보고는 구현된 부분, 정확한 검사 결과, 실패/미실행, 다음 작업을 구분하며 **소스 체크포인트와 사용 가능한 앱/설치 프로그램을 혼동하지 않습니다.**
