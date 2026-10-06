# Vercel + Supabase 운영

## 구성

- Vercel Node.js 24: 웹 화면, 학교 포탈 로그인·조회·신청 API
- Supabase PostgreSQL: 계정 HMAC, HttpOnly 세션 해시, 신청 결과, 실행 잠금과 요청 제한
- 학교 포탈 아이디·비밀번호: DB·로그·쿠키·브라우저 저장소에 저장하지 않고 현재 페이지의 메모리와
  현재 API 요청에서만 사용

`overnight_private` 스키마는 Data API에 노출하지 않습니다. `anon`과 `authenticated` 권한을
회수하고 RLS를 강제하며, 서버 전용 `overnight_app` 역할만 transaction pooler로 연결합니다.

## 처리와 복구

로그인 성공 후 서버는 학번으로 만든 HMAC을 기존 프로필과 대조합니다. 비밀번호는 학교 SSO 검증과
현재 요청에만 쓰고 저장하지 않습니다. 새로고침·브라우저 재실행 뒤에는 다시 로그인해야 합니다.
보호 API는 세션 쿠키와 현재 페이지의 메모리에만 있는 증명값을 함께 확인합니다. 세션 쿠키는 학교 로그인 후
8시간이 지나면 서버에서도 만료됩니다.

신청은 하나의 Vercel 요청에서 최대 4분 동안 처리합니다. 학교에 저장하기 직전 결과를 `unknown`으로
기록하며, 완료가 확인된 경우에만 `saved`로 바꿉니다. 실행이 강제 종료되어 6분 이상 `running`인
작업은 조회 시 `interrupted`로 전환합니다. 이때 저장 요청을 자동 재전송하지 않으며 사용자가
`학교 내역으로 결과 다시 확인`을 눌러 읽기 전용으로 대조합니다.

학교 신청의 백그라운드 실행은 비밀번호를 저장해야만 가능하므로 사용하지 않습니다. 긴 신청은 가능한
날짜를 최대 7박 8일의 연속 기간으로 묶어 요청 수를 줄입니다. 선택 범위는 오늘 포함 31일로 제한하고
브라우저와 서버에서 각각 검증합니다. 운영 Cron은 상태 검사, 공휴일 동기화와 리포트 발송을 처리합니다.

## 환경변수

Vercel Production Secret에만 저장하고 공개 접두사를 붙이지 않습니다.

| 환경변수 | 값 |
| --- | --- |
| `OVERNIGHT_DATABASE_URL` | Supabase transaction pooler 주소. `overnight_app.PROJECT_REF`, 포트 6543 |
| `OVERNIGHT_MASTER_KEY` | Base64 32바이트 서버 키. 계정 HMAC·세션 보호에 사용하며 변경 금지 |
| `OVERNIGHT_PUBLIC_ORIGIN` | 경로 없는 실제 HTTPS 서비스 주소 |
| `OVERNIGHT_PUBLIC_REGISTRATION` | 동아리 사용자 로그인을 받을 때 `1` |
| `OVERNIGHT_SETUP_TOKEN` | 공개 가입이 꺼진 경우에만 쓰는 32자 이상 일회용 토큰, 선택 사항 |
| `OVERNIGHT_DB_CA` | Supabase Database Settings의 공식 Root CA PEM |
| `DATA_GO_KR_SERVICE_KEY` | 공공데이터포털 `한국천문연구원_특일 정보` 일반 인증키 |
| `CRON_SECRET` | Vercel이 Cron 요청의 Bearer 인증에 사용하는 32자 이상 무작위 Secret |
| `OVERNIGHT_SLACK_BOT_TOKEN` | 전용 Slack 앱의 Bot User OAuth Token. Production의 민감한 환경변수로 저장 |
| `OVERNIGHT_SLACK_USER_ID` | 운영 리포트를 받을 관리자 Slack 사용자 ID |

## 배포 순서

1. Supabase 마이그레이션을 파일명 순으로 적용합니다.
2. Vercel 프로젝트 Root Directory를 `cloud`로 두고 루트 외부 소스 포함을 켭니다.
3. Node 24와 `cloud/vercel.json`의 설치·빌드 명령을 사용해 소스에서 빌드합니다.
4. `/api/health` 200, 로그인 화면, HTTPS 쿠키, 다른 Origin 차단을 확인합니다.
5. 학교 로그인과 신청내역 조회를 먼저 확인하고, 실제 신청 검증은 날짜를 직접 확인한 뒤 수행합니다.

`/api/health`는 DB 연결과 읽기 전용 여부를 검사하며 결과를 최대 30초간 재사용합니다.

## 무료 운영 점검과 일일 리포트

`cloud/vercel.json`에는 각기 하루 한 번 실행되는 상태 검사 네 개, 공휴일 동기화 하나,
일일 리포트 하나를 정의합니다. 모든 운영 API는 `CRON_SECRET` Bearer 인증이 필요합니다.

| 작업 | 한국시간 | API |
| --- | --- | --- |
| 상태 검사 | 03시대, 09시대, 15시대, 21시대 | `/api/cron/health` |
| 공휴일 동기화 | 03시대 | `/api/cron/holidays` |
| 일일 Slack DM | 자정 이후 00시대에 한 번 | `/api/cron/report` |

상태 검사는 운영 기록을 DB에 쓰고 배포된 홈페이지와 `/api/health` 응답을 확인합니다.
이를 통해 실제 DB 활동을 만들고 읽기와 쓰기, 웹 응답을 점검합니다. 날짜별 로그인과 운영
기록은 90일 보관하고, 만료된 요청 제한과 잠금도 정기적으로 정리합니다. 학교 신청은 실행하지 않습니다.

