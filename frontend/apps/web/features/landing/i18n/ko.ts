import { githubUrl } from "../components/shared";
import { createEnDict } from "./en";
import type { LandingDict } from "./types";

export function createKoDict(allowSignup: boolean): LandingDict {
  const base = createEnDict(allowSignup);

  return {
    ...base,
    header: {
      github: "GitHub",
      cta: "시작하기",
      dashboard: "대시보드",
      docs: "문서",
      changelog: "변경 로그",
      useCases: "사용 사례",
      navigation: "주요 메뉴",
      openMenu: "메뉴 열기",
      closeMenu: "메뉴 닫기",
    },
    footer: {
      tagline:
        "사람과 AI 에이전트가 함께 일하는 팀을 위한 프로젝트 관리 도구. 오픈소스이며, 원하는 곳에 직접 호스팅할 수 있습니다.",
      cta: "시작하기",
      groups: {
        product: {
          label: "제품",
          links: [
            { label: "기능", href: "#features" },
            { label: "작동 방식", href: "#how-it-works" },
            { label: "사용 사례", href: "/usecases" },
            { label: "변경 로그", href: "/changelog" },
            { label: "다운로드", href: "/download" },
          ],
        },
        resources: {
          label: "리소스",
          links: [
            { label: "문서", href: "/docs/ko" },
            { label: "API", href: githubUrl },
            { label: "X (Twitter)", href: "https://x.com/MultiremiAI" },
          ],
        },
        company: {
          label: "회사",
          links: [
            { label: "소개", href: "/about" },
            { label: "오픈소스", href: "#open-source" },
            { label: "영업팀 문의", href: "/contact-sales" },
            { label: "GitHub", href: githubUrl },
          ],
        },
      },
      copyright: "© {year} Multiremi. All rights reserved.",
    },
    changelog: {
      title: "변경 로그",
      subtitle: "Multiremi의 새로운 업데이트와 개선 사항입니다.",
      toc: "모든 릴리스",
      categories: {
        features: "새 기능",
        improvements: "개선 사항",
        fixes: "버그 수정",
      },
      entries: [
        {
          version: "0.3.17",
          date: "2026-06-05",
          title: "Feishu Bot 그룹 채팅, 사용량 스케줄링, CLI 업데이트",
          changes: [],
          features: [
            "Feishu Bot을 그룹에서 멘션하면 주변 대화가 함께 전달되어, 에이전트가 이전 논의를 더 잘 이해할 수 있습니다.",
            "관리자는 설정 화면으로 이동하지 않고 에이전트 연동 영역에서 바로 Feishu Bot 연결을 해제할 수 있습니다.",
            "셀프호스트 워크스페이스는 별도 cron 설정 없이도 사용량 집계를 계속 실행합니다.",
            "CLI에서 외부 MCP 설정 파일로 에이전트를 만들고 업데이트할 수 있습니다.",
          ],
          improvements: [
            "큰 이슈 설명과 긴 Markdown 초안이 에디터에서 훨씬 빠르게 열립니다.",
            "클라우드에서 컴퓨터를 추가하는 안내가 더 안정적이며, 연결할 수 없는 서버 설정을 저장하지 않습니다.",
            "페이지뷰 분석은 의미 있는 사이트 구간에 집중하고 URL 세부 차이로 생기는 노이즈를 줄입니다.",
            "셀프호스트 문서는 내장 사용량 스케줄러를 먼저 안내하고, 기존 cron 방식은 호환 경로로 남겼습니다.",
            "할당 워크플로가 배정된 에이전트의 정체성을 더 일관되게 유지합니다.",
            "이슈 댓글과 답글 입력창은 별도 펼치기 버튼 없이 입력에 맞춰 자동으로 커져 더 깔끔합니다.",
          ],
          fixes: [
            "이미지 업로드 후 커서가 올바른 위치에 남고, Markdown을 반복 편집해도 이미지 내용이 늘어나지 않습니다.",
            "셀프호스트 HTTP 환경에서도 코드 블록, 링크, 명령, 미리보기의 복사 버튼이 정상 동작합니다.",
            "에이전트 실행은 고정 시간이 아니라 오랫동안 활동이 없을 때만 시간 초과됩니다.",
            "Claude Code 사용자 설정은 자식 프로세스에 전달되고, 내부 세션 표식은 계속 분리됩니다.",
            "받은함 알림 음소거 확인과 데스크톱 알림 이동은 원래 워크스페이스 기준으로 처리됩니다.",
            "GitHub 설치 후 연결된 계정 이름이 바로 표시됩니다.",
            "모델 검색 대기 시간이 일관되고, 빈 결과 뒤에도 사용 가능한 선택지를 숨기지 않습니다.",
            "셀프호스트 Feishu 환경 변수를 올바르게 받습니다.",
          ],
        },
        {
          version: "0.3.16",
          date: "2026-06-04",
          title: "Lark Bot 연동",
          changes: [],
          features: [
            "Multiremi가 Lark 서드파티 연동을 지원해 QR 코드를 스캔하면 Multiremi 에이전트를 Lark Bot으로 만들 수 있습니다.",
            "채팅에 검색 가능한 에이전트 선택기와 명시적인 컨텍스트 선택기가 추가되어, 누가 응답할지와 무엇을 참고할지 더 쉽게 고를 수 있습니다.",
            "설명과 댓글에서 체크박스 작업 목록을 사용할 수 있어 이슈 안에서 간단한 계획을 정리하기 쉽습니다.",
            "에이전트에 Multiremi 기본 스킬이 포함되어 워크스페이스의 작업 흐름을 더 일관되게 따를 수 있습니다.",
          ],
          improvements: [
            "채팅 컨텍스트가 명확한 멘션으로 표시되어 인계와 나중 검토가 더 쉬워졌습니다.",
            "사용자 지정 메일 발송을 사용하는 팀을 위해 셀프호스트 메일 설정이 더 명확해졌습니다.",
            "사용 분석은 제품 신호에 더 집중하고 백그라운드 운영 활동 전송을 줄입니다.",
          ],
          fixes: [
            "비공개 스토리지의 첨부 파일을 빈 브라우저 탭 없이 안정적으로 다운로드할 수 있습니다.",
            "채팅 메시지를 빠르게 여러 개 보내도 모든 사용자 메시지가 에이전트에 전달됩니다.",
            "데스크톱은 로그인 만료를 명확히 보여 주며 시작 중에 멈춘 것처럼 보이지 않습니다.",
            "워크스페이스를 전환한 뒤 오래된 고정 항목이 사이드바에 남지 않습니다.",
            "재사용된 런타임은 스킬을 깨끗하게 새로고침해 중복 스킬 폴더가 쌓이지 않습니다.",
            "OpenCode 설정 확인이 일부 결과만 반환해도 사용할 수 있는 모델 선택지는 유지됩니다.",
            "댓글에서 시작된 에이전트 실행이 올바른 대화 스레드에 연결됩니다.",
            "CLI는 이슈 메타데이터가 없을 때 오류가 아니라 빈 결과로 처리합니다.",
          ],
        },
        {
          version: "0.3.15",
          date: "2026-06-03",
          title: "텍스트 하이라이트 + 더 안정적인 에이전트 실행",
          changes: [],
          features: [
            "설명과 댓글에서 텍스트를 하이라이트할 수 있어 중요한 내용을 더 쉽게 찾을 수 있습니다.",
          ],
          improvements: [
            "채팅 메시지 로딩이 더 빨라지고 긴 대화에서도 실시간 업데이트가 더 부드럽습니다.",
            "작업 실패 이유가 더 명확해져 팀이 문제를 더 빨리 파악하고 다시 진행할 수 있습니다.",
          ],
          fixes: [
            "이슈 시작일과 마감일이 시간대가 달라도 사용자가 선택한 날짜로 유지됩니다.",
            "같은 스킬 지원 파일이 중복되어도 스킬 준비가 실패하지 않습니다.",
            "OpenCode 모델 검색이 더 오래 기다려 설정 중 불필요한 실패가 줄었습니다.",
            "에디터 제안 메뉴는 포커스가 바깥으로 이동하면 안정적으로 닫힙니다.",
            "여러 서버가 동시에 시작되어도 시작 준비가 서로 겹쳐 문제 되는 일을 막습니다.",
          ],
        },
        {
          version: "0.3.14",
          date: "2026-06-02",
          title: "일본어 지원과 /skill command",
          changes: [],
          features: [
            "Multiremi가 앱, 사이트, 문서에서 일본어를 지원합니다.",
            "채팅에서 /skill command로 에이전트의 스킬을 선택할 수 있습니다.",
            "워크스페이스에 사용자 지정 로고를 표시할 수 있습니다.",
            "기존 스킬을 유지한 채 에이전트에 스킬을 추가할 수 있습니다.",
            "OpenCode 에이전트에서 thinking variant를 선택할 수 있습니다.",
          ],
          improvements: [
            "초기 온보딩에서 유입 경로 질문을 건너뛴 사용자도 나중에 짧은 안내로 답할 수 있습니다.",
            "사용 중지된 에이전트는 오프라인이나 작업 중처럼 보이지 않고, 모든 화면에서 Archived로 표시됩니다.",
            "채팅 기록과 이슈 실행 기록의 hover 작업이 더 깔끔해져 텍스트 잘림과 겹침이 줄었습니다.",
            "프로젝트 이슈의 agents-working 필터가 목록, 보드, 타임라인에서 일관되게 적용됩니다.",
          ],
          fixes: [
            "권한이 없는 사용자가 간접적인 이슈나 댓글 경로로 private 스쿼드 리더를 실행할 수 없게 했습니다.",
            "프로젝트 진행률 집계와 다시 시작된 에이전트 작업 상태가 더 안정적으로 새로고침됩니다.",
            "데스크톱과 웹에서 빈 워크스페이스 상태, 접근 불가 페이지, 화면 오류, 충돌 이후 더 잘 복구됩니다.",
            "이미지와 파일 카드 이름에 Markdown 문자가 있어도 올바르게 표시됩니다.",
            "실시간 연결이 다시 이어진 뒤 채팅, 라벨, 초대 데이터가 올바르게 새로고침됩니다.",
            "run-only 오토파일럿 작업, quick-create 작업, 그리고 재시도 작업을 Activity 화면에서 취소할 수 있습니다.",
            "여러 줄 스킬 설명이 가져오기 이후에도 올바르게 표시됩니다.",
            "Windows Copilot 실행에서 여러 줄 프롬프트가 유지되고, 따옴표가 있는 사용자 지정 인수도 더 잘 처리됩니다.",
          ],
        },
        {
          version: "0.3.13",
          date: "2026-06-01",
          title: "Skill 검색과 CLI 업데이트",
          changes: [],
          features: [
            "CLI에서 Skill을 검색하고 이슈에 연결된 pull request를 확인할 수 있어 릴리스 확인과 자동화 점검이 더 쉬워졌습니다.",
            "스쿼드 구성원의 역할을 CLI에서 바로 변경할 수 있습니다.",
            "에이전트 목록을 런타임 머신별로 필터링해 특정 기기나 로컬 서비스에 연결된 에이전트를 더 빨리 찾을 수 있습니다.",
            "메일 발송 설정에서 465번 포트의 보안 SMTP 연결을 사용할 수 있습니다.",
            "OpenCode 런타임이 에이전트에 저장된 MCP 설정을 사용할 수 있습니다.",
            "OpenCode 에이전트는 모델 variant를 thinking control로 표시하고 선택한 값을 런타임에 전달합니다.",
          ],
          improvements: [
            "모바일 이슈 상단의 조작 버튼이 더 정돈되어 작은 화면에서도 다루기 쉽습니다.",
            "채팅 기록의 실행 상태와 작업 버튼이 더 예측 가능하게 표시됩니다.",
            "같은 Skill을 다시 가져올 때 흐름을 끊지 않고 분명한 결과를 보여 줍니다.",
          ],
          fixes: [
            "댓글 답글이 사용자가 선택한 정확한 댓글 아래에 유지됩니다.",
            "Claude 작업이 프롬프트를 보내는 중 멈출 가능성이 줄었습니다.",
            "셀프 호스팅 로컬 런타임 설정 링크가 올바른 주소를 안내합니다.",
            "MCP 설정 안내와 런타임 지원 여부가 제품 동작과 맞게 표시됩니다.",
            "작업이 끝난 뒤 실행 로그의 활성 표시가 올바르게 정리됩니다.",
          ],
        },
        {
          version: "0.3.12",
          date: "2026-05-29",
          title: "이슈 세션 재개와 한국어 지원",
          changes: [],
          features: [
            "에이전트가 이슈 댓글에서 작업을 이어갈 때 새 세션을 만들지 않고 이전 세션을 재개해, 작업 맥락을 그대로 이어갑니다.",
            "Multiremi가 앱, 웹사이트, 문서에서 한국어를 지원하며, 전체 한국어 문서와 한국어 날짜 표시를 제공합니다.",
            "이슈 화면에서 작업 중인 에이전트를 제목 가까이에 고정해 보여 주고, 여러 에이전트가 동시에 일할 때도 더 쉽게 확인할 수 있습니다.",
            "에이전트가 이슈 대화를 읽을 때 스레드 미리보기, 답글 수, 최근 활동 시간을 먼저 확인해 필요한 맥락을 더 빨리 찾을 수 있습니다.",
            "OpenClaw 런타임은 에이전트에 저장된 MCP 설정을 사용할 수 있고, Claude Opus 4.8도 모델 선택과 사용량 추정에 반영됩니다.",
          ],
          improvements: [
            "이슈, 프로젝트, 런타임, 스킬, 에이전트, 스쿼드 상세 화면의 breadcrumb가 통일되어 위치와 이동 경로가 더 분명해졌습니다.",
            "재개된 에이전트 작업은 이미 읽은 댓글을 덜 반복해서 읽고, 트리거된 대화로 더 빠르게 돌아갑니다.",
            "이슈 언급 안내와 CLI 명령 표시가 더 읽기 쉬워져, 팀이 댓글과 설정 명령을 더 안전하게 다룰 수 있습니다.",
          ],
          fixes: [
            "에이전트를 수정, 보관, 복원하거나 템플릿에서 만든 뒤에도 연결된 스킬이 계속 올바르게 보입니다.",
            "하위 이슈를 완료한 같은 에이전트가 상위 이슈를 이어서 진행할 수 있습니다.",
            "Windows / WSL2 환경에서 현재 사용자의 로컬 런타임이 로컬 기기 아래로 더 정확히 묶입니다.",
            "CLI 로그인에서 Cloud Node 토큰을 사용할 수 있습니다.",
          ],
        },
        {
          version: "0.3.10",
          date: "2026-05-27",
          title: "로컬 작업 디렉터리",
          changes: [],
          features: [
            "이제 프로젝트가 데스크톱의 로컬 작업 디렉터리를 사용할 수 있습니다. 기존 폴더에서 바로 작업을 실행하고 디렉터리 대기 상태도 확인할 수 있습니다.",
            "오토파일럿 Webhook 트리거에서 작업을 시작하기 전에 이벤트와 액션을 필터링할 수 있고, 설정 화면에서 관련 문서로도 바로 이동할 수 있습니다.",
            "스윔레인 보기에 상위 이슈, 프로젝트, 담당자 기준 그룹화가 추가되어, 큰 보드도 팀이 계획하는 방식에 맞게 살펴볼 수 있습니다.",
          ],
          improvements: [
            "중국어 제품 문구와 공통 화면 접근성, React 코드가 정돈되었고, CLI 목록 출력과 스쿼드 목록 표시도 한층 읽기 편해졌습니다.",
          ],
          fixes: [
            "스윔레인, 하위 이슈 생성, 예약된 오토파일럿 제목, 댓글 편집, 코드 블록, 아바타 경로, 런타임 진단 관련 문제를 수정했습니다.",
          ],
        },
        {
          version: "0.3.9",
          date: "2026-05-26",
          title: "스윔레인과 더 예측 가능한 이슈",
          changes: [],
          features: [
            "이슈에 스윔레인 보기가 추가되어, 대형 프로젝트의 상위 작업과 상태 열을 함께 살펴볼 수 있습니다.",
            "이슈 목록이 드래그 앤 드롭 정렬, 고정 그룹 헤더, 추가 로드 후에도 일정한 순서 유지를 지원합니다.",
          ],
          improvements: [
            "CLI 상태 출력, 셀프 호스팅 사용량 안내, 에이전트 스킬 설정, 의존성 검사가 한층 분명해졌습니다.",
          ],
          fixes: [
            "GitHub PR 자동 종료 조건, 상위/하위 이슈 자동화, 이슈 스레드 순서, 보드 드래그 위치, 채팅 크기 조정 관련 문제를 수정했습니다.",
          ],
        },
        {
          version: "0.3.8",
          date: "2026-05-25",
          title: "iOS, Helm 셀프 호스팅, 더 매끄러운 협업",
          changes: [],
          features: [
            "처음으로 실제 사용 가능한 모바일 클라이언트인 Multiremi for iOS가 출시되어, 로그인·워크스페이스·인박스·이슈·프로젝트·채팅·댓글·실시간 업데이트를 모두 지원합니다.",
            "셀프 호스팅 팀은 이제 Helm 차트로 Kubernetes에 배포할 수 있고, Docker 설치 시 포트와 URL 설정도 한층 명확해졌습니다.",
            "프로젝트 리소스 선택기에 저장소 검색이 추가되었고, 런타임 사용량은 주요 모델 비용을 더 정확히 집계합니다.",
          ],
          improvements: [
            "스쿼드와 보드 카드, 데스크톱 탭 전환, 코드/리치 텍스트 표시, 저장소 설명 전달, 문서와 README가 개선되었습니다.",
          ],
          fixes: [
            "이슈 타임라인 순서, Codex와 Pi 실행 입력 처리, 로컬 런타임 삭제, 제목 새로고침, Markdown 코드 표시 문제를 수정했습니다.",
          ],
        },
        {
          version: "0.3.6",
          date: "2026-05-22",
          title: "더 똑똑한 환영 흐름과 실시간 작업 신호",
          changes: [],
          features: [
            "신규 사용자는 Multiremi Helper가 워크스페이스 소개, 둘러보기, 환영 페이지 만들기까지 함께 진행해 주는 새 온보딩 흐름을 경험하게 됩니다.",
            "이슈 목록에서 어떤 에이전트가 작업 중인지 표시되며, 세부 정보 보기와 \"작업 중\" 필터도 함께 제공됩니다.",
            "하위 이슈가 완료되면 상위 이슈에도 플랫폼 업데이트가 남고, 알맞은 담당자에게도 알림이 갑니다.",
          ],
          improvements: [
            "이슈 보드 카드, 이슈 생성 속성 바, 비밀 값 가시성, 워크스페이스 목록 로딩, Helper 안내가 개선되었습니다.",
          ],
          fixes: [
            "워크스페이스 컨텍스트 전달, 로컬 런타임 삭제 UI, Pi 응답 표시, SVG/파일 미리보기, 스쿼드 트리거 보호, 셀프 호스팅 기본값을 수정했습니다.",
          ],
        },
        {
          version: "0.3.5",
          date: "2026-05-21",
          title: "로컬 시간대 사용량과 이슈 Custom KV",
          changes: [],
          features: [
            "사용량 화면이 사용자의 표시 시간대를 반영해, 워크스페이스와 런타임 사용량을 사용자가 기대한 날짜 기준으로 보여 줍니다.",
            "이슈에 에이전트용 compact 상태를 함께 보관할 수 있게 되어, 자동화 진행 상태가 사이드바를 어지럽히지 않고 해당 작업 항목에 연결됩니다.",
            "긴 이슈 토론을 최신 답글부터 읽을 수 있게 되었고, 프로젝트 목록에는 compact/comfortable 레이아웃이 추가되었습니다.",
          ],
          improvements: [
            "CLI 워크스페이스 명령, 모델 선택기, 셀프 호스팅과 에이전트 문서, 예약 경로 보호, 런타임 메타데이터 지침이 정리되었습니다.",
          ],
          fixes: [
            "Codex 재시도, Claude Code 사용량 기록, 깨진 실시간 메시지 처리, 이슈 생성 버튼 안내, 런타임 작업 복구를 수정했습니다.",
          ],
        },
        {
          version: "0.3.4",
          date: "2026-05-20",
          title: "더 똑똑한 오토파일럿과 에이전트 제어",
          changes: [],
          features: [
            "오토파일럿이 스쿼드를 통해 새 작업을 할당하고, 생성된 이슈를 지정한 프로젝트에 바로 넣을 수 있습니다.",
            "에이전트 설정에 Claude와 Codex용 추론 제어가 추가되었고, 데스크톱 탭 고정과 사용자 프로필 기반 요청자 컨텍스트 기능도 함께 들어갔습니다.",
            "워크스페이스 설정에 GitHub 전용 페이지가 생겨, 일반 멤버도 연결된 설치 정보를 확인할 수 있습니다.",
          ],
          improvements: [
            "신규 사용자 런타임 연결, 런타임 페이지, 이슈 breadcrumb, HTML/첨부 미리보기, 스쿼드 보관 확인, 부모/하위 이슈 안내가 개선되었습니다.",
          ],
          fixes: [
            "리스트 편집, Homebrew 실패 시 설치 fallback, 실행 로그 재시도, 임시 task ID 처리, OpenCode 질문 프롬프트, Gemini 아이콘 문제를 수정했습니다.",
          ],
        },
        {
          version: "0.3.3",
          date: "2026-05-19",
          title: "프로젝트 타임라인과 더 명확한 이슈 작업",
          changes: [],
          features: [
            "프로젝트에 간트 보기가 추가되어 일정이 있는 작업을 계획 변경과 함께 확인할 수 있습니다.",
            "워크스페이스 관리자는 이슈 키 접두사를 바꿀 수 있고 CLI는 워크스페이스 전환과 현재 워크스페이스 표시를 지원합니다.",
            "에이전트는 최신 이슈 토론부터 읽을 수 있으며, 사용량 화면과 에이전트 상세 보드도 개선되었습니다.",
          ],
          improvements: [
            "온보딩 질문 흐름, 내 이슈의 스쿼드 작업 표시, 에이전트 실행 로그 정렬이 개선되었습니다.",
          ],
          fixes: [
            "데스크톱 HTML 미리보기, HTML 소스 보기, 이슈 생성 모드 전환, 런타임 작업 컨텍스트, 셀프 호스팅 세션 기간 설정을 수정했습니다.",
          ],
        },
        {
          version: "0.3.2",
          date: "2026-05-18",
          title: "Webhook 오토파일럿과 더 나은 작업 보드",
          changes: [],
          features: [
            "오토파일럿이 Webhook 이벤트로 시작되고 전달 기록 확인과 재실행을 지원합니다.",
            "이슈 보드는 담당자 그룹화, 연결된 Pull request 상태, 시작일 표시를 지원합니다.",
            "런타임 페이지의 machine view, 시간/작업 사용량 차트, 스킬 bulk 복사, HTML 미리보기가 추가되었습니다.",
          ],
          improvements: [
            "실패한 이슈 작업 오류, GitHub PR 상태 표시, 셀프 호스팅 기본값과 검색 결과 품질이 개선되었습니다.",
          ],
          fixes: [
            "오토파일럿 생성 이슈 반복, 런타임 기본 선택, 스쿼드 스크롤, 데스크톱 확대/축소, 인증/로컬 서비스 안정성을 수정했습니다.",
          ],
        },
        {
          version: "0.3.1",
          date: "2026-05-15",
          title: "빠른 탐색과 더 안정적인 스쿼드",
          changes: [],
          features: [
            "멤버와 에이전트 상세 페이지에서 관련 작업을 볼 수 있습니다.",
            "데스크톱 앱은 업데이트를 백그라운드에서 다운로드하고, 셀프 호스팅은 SMTP 이메일 전송을 지원합니다.",
            "스쿼드 생성 흐름의 멤버 선택이 팀 조율에 더 적합해졌습니다.",
          ],
          improvements: [
            "페이지 전환, 긴 이슈 활동 접기, Agents/Squads 목록 보기 기억, SSH 저장소 URL 처리, 스쿼드 handoff가 개선되었습니다.",
          ],
          fixes: [
            "셀프 호스팅 파일 카드, 로컬 도구와 스킬 탐색, Claude 사용량, 워크스페이스 전환 후 실시간 업데이트, 좁은 화면 메뉴를 수정했습니다.",
          ],
        },
        {
          version: "0.3.0",
          date: "2026-05-14",
          title: "스쿼드와 첨부 파일 미리보기",
          changes: [],
          features: [
            "스쿼드를 통해 작업을 그룹에 할당하고 리더 에이전트가 다음 단계를 조율할 수 있습니다.",
            "PDF, 오디오, 비디오, Markdown, 코드, 로그, 일반 텍스트 첨부 파일을 제자리에서 미리볼 수 있습니다.",
            "중국어 이름을 pinyin으로 검색할 수 있습니다.",
          ],
          improvements: [
            "스쿼드 페이지, quick create와 picker 검색, 사용량 차트, CLI 스쿼드 관리, 공유 인터페이스 라벨이 개선되었습니다.",
          ],
          fixes: [
            "스쿼드 리더 라우팅, 스쿼드 멘션, 이슈 목록 새로고침, 첨부 미리보기 문제를 수정했습니다.",
          ],
        },
        {
          version: "0.2.32",
          date: "2026-05-13",
          title: "사용량 인사이트와 채팅 이름 변경",
          changes: [],
          features: [
            "사용량 화면이 워크스페이스, 프로젝트, 런타임 추세, 에이전트 순위를 한곳에 보여줍니다.",
            "채팅 세션 이름을 채팅 헤더에서 바로 바꿀 수 있고 피드백에 스크린샷과 파일을 첨부할 수 있습니다.",
          ],
          improvements: [
            "사용량 페이지 명명, 새 채팅 업데이트, 셀프 호스팅 GitHub 설정, 사용자 설치 Codex 스킬 자동 사용이 개선되었습니다.",
          ],
          fixes: [
            "빈 성공 응답, instruction editor의 mention 링크, 데스크톱 첨부 다운로드, Gemini/Windows 런타임 시작, 긴 GitHub 저장소 목록을 수정했습니다.",
          ],
        },
        {
          version: "0.2.31",
          date: "2026-05-12",
          title: "GitHub 연동과 안전한 이슈 탐색",
          changes: [],
          features: [
            "GitHub를 연결해 연결된 Pull request를 Multiremi 이슈에 표시하고 상태를 동기화하며 PR 종료 시 이슈를 자동으로 닫을 수 있습니다.",
            "채팅 메시지 첨부 파일과 이미지 미리보기를 지원하고, 에이전트와 런타임 공개 범위를 설정할 수 있습니다.",
            "단일 에이전트 작업 중지 전에 확인을 요청하고 GitHub 연동 문서를 제공합니다.",
          ],
          improvements: [
            "이슈 링크 정확도, 긴 이슈 타임라인 스크롤, 피드백 GitHub 안내, 셀프 호스팅 Caddy 안내, Linux 앱 아이콘이 개선되었습니다.",
          ],
          fixes: [
            "첨부 파일명, 로컬 첨부 제공, 이슈 생성 대화상자 높이, 런타임 문서 링크를 수정했습니다.",
          ],
        },
        {
          version: "0.2.30",
          date: "2026-05-11",
          title: "Mermaid 이슈, 런타임별 시간대, 워크스페이스 나가기 처리",
          changes: [],
          features: [
            "이슈 설명에서 Mermaid 다이어그램을 렌더링하고 하위 이슈 행에 상태와 담당자 picker가 추가되었습니다.",
            "토큰 사용량 집계에 런타임별 시간대를 적용하고 private agent visibility와 멤버 제거 시 런타임 회수를 지원합니다.",
            "관리되지 않는 모델의 사용자 지정 토큰 가격과 랜딩 페이지 변경 로그 링크가 추가되었습니다.",
          ],
          improvements: [
            "데몬 self-healing, 채팅/댓글 전송 단축키, Copilot 모델 카탈로그, ACP 오류 메시지가 개선되었습니다.",
          ],
          fixes: [
            "최근 이슈 누수, 첨부 다운로드 URL, Windows 입력, 데몬 콘솔 팝업, Pi 도구 필터, 인박스 이동, 오토파일럿 CLI 모드 등을 수정했습니다.",
          ],
        },
        {
          version: "0.2.29",
          date: "2026-05-09",
          title: "Quick Create 프로젝트 선택과 댓글 해결",
          changes: [],
          features: [
            "Quick Create에서 프로젝트를 선택하고 마지막 선택을 기억합니다.",
            "댓글 스레드를 해결하고 접을 수 있으며, 이슈 live banner가 대기 중인 에이전트 작업을 보여줍니다.",
            "실패하거나 취소된 작업을 실행 로그에서 한 번에 다시 실행할 수 있습니다.",
          ],
          improvements: [
            "이슈 타임라인 렌더링, 대용량 paste 처리, 오토파일럿 오프라인 dispatch 방지, 인박스 자동 보관, Hermes 요청 전달이 개선되었습니다.",
          ],
          fixes: [
            "잔액 부족 run 상태, 이미지 문제 복구, Pi 모델 목록 파싱, Priority 색상, 긴 에이전트 메시지, 데스크톱 링크 복사 등을 수정했습니다.",
          ],
        },
        {
          version: "0.2.28",
          date: "2026-05-08",
          title: "데몬 디스크 사용량 CLI와 타임라인 개선",
          changes: [],
          features: [
            "`multimira daemon disk-usage`가 작업별, 워크스페이스별 디스크 사용량을 보여줍니다.",
            "에이전트 설정의 스킬 picker에 검색 상자가 추가되고 데몬 GC 범위가 채팅, 오토파일럿, quick-create 작업까지 확장되었습니다.",
            "이슈 상세 breadcrumb에 빠른 참조용 식별자가 표시됩니다.",
          ],
          improvements: [
            "타임라인 페이지 크기, 오래된/새로운 항목 보기, task_usage daily rollup, 데몬 health check, 런타임 통계가 개선되었습니다.",
          ],
          fixes: [
            "Linux 데몬 재시작, CLI short ID 라우팅, Windows 입력 파일 플래그, Electron 아이콘, orphaned reply, 타임라인 페이지네이션 예산을 수정했습니다.",
          ],
        },
        {
          version: "0.2.27",
          date: "2026-05-07",
          title: "더 매끄러운 채팅과 GitHub 스킬 가져오기",
          changes: [],
          features: [
            "GitHub 링크에서 재사용 가능한 스킬을 바로 가져올 수 있습니다.",
          ],
          improvements: [
            "채팅과 인박스, 이슈 작업 액션, 오토파일럿 반복 실패 감지가 더 매끄러워졌습니다.",
          ],
          fixes: [
            "중국어 입력, 데스크톱 업데이트, 긴 이슈 타임라인, live status 업데이트 안정성을 개선했습니다.",
          ],
        },
        {
          version: "0.2.26",
          date: "2026-05-06",
          title: "전체 i18n 적용과 시스템 알림 토글",
          changes: [],
          features: [
            "웹 앱이 간체 중국어로 완전히 번역되고 사용자별 로케일을 지원합니다.",
            "설정에 시스템 알림 토글, 채팅 세션 삭제, 인박스의 히스토리 패널, Redis 기반 런타임 liveness가 추가되었습니다.",
            "데스크톱은 런타임 셀프 호스트 설정을 로드하고 CLI는 명확한 대상 지정 플래그를 제공합니다.",
          ],
          improvements: [
            "설정 탭 이름과 URL 반영, 긴 이슈 타임라인, 런타임 poll/heartbeat 분리, Redis 기반 CLI 업데이트 요청, 사용량 쿼리 범위가 개선되었습니다.",
          ],
          fixes: [
            "서버 측 작업 삭제 시 데몬 취소, Codex auth refresh, ACP session resume, OpenCode skills 경로, 404 처리, sidebar pin, S3 URL, Windows installer 등을 수정했습니다.",
          ],
        },
        {
          version: "0.2.24",
          date: "2026-05-03",
          title: "Repo checkout --ref와 Hermes 재생 수정",
          changes: [],
          features: [
            "`multimira repo checkout --ref`가 브랜치, 태그, 특정 커밋을 대상으로 저장소를 가져올 수 있습니다.",
            "`multimira agent avatar`가 CLI에서 에이전트 아바타를 직접 업로드합니다.",
            "인박스 Done 작업에 보관 버튼이 추가되고 중복 mark-as-done hover 버튼은 제거되었습니다.",
          ],
          improvements: [
            "긴 타임라인 이슈 열기, multi-replica 모델 picker, 데몬 empty-claim cache TTL이 개선되었습니다.",
          ],
          fixes: [
            "새 에이전트 즉시 표시, Hermes 이전 답변 재생, Codex GPT-5.5 모델 표시, `multimira login --token`, CLI 업데이트 상태, session resume, Kanban 설정, 오토파일럿 반응형 등을 수정했습니다.",
          ],
        },
        {
          version: "0.2.21",
          date: "2026-04-30",
          title: "Quick Capture 개편과 Mermaid 다이어그램",
          changes: [],
          features: [
            "기존 새 이슈 대화상자가 Quick Capture로 바뀌어 연속 생성, 파일 업로드, 붙여넣은 URL 자동 보강을 지원합니다.",
            "Mermaid 다이어그램이 Markdown 안에서 렌더링되고 복잡한 그래프는 전체 화면 lightbox로 볼 수 있습니다.",
            "프로젝트별 저장소 바인딩과 권한 인식 UI가 추가되었습니다.",
          ],
          improvements: [
            "데몬 claim polling의 Redis fast-path와 Multiremi Agent 커밋의 Co-authored-by trailer, 데스크톱 reload 차단이 개선되었습니다.",
          ],
          fixes: [
            "Quick Create 요구사항 생성, 인박스 댓글 이동과 자동 보관, 작업 재실행 session, 초대 후 워크스페이스 이동을 수정했습니다.",
          ],
        },
        {
          version: "0.2.20",
          date: "2026-04-29",
          title: "에이전트로 이슈 만들기와 Presence v3",
          changes: [],
          features: [
            "`c`를 눌러 한 줄을 작성하고 에이전트를 선택하면 에이전트가 비동기로 이슈를 만들고 결과를 인박스에 남깁니다.",
            "Agent Presence v3가 availability와 last-task를 더 명확히 나누고 실행 로그를 이슈 패널에 표시합니다.",
            "데몬과 서버 heartbeat가 WebSocket으로 흐르며 task startup latency가 줄었습니다.",
          ],
          improvements: [
            "PAT/daemon token 캐시, agent CLI args env var, 수동/에이전트 이슈 생성 대화상자 공유가 개선되었습니다.",
          ],
          fixes: [
            "에이전트 이슈 생성 queue 정체와 중복 생성, 줄바꿈 렌더링, agent-authored mention loop, Windows Cursor multi-line prompt를 수정했습니다.",
          ],
        },
        {
          version: "0.2.19",
          date: "2026-04-28",
          title: "Kiro CLI 런타임과 데스크톱 알림",
          changes: [],
          features: [
            "Kiro CLI가 로컬 에이전트 런타임 옵션으로 추가되었습니다.",
            "macOS dock badge와 native notification이 추가되어 읽지 않은 이슈로 바로 이동할 수 있습니다.",
            "이슈 목록이 라벨 필터를 지원하고 데몬은 WebSocket으로 task wakeup을 받습니다.",
          ],
          improvements: [
            "리스트/보드 상태 그룹 헤더, Markdown 링크 보존, 라벨 optimistic attach, mention picker 검색이 개선되었습니다.",
          ],
          fixes: [
            "댓글 삭제 시 에이전트 작업 취소, stalled Codex timeout, Windows 데몬 종료, 에이전트 간 mention loop를 수정했습니다.",
          ],
        },
        {
          version: "0.2.18",
          date: "2026-04-27",
          title: "이슈 라벨과 Labs 탭",
          changes: [],
          features: [
            "이슈 라벨로 list, board, detail view에서 색상 분류와 필터링을 할 수 있습니다.",
            "실험 토글을 위한 Labs 설정 탭과 읽지 않은 워크스페이스 초대 표시 dot이 추가되었습니다.",
          ],
          improvements: [
            "프로젝트 picker 아이콘, detail page sidebar highlight, self-host signup gating env var 처리가 개선되었습니다.",
          ],
          fixes: [
            "에이전트 댓글 줄바꿈, Fedora의 Desktop RPM 충돌, Windows 에이전트 multi-line prompt 처리를 수정했습니다.",
          ],
        },
        {
          version: "0.2.17",
          date: "2026-04-26",
          title: "사용자 지정 에이전트 환경 변수와 더 나은 실패 메시지",
          changes: [],
          features: [
            "`multimira agent create/update --custom-env KEY=VALUE`가 에이전트 실행에 사용자 지정 환경 변수를 주입합니다.",
            "에이전트 실패 메시지에 런타임 CLI stderr tail이 포함되어 디버깅이 쉬워졌습니다.",
            "CLI 업데이트 다운로드 timeout을 설정할 수 있습니다.",
          ],
          improvements: [
            "데몬 cancelled 상태 보고와 agent status reconciliation, server heartbeat 분리와 slow-log가 개선되었습니다.",
          ],
          fixes: [
            "이슈 create/update의 assignee_id 검증, DeleteIssue ID 해석, Pi skills 경로, Windows console popup을 수정했습니다.",
          ],
        },
        {
          version: "0.2.16",
          date: "2026-04-25",
          title: "Chat V2와 이슈 우클릭 메뉴",
          changes: [],
          features: [
            "Chat V2, 이슈 우클릭 메뉴, 앱 내 피드백 흐름이 추가되었습니다.",
          ],
          improvements: [
            "채팅 사용성, 이슈 액션 접근성, 피드백 수집 흐름이 개선되었습니다.",
          ],
          fixes: [
            "채팅과 이슈 주변의 안정성 문제를 수정했습니다.",
          ],
        },
        {
          version: "0.2.15",
          date: "2026-04-24",
          title: "로컬 스킬, LaTeX, Focus Mode",
          changes: [],
          features: [
            "로컬 스킬, LaTeX 렌더링, Focus Mode, orphan task recovery가 추가되었습니다.",
          ],
          improvements: [
            "에이전트 작업 환경과 집중 작업 흐름이 개선되었습니다.",
          ],
          fixes: [
            "고아 작업 복구와 에디터 주변 안정성 문제를 수정했습니다.",
          ],
        },
        {
          version: "0.2.11",
          date: "2026-04-20",
          title: "크로스 플랫폼 데스크톱 패키징",
          changes: [],
          features: [
            "데스크톱 앱의 크로스 플랫폼 패키징, CLI self-update, 보드 페이지네이션이 추가되었습니다.",
          ],
          fixes: [
            "데스크톱 배포와 보드 로딩 안정성 문제를 수정했습니다.",
          ],
        },
        {
          version: "0.2.8",
          date: "2026-04-17",
          title: "에이전트별 모델과 Kimi 런타임",
          changes: [],
          features: [
            "에이전트별 모델 설정, Kimi 런타임, 셀프 호스트 인증 개선이 추가되었습니다.",
          ],
          fixes: [
            "모델 선택과 인증 흐름의 안정성 문제를 수정했습니다.",
          ],
        },
        {
          version: "0.2.7",
          date: "2026-04-16",
          title: "에디터 하위 이슈와 MCP",
          changes: [],
          features: [
            "에디터 선택 영역에서 하위 이슈를 만들고, 셀프 호스트 gating과 MCP 관련 기능을 사용할 수 있습니다.",
          ],
          fixes: [
            "하위 이슈 생성과 셀프 호스트 설정 주변 문제를 수정했습니다.",
          ],
        },
        {
          version: "0.2.5",
          date: "2026-04-14",
          title: "CLI 오토파일럿, Cmd+K, 데몬 identity",
          changes: [],
          features: [
            "CLI 오토파일럿 명령, Cmd+K 검색/명령 흐름, 데몬 identity 개선이 추가되었습니다.",
          ],
          fixes: [
            "명령 실행과 데몬 식별 주변 안정성 문제를 수정했습니다.",
          ],
        },
        {
          version: "0.2.1",
          date: "2026-04-10",
          title: "새 에이전트 런타임",
          changes: [],
          features: [
            "새 에이전트 런타임을 추가해 더 다양한 실행 환경을 지원합니다.",
          ],
          fixes: [
            "런타임 연결과 실행 안정성을 개선했습니다.",
          ],
        },
        {
          version: "0.2.0",
          date: "2026-04-09",
          title: "데스크톱 앱, 오토파일럿, 초대",
          changes: [],
          features: [
            "데스크톱 앱, 오토파일럿, 워크스페이스 초대 흐름이 추가되었습니다.",
          ],
          improvements: [
            "초기 제품 흐름과 런타임 연결 경험이 정리되었습니다.",
          ],
          fixes: [
            "데스크톱, 오토파일럿, 초대 기능의 초기 안정성 문제를 수정했습니다.",
          ],
        },
        {
          version: "0.1.33",
          date: "2026-04-07",
          title: "Gemini CLI와 에이전트 환경 변수",
          changes: [],
          features: [
            "Gemini CLI 지원과 에이전트 환경 변수 설정이 추가되었습니다.",
          ],
          improvements: [
            "에이전트 실행 설정 흐름이 더 유연해졌습니다.",
          ],
          fixes: [
            "CLI와 환경 변수 처리 주변 문제를 수정했습니다.",
          ],
        },
        {
          version: "0.1.28",
          date: "2026-04-02",
          title: "Windows 지원, 인증, 온보딩",
          changes: [],
          features: [
            "Windows 지원, 인증 흐름, 온보딩 경험이 추가되었습니다.",
          ],
          fixes: [
            "초기 Windows 실행과 로그인 안정성 문제를 수정했습니다.",
          ],
        },
        {
          version: "0.1.27",
          date: "2026-04-01",
          title: "원클릭 설정과 셀프 호스팅",
          changes: [],
          features: [
            "원클릭 설정, 셀프 호스팅 안내, 안정성 개선이 추가되었습니다.",
          ],
          improvements: [
            "초기 설치와 운영 경험이 더 단순해졌습니다.",
          ],
          fixes: [
            "설정과 배포 과정의 안정성 문제를 수정했습니다.",
          ],
        },
        {
          version: "0.1.24",
          date: "2026-03-29",
          title: "보안과 알림",
          changes: [],
          features: [
            "보안 기능과 알림 경험이 추가되었습니다.",
          ],
          improvements: [
            "팀 사용에 필요한 운영 안전성이 개선되었습니다.",
          ],
          fixes: [
            "알림과 접근 제어 주변 문제를 수정했습니다.",
          ],
        },
        {
          version: "0.1.23",
          date: "2026-03-28",
          title: "고정, Cmd+K, 프로젝트",
          changes: [],
          features: [
            "사이드바 고정, Cmd+K, 프로젝트 기능이 추가되었습니다.",
          ],
          fixes: [
            "프로젝트와 탐색 흐름의 초기 문제를 수정했습니다.",
          ],
        },
        {
          version: "0.1.22",
          date: "2026-03-27",
          title: "셀프 호스팅, ACP, 문서",
          changes: [],
          features: [
            "셀프 호스팅, ACP, 문서 관련 기능이 추가되었습니다.",
          ],
          improvements: [
            "설치와 운영 문서가 개선되었습니다.",
          ],
          fixes: [
            "셀프 호스팅과 문서 링크 주변 문제를 수정했습니다.",
          ],
        },
        {
          version: "0.1.21",
          date: "2026-03-26",
          title: "프로젝트, 검색, 모노레포",
          changes: [
            "프로젝트, 검색, 모노레포 지원을 추가했습니다.",
          ],
        },
        {
          version: "0.1.20",
          date: "2026-03-25",
          title: "하위 이슈, TanStack Query, 사용량 추적",
          changes: [
            "하위 이슈, TanStack Query 기반 데이터 흐름, 사용량 추적을 추가했습니다.",
          ],
        },
        {
          version: "0.1.18",
          date: "2026-03-23",
          title: "OAuth, OpenClaw, 이슈 로딩",
          changes: [
            "OAuth, OpenClaw 런타임, 이슈 로딩 개선을 추가했습니다.",
          ],
        },
        {
          version: "0.1.17",
          date: "2026-03-22",
          title: "댓글 페이지네이션과 CLI 정리",
          changes: [
            "댓글 페이지네이션과 CLI 사용성을 개선했습니다.",
          ],
        },
        {
          version: "0.1.15",
          date: "2026-03-20",
          title: "에디터 개편과 에이전트 생명주기",
          changes: [
            "에디터를 개편하고 에이전트 생명주기 관리를 개선했습니다.",
          ],
        },
        {
          version: "0.1.14",
          date: "2026-03-19",
          title: "멘션과 권한",
          changes: [
            "멘션과 권한 처리 흐름을 추가했습니다.",
          ],
        },
        {
          version: "0.1.13",
          date: "2026-03-18",
          title: "내 이슈와 i18n",
          changes: [
            "내 이슈 화면과 국제화 기반을 추가했습니다.",
          ],
        },
        {
          version: "0.1.3",
          date: "2026-03-08",
          title: "에이전트 지능",
          changes: [
            "에이전트 지능과 작업 처리 기반을 추가했습니다.",
          ],
        },
        {
          version: "0.1.2",
          date: "2026-03-07",
          title: "협업",
          changes: [
            "팀 협업을 위한 기본 흐름을 추가했습니다.",
          ],
        },
        {
          version: "0.1.1",
          date: "2026-03-06",
          title: "핵심 플랫폼",
          changes: [
            "Multiremi 핵심 플랫폼 기능을 추가했습니다.",
          ],
        },
        {
          version: "0.1.0",
          date: "2026-03-05",
          title: "기반 구축",
          changes: [
            "Multiremi의 초기 기반을 공개했습니다.",
          ],
        },
      ],
    },
  };
}
