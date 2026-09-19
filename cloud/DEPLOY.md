# Vercel + Supabase 운영

## 현재 상태

2026-09-19에 [tuk-overnight.vercel.app](https://tuk-overnight.vercel.app)로 프로덕션 배포했습니다.
Supabase `tuk-overnight`(서울 리전)와 제한 역할 연결, Nitro/Workflow 빌드, 라이브 상태 확인,
HTTPS → Vercel Workflow → Supabase의 즉시 취소 작업을 검증했습니다. 취소를 먼저 기록한
가짜 작업만 사용해 학교 로그인·신청 통신은 발생하지 않았고 테스트 행도 삭제했습니다.
별도의 합성 계정 로그인 1회가 학교 SSO의 정상적인 인증 거절 응답까지 도달해 Vercel 발신
연결도 확인했습니다. 이때 외박 내역 조회나 저장 요청은 호출하지 않았습니다.
이후 실제 학교 계정으로 로그인, 입주·학기·기존 신청 조회, 단건 저장, 저장 후 재조회와
Supabase 완료 기록까지 확인했습니다. 계정과 신청 날짜는 문서에 기록하지 않습니다.
신규 학교 포털 로그인은 `OVERNIGHT_PUBLIC_REGISTRATION=1`로 열려 있으며 동아리 내부 사용을 전제로 합니다.
기존 `service/data`의 계정·키·신청 기록은 이 구현에서 변경하거나 업로드하지 않습니다.
기존 Supabase `cbu-wiki` 프로젝트는 사용하지 않습니다.

DB URL·암호화 마스터 키·시범 연결 토큰은 Vercel Production Secret과 macOS Keychain의
`tuk-overnight/OVERNIGHT_DATABASE_URL`, `tuk-overnight/OVERNIGHT_MASTER_KEY`,
`tuk-overnight/OVERNIGHT_SETUP_TOKEN` 항목에 각각 보관합니다. Git이나 문서에는 값을 넣지 않습니다.

## 구성

- Vercel Node.js 24: 기존 웹 화면과 API. Supabase Auth를 별도로 도입하지 않고 학교 로그인
  성공 후 발급하는 기존 HttpOnly 세션을 재사용합니다.
- Supabase PostgreSQL: 암호화된 학교 계정, 세션 해시, 신청 결과, 계정별 실행 잠금과 요청 제한.
  서버 전용 `overnight_app` 역할로 transaction pooler에 연결하며 prepared statements는 끕니다.
- Vercel Workflow: 한 번에 한 날짜씩 처리합니다. Workflow 인자·반환값에는 작업 ID와
  제어 문자열만 넣습니다. 학교 계정·비밀번호·쿠키는 step 내부에서만 사용합니다.

`overnight_private`는 Data API에 노출하지 않습니다. anon/authenticated의 권한을 회수하고
RLS를 적용합니다. 이 RLS는 **서버 역할 경계**이며 사용자별 소유권은 API의 세션과
profile_id 조건으로 검사합니다. 프런트엔드에 Supabase 비밀 키를 넣을 필요가 없습니다.

## 배포 순서

1. 사용할 Supabase 조직과 무료 신규 프로젝트 생성 비용을 확인합니다. 다른 서비스의
   DB를 재사용하지 않고 서울 리전의 전용 프로젝트를 만듭니다.
2. 전용 프로젝트 관리자 권한으로 `supabase/migrations/20260919095949_init_cloud_schema.sql`을 실행합니다. `overnight_app`의 로그인
   비밀번호는 비밀 관리 도구에서 별도로 설정하고 SQL 파일·Git·대화에 기록하지 않습니다.
   운영 스키마를 변경할 때는 Supabase CLI의 `migration new`로 버전 관리하고 검증합니다.
3. Vercel 신규 프로젝트의 Root Directory를 `cloud`로 지정합니다. 루트 외부 소스 포함을
   켜서 `../service`와 `../extension/core.mjs`를 빌드에 포함합니다. CLI 배포는 저장소 루트에서
   실행합니다. `.vercelignore`는 필요한 소스만 허용하고 로컬 DB·키·환경변수·의존성은 제외합니다.
4. Node 24, Fluid Compute, `cloud/vercel.json`의 설치·빌드 명령을 사용합니다. Mac에서 만든
   prebuilt 산출물을 그대로 업로드하지 말고 Vercel Linux 빌더에서 소스로 빌드합니다.
5. 아래 환경변수를 Vercel의 **서버용 암호화 환경변수**로 설정합니다. `NEXT_PUBLIC_` 등의
   공개 접두사를 붙이지 않습니다. Preview는 별도 테스트 DB·키를 사용하거나 연결을 닫아 둡니다.

| 환경변수 | 값 |
| --- | --- |
| `OVERNIGHT_DATABASE_URL` | Supabase Connect 화면의 transaction pooler 주소. 사용자명은 `overnight_app.PROJECT_REF`, 포트는 6543 |
| `OVERNIGHT_MASTER_KEY` | Base64 32바이트 키. 키를 바꾸면 기존 계정을 읽을 수 없으므로 별도 안전한 백업 필수 |
| `OVERNIGHT_PUBLIC_ORIGIN` | 실제 서비스의 경로 없는 HTTPS 주소. 임의 Preview 도메인은 허용하지 않음 |
| `OVERNIGHT_PUBLIC_REGISTRATION` | 검증 전에는 `0`, 공개 가입을 허용할 때만 `1` |
| `OVERNIGHT_SETUP_TOKEN` | 비공개 시범 운영용 일회성 32자 이상 연결 토큰. 선택 사항 |
| `OVERNIGHT_DB_CA` | Supabase Database Settings에서 받은 공식 Root CA PEM. 현재 Node 런타임의 풀러 인증서 검증에 필요 |

6. `/api/health` 200과 UI 로딩, HTTPS 쿠키·다른 Origin 차단을 확인합니다. 시범 계정으로 학교
   로그인과 내역 조회를 먼저 확인합니다. 신규 신청은 날짜와 결과를 확인하며 별도로 검증합니다.
7. 학교의 자동화 허용 범위, 개인정보 처리 고지·보관 동의·문의처, DB 백업과 키의 분리 보관을
   준비한 뒤 공개 가입을 켭니다. 설정을 바꿨으면 새 배포에 반영됐는지 재검증합니다.

## 저장·중복·복구

신청은 DB에 기록한 뒤 큐에 넣습니다. 큐 전송 실패 시 기록을 삭제하지 않고 같은 작업 조회나
같은 UUID 재요청으로 재시도합니다. UUID가 같고 날짜가 다르면 409로 거부합니다.

학교에 저장하기 **전에** 해당 날짜를 `unknown`으로 기록합니다. 실행 중인 claim은 DB 행 잠금과
6분 임대로 독점합니다. 실행이 끊긴 claim은 이후 조회로만 확인하며 저장 요청을 다시 보내지
않습니다. 학교에 같은 기간이 확인되면 `exists`, 확인할 수 없으면 `unknown`으로 종료합니다.
새 UUID로 다시 신청하기 전에는 `unknown` 결과를 학교 신청 내역에서 확인해야 합니다.

빌드 후 `finalize-build.mjs`가 API·Workflow step·flow의 실행 상한을 300초로 고정하고
Node 24 및 큐 트리거를 검사합니다. 기본 SDK의 `maxDuration: max`를 그대로 두면 유료 플랜에서
임대보다 오래 실행될 수 있으므로 이 빌드 단계를 생략하면 안 됩니다.

일시적인 DB 장애는 SDK 재시도 이후에도 5분 간격으로 최대 12회 더 확인합니다. 이보다 긴 장애나
프로젝트 일시 중지는 DB 복구 후 사용자가 페이지를 열어 기존 작업을 조회하면 다시 확인합니다.
완전히 무인으로 무기한 재시도하는 서비스는 아닙니다. 취소는 현재 건의 확인 후 남은 날짜만
중단하며 이미 학교에 접수된 외박을 취소하지 않습니다.

학교 비밀번호가 바뀌었거나 다른 기기에서 접속할 때도 같은 로그인 화면을 사용합니다. 기존 계정이면
같은 프로필의 비밀번호와 세션을 갱신하므로 이전 브라우저는 로그아웃됩니다. 계정 삭제는 진행 중인 작업이 있으면 막고,
완료 후 암호문과 관련 기록을 함께 삭제합니다. 백업에 남은 사본의 보관 기간은 별도 운영 정책이 필요합니다.

퇴관일은 사용자 데이터로 저장하지 않고 `extension/core.mjs`의 학기별 공식 입주기간 표에서 제공합니다.
새 학기 모집 공지가 나오면 운영자가 학기·6개월·12개월 종료일을 갱신하고 테스트·재배포해야 하며,
일정이 없는 학기는 추정값으로 신청하지 않습니다.

## 검증

```sh
# 저장소 루트에서 기존 기능 회귀
npm run test:service

# 클라우드 실행기·HTTP·실제 PostgreSQL
# 반드시 운영 DB가 아닌 전용 테스트 DB 주소를 지정
CLOUD_TEST_DATABASE_URL=postgres://TEST_USER@127.0.0.1:TEST_PORT/postgres npm --prefix cloud test

# 실제 Workflow 실행 연결. 새 DB를 만들 수 있는 로컬 테스트 관리자만 사용
CLOUD_TEST_DATABASE_URL=postgres://TEST_USER@127.0.0.1:TEST_PORT/postgres npm --prefix cloud run test:workflow

# 배포 산출물·함수 실행 상한
npm --prefix cloud run build
npm --prefix cloud audit --omit=dev
```

SQL 테스트는 임의 이름의 격리 스키마와 테스트 역할을 만들고 자신이 만든 것만 정리합니다.
학교 통신 테스트는 가짜 응답만 사용합니다. 실제 학교 저장 요청은 테스트에 포함하지 않습니다.
Workflow 통합 테스트는 미리 취소한 작업으로 실제 큐/DB 연결을 확인하고 학교 통신을 차단합니다.
SDK 저장 기록에 가짜 계정·비밀번호·세션·키가 남지 않았는지도 확인합니다.
로컬 `npm run dev` 기본 포트는 8789입니다. 다른 포트를 지정하면 `PORT`도 같은 값으로
설정해야 Nitro 내부 프록시를 거친 요청의 원점 검사가 일치합니다.
`nanoid`·`undici`는 Workflow의 고정된 취약 버전을 피하기 위해 호환 패치 버전으로 override했으며,
SDK 업데이트 때 override 필요 여부와 전체 테스트를 다시 확인합니다.

## 무료 운영 범위와 남은 확인

현재 Vercel Hobby와 Supabase Free에서 시작했지만 무제한·무중단을 보장하지 않습니다. Vercel Hobby는
비상업적 개인 용도 조건을, Supabase Free는 DB 용량·트래픽·비활성 프로젝트 일시 중지와
백업 조건을 확인해야 합니다. 유료 전환·부가 기능은 자동으로 활성화하지 않습니다.
작업 기록은 계정 삭제까지 보관하므로 사용자 수가 증가하면 보관 기간과 DB 용량을 점검하세요.

Supabase 공식 CA의 현재 SHA-256 지문은
`80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`,
유효기간은 2031-04-26까지입니다. 인증서를 교체할 때는 Database Settings에서 다시 내려받아
지문과 라이브 `/api/health`를 확인한 뒤 재배포합니다.

- [Vercel Workflow](https://vercel.com/docs/workflows)
- [Vercel Hobby 조건](https://vercel.com/docs/plans/hobby)
- [Vercel 모노레포 배포](https://vercel.com/docs/monorepos)
- [Supabase 연결과 pooler](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [Supabase 요금제](https://supabase.com/pricing)