Supabase Free의 비활성 중단을 줄이기 위한 구성입니다. 과금 한도, 용량 초과나 플랫폼 장애까지
방지하는 구성은 아닙니다. Vercel의 실행 지연과 누락 가능성이 있으므로 독립적인 장애 알림이 필요하면
cron-job.org 같은 무료 외부 검사에서 `/api/health`를 조회하도록 추가할 수 있습니다.

리포트는 전날 한국시간 00:00~24:00을 집계합니다. 사용자와 신청 결과, 서비스 상태와 정기 작업을
각각 두 열로 표시하고 맨 위에 확인할 문제를 요약합니다. 가운데점은 사용하지 않습니다.

- 사용자: 로그인에 성공한 고유 계정 수. 같은 날 반복 로그인은 한 번만 세고 상태 검사 트래픽은 제외합니다.
  신규와 누적은 현재 저장된 프로필의 생성일 기준이며, 삭제된 계정은 포함하지 않습니다. 집계를 시작하기
  전 사용자 수는 `미집계`로 표시하고 첫날 부분 수집과 전일 비교 불가도 표시합니다.
- 신청: 전날 생성된 작업의 실행 횟수와 발송 시점의 완료, 부분 처리, 실패, 중단, 처리 중 상태.
  결과는 연속 날짜를 묶은 신청 **기간 수**입니다. `saved`는 접수 완료, `exists`와 `overlap`은 기존 신청 제외,
  `unknown`은 확인 필요, `not_attempted`는 미처리입니다. 접수 완료는 학교 승인과 별개입니다.
- 서비스: 발송 시점의 웹과 DB 응답, 상태 검사 응답 시간, DB 용량과 500MB 대비 사용률.
- 정기 작업: 최근 24시간 상태 검사 결과, 공휴일 갱신 결과와 마지막 성공, 직전 리포트 전송 상태.
  재시도 후 복구된 오류는 정기 작업 결과에 표시합니다.

일일 리포트는 날짜별 DB 기록과 분산 잠금으로 중복을 막습니다. 전송 전 준비가 실패하거나 Slack이
명시적으로 거절하면 같은 Cron 실행 안에서 최대 세 번 준비를 재시도합니다. 메시지를 전송하기 전에
DB에 발송 예약을 기록합니다. 메시지 전송 뒤 타임아웃, 응답 불명확 또는 완료 기록 실패가 발생하면
`unknown`으로 유지하고 자동 재전송하지 않습니다. DB에 예약을 남길 수 없으면 발송을 보류합니다.
이는 중복 없는 발송을 우선하는 정책이며, 장애 시 누락될 수 있습니다.

Slack 앱은 `cloud/slack-app-manifest.json`으로 생성하고 씨부엉 워크스페이스에 설치합니다.
권한은 `chat:write`와 `im:write` 두 개입니다. Bot 토큰과 관리자 ID를 위 환경변수에 설정한 후
재배포합니다. 토큰은 Git, 로그, 클라이언트 코드에 넣지 않습니다. 첫 실제 리포트 확인 후 같은 날짜의
Cron을 다시 호출해 `skipped: true`가 반환되고 DM이 추가되지 않는지 확인합니다.

## 공휴일 동기화

`cloud/vercel.json`은 매일 UTC 18시(한국시간 다음 날 03시대)에 `/api/cron/holidays`를 호출합니다.
현재 연도와 다음 연도의 공휴일을 공공데이터포털에서 연도별 1회씩 읽어
`overnight_private.public_holidays`에 한 트랜잭션으로 교체합니다. 두 연도 중 하나라도 조회에 실패하면
기존 데이터는 유지됩니다. Vercel Hobby에서는 지정한 한 시간 안에서 실행 시각이 달라질 수 있습니다.

1. 공공데이터포털에서 `한국천문연구원_특일 정보` 활용신청을 완료합니다.
2. 일반 인증키를 `DATA_GO_KR_SERVICE_KEY` Production Secret에 저장합니다.
3. `CRON_SECRET`을 32자 이상의 무작위 Production Secret으로 저장합니다.
4. 배포 후 인증된 Cron을 한 번 실행하고 `public_holidays` 행과 달력 표시를 확인합니다.

공휴일은 `평일 전체` 자동 선택에서만 제외합니다. `매일`, `지정 요일`, 달력 직접 선택은 사용자가
공휴일 외박을 의도할 수 있으므로 그대로 허용하며, 금·토·일 주말 규칙도 바꾸지 않습니다.

기존 암호문 컬럼을 제거하는 배포는 다음 순서를 지킵니다.

1. `20260919142047_allow_passwordless_profiles.sql` 적용
2. 비밀번호를 읽거나 쓰지 않는 애플리케이션 배포 및 상태 확인
3. 실행 중 작업이 없음을 확인
4. `20260919142049_drop_stored_credentials.sql` 적용
5. `information_schema.columns`에서 `credential_ciphertext`가 없음을 확인

## 검증

```sh
npm ci --prefix cloud --ignore-scripts
npm test
npm run build

# 운영 DB가 아닌 일회용 PostgreSQL에서만 실행
CLOUD_TEST_DATABASE_URL=postgres://TEST_USER@127.0.0.1:TEST_PORT/postgres npm --prefix cloud test
```

요청 로그에는 URL, 본문, 쿠키, 학교 응답과 예외 원문을 남기지 않습니다. API 종류, 상태 코드,
전체 시간과 단계별 시간만 기록합니다.

Vercel Hobby와 Supabase Free로 시작할 수 있지만 무제한·무중단은 보장되지 않습니다. 사용자 수가
늘면 함수 실행 시간, DB 용량, 비활성 프로젝트 일시 중지와 작업 기록 보관 기간을 점검합니다.
