# PDF NOTE COMPARE

문제 PDF와 해설 PDF를 아이패드에서 나란히 열어 보고 필기하는 웹앱입니다.
PDF는 서버에 업로드되지 않고 브라우저에서만 처리됩니다.

## 기능

- 문제/해설 PDF 2분할 보기
- 페이지, 확대/축소, 스크롤 동기화
- 펜, 형광펜, 지우개, 실행 취소, 현재 페이지 필기 삭제
- Apple Pencil과 손가락 필기 지원
- 필기를 브라우저 IndexedDB에 문서별/페이지별 자동 저장
- iPad 가로/세로 화면 및 홈 화면 전체화면 모드 대응

## Render 배포

이 저장소를 Render Blueprint로 배포하고 `Deploy Blueprint`를 누르면 됩니다.
환경 변수나 API 키는 필요하지 않습니다. 기존 서비스가 있다면 이 커밋을
푸시하는 것만으로 다시 배포됩니다.

## 로컬 실행

```bash
python -m venv .venv
```

Windows:

```bat
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python -m uvicorn app:app --reload --port 8000
```

macOS/Linux:

```bash
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m uvicorn app:app --reload --port 8000
```

브라우저에서 `http://127.0.0.1:8000`을 엽니다.

## iPad 사용 팁

Safari의 공유 버튼에서 **홈 화면에 추가**를 선택하면 주소 표시줄 없이 화면을
더 넓게 사용할 수 있습니다. 필기 모드에서는 화면 이동 대신 필기하며, 이동이
필요할 때는 보기 모드로 전환합니다.
