# 전국 5살 아이 나들이·공연·축제·신상 가이드 (GitHub Pages 배포용)

5살 아이와 함께 전국 어디든 가성비 좋게 떠날 수 있도록 **나들이·체험관, 어린이 공연·연극·뮤지컬, 겨울 빛축제·이벤트, 2025~2026 신상 오픈 시설**을 한눈에 필터링하고 매일 업데이트할 수 있는 정적 웹앱입니다.

## 폴더 구조

```text
kids-outing-guide/
├── index.html              # 메인 웹앱 진입점
├── README.md               # 배포 및 일일 업데이트 가이드
├── assets/
│   ├── styles.css          # 커스텀 스타일시트
│   ├── app.js              # 필터·차트·찜·일일 업데이트 로직
│   └── hero-banner.jpg     # 메인 히어로 일러스트 이미지
└── data/
    └── places.json         # 전국 34개 실존 장소·공연·축제·신상 데이터베이스
```

## GitHub Pages로 1분 만에 올리기

1. GitHub에서 새 저장소(Repository)를 생성합니다 (예: `kids-outing-guide`, Public 선택).
2. 이 폴더 안의 모든 파일(`index.html`, `README.md`, `assets/`, `data/`)을 저장소 최상단에 업로드(Push)합니다.
3. 저장소 상단 **Settings → Pages** 메뉴에서:
   - **Source:** `Deploy from a branch`
   - **Branch:** `main` / `/(root)` 선택 후 **Save** 클릭
4. 약 1~2분 뒤 `https://<본인계정>.github.io/kids-outing-guide/` 주소로 모바일·PC 어디서나 바로 접속할 수 있습니다.

## 매일 하루 한 번 업데이트하는 방법

1. 웹사이트 상단 **일일 업데이트** 탭에서 새 장소·공연·축제 정보를 폼으로 입력합니다.
2. **places.json 다운로드** 버튼을 눌러 최신 파일을 저장합니다.
3. GitHub 저장소의 `data/places.json` 파일을 새 파일로 교체(Commit)하면 약 1분 뒤 자동으로 반영됩니다.
