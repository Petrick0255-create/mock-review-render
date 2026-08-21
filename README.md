# MOCK REVIEW

HWP/HWPX/PDF 문제지와 해설을 문항별로 나누고 Gemini가 난이도, 추천 배점, 오류를 검수하는 웹앱입니다. MOCK NOTE의 카드형 관리 UI를 바탕으로 업로드 → 문항 검수 → 난이도 로드맵 흐름을 구성했습니다.

## 주요 기능

- 문제지 필수, 해설 선택 업로드(클릭 및 드래그 앤 드롭)
- `01번`부터 `25번`까지 문항 인식
- 1단/2단 문서 읽기 순서와 여러 페이지에 걸친 문항 처리
- 같은 번호의 문제·해설 자동 연결
- 문항별 원본 미리보기
- Gemini가 추출 텍스트와 문제·해설 문항 이미지를 동시에 참고
- H2Orestart의 HWP 5/HWPX 입력 필터로 실제 PDF를 만든 뒤 문항 이미지를 절단
- 변환 불가능한 손상·암호화 파일만 문항 텍스트 재조판 방식으로 대체
- Gemini `gemini-3.1-flash-lite` 구조화 분석
- 6단계 난이도, 추천 배점, 추정 정답, 오류와 수정안
- 전체 난이도 로드맵, 분포, 추천 총점, 고난도 연속 구간 경고

## Render 배포

1. 이 폴더 전체를 GitHub 저장소에 올립니다.
2. Render에서 **New + → Blueprint**를 선택하고 저장소를 연결합니다.
3. `render.yaml`이 Docker 웹 서비스를 구성합니다.
4. 환경변수 `GEMINI_API_KEY`에 Google AI Studio API 키를 입력합니다.
5. 배포가 끝나면 Render가 제공한 URL을 엽니다.

화면의 설정 버튼에서 API 키를 직접 입력할 수도 있습니다. “이 브라우저에 저장”을 켠 경우 키는 서버에 저장되지 않고 현재 브라우저의 localStorage에만 남습니다. 공용 PC에서는 저장하지 마세요.

## 로컬 실행

Docker가 설치된 경우:

```bash
docker build -t mock-review .
docker run --rm -p 10000:10000 -e GEMINI_API_KEY=YOUR_KEY mock-review
```

그 뒤 `http://localhost:10000`을 엽니다. HWP 변환 때문에 Docker 실행을 권장합니다.

Python으로 UI만 확인하려면:

```bash
python -m venv .venv
# Windows: .venv\Scripts\activate
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --reload --port 10000
```

로컬 PC에서 HWP/HWPX 원본 레이아웃 변환을 사용하려면 LibreOffice와 H2Orestart 확장이 모두 필요합니다. Docker 이미지에는 둘 다 포함되어 있습니다.

## 운영상 주의

- 업로드 파일은 `/tmp`에 저장되며 2시간 이후 정리됩니다.
- 무료 Render 인스턴스는 파일을 영구 저장하지 않으므로 분석 자료를 보관해야 한다면 이후 DB/Object Storage를 연결해야 합니다.
- 파일 하나당 최대 40MB입니다.
- 서버 메모리와 API 할당량을 보호하기 위해 Gemini 분석은 동시에 최대 2문항씩 실행합니다.
- 한컴 고유 개체, 수식, 글꼴은 LibreOffice 변환에서 원본과 다르게 보일 수 있습니다. 중요한 시험지는 변환 결과 미리보기를 확인하세요.

## API

- `GET /api/health`
- `POST /api/upload`
- `GET /api/jobs/{job_id}`
- `POST /api/jobs/{job_id}/analyze`
- `GET /api/jobs/{job_id}/assets/{name}`
