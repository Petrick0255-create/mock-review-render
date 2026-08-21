# PDF NOTE COMPARE

문제 PDF와 해설 PDF를 아이패드에서 나란히 열어 보고 필기하는 순수 정적
웹앱입니다. PDF는 서버에 업로드되지 않고 브라우저에서만 처리됩니다.

## 기능

- 문제/해설 PDF 2분할 보기
- 양쪽 PDF에서 01~25번 시작 위치 자동 탐색
- 현재 문항부터 다음 문항 직전까지 확대하여 이어 붙이기
- 1단/2단 문서 자동 판별 및 수동 지정
- 화면 좌상단 버튼이나 방향키로 이전/다음 문항 이동
- 페이지, 확대/축소, 스크롤 동기화
- 펜, 형광펜, 지우개, 실행 취소, 현재 페이지 필기 삭제
- Apple Pencil과 손가락 필기 지원
- 필기를 브라우저 IndexedDB에 문서별/페이지별 자동 저장
- iPad 가로/세로 화면 및 홈 화면 전체화면 모드 대응
- iPad 메모리 절약을 위한 Blob URL 로딩과 PDF 순차 분석
- iOS Safari 호환성을 위한 클래식 PDF.js 사용
- 문항 인식이 실패해도 Safari 내장 표시기로 여는 호환 모드

## 배포

서버와 API 키가 필요하지 않습니다. 저장소 전체를 GitHub에 올린 뒤 다음 중
하나로 배포하면 됩니다.

### Cloudflare Pages

- Framework preset: `None`
- Build command: 비워 둠
- Build output directory: `/`

### GitHub Pages

저장소 `Settings → Pages`에서 `Deploy from a branch`를 선택하고 배포할
브랜치의 `/ (root)`를 지정합니다.

### 로컬 확인

`index.html`을 직접 열기보다 간단한 로컬 서버를 사용하는 편이 안전합니다.

```bash
python -m http.server 8000
```

브라우저에서 `http://127.0.0.1:8000`을 엽니다.

## iPad 사용 팁

Safari의 공유 버튼에서 **홈 화면에 추가**를 선택하면 주소 표시줄 없이 화면을
더 넓게 사용할 수 있습니다. 필기 모드에서는 화면 이동 대신 필기하며, 이동이
필요할 때는 보기 모드로 전환합니다.
