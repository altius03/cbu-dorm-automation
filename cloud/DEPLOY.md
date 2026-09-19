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

신청은 하나의 Vercel 요청에서 최대 4분 동안 처리합니다. 학교에 저장하기 직전 결과를 `unknown`으로
기록하며, 완료가 확인된 경우에만 `saved`로 바꿉니다. 실행이 강제 종료되어 6분 이상 `running`인
작업은 조회 시 `interrupted`로 전환합니다. 이때 저장 요청을 자동 재전송하지 않으며 사용자가
`학교 내역으로 결과 다시 확인`을 눌러 읽기 전용으로 대조합니다.

학교 신청의 백그라운드 실행은 비밀번호를 저장해야만 가능하므로 사용하지 않습니다. 긴 신청은 가능한
날짜를 최대 7박 8일의 연속 기간으로 묶어 요청 수를 줄입니다. 선택 범위는 오늘 포함 31일로 제한하고
브라우저와 서버에서 각각 검증합니다. 계정과 무관한 공휴일 동기화만 별도 Cron 요청으로 실행합니다.

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

## 배포 순서

1. Supabase 마이그레이션을 파일명 순으로 적용합니다.
2. Vercel 프로젝트 Root Directory를 `cloud`로 두고 루트 외부 소스 포함을 켭니다.
3. Node 24와 `cloud/vercel.json`의 설치·빌드 명령을 사용해 소스에서 빌드합니다.
4. `/api/health` 200, 로그인 화면, HTTPS 쿠키, 다른 Origin 차단을 확인합니다.
5. 학교 로그인과 신청내역 조회를 먼저 확인하고, 실제 신청 검증은 날짜를 직접 확인한 뒤 수행합니다.

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
