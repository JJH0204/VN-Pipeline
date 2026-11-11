# VN Studio — 설계 명세 (구현 계약서)

VN-Pipeline(로컬 ComfyUI 기반 연애시뮬/비주얼노벨 에셋 생성기)을 **GUI로 실행·관리**하는 로컬 웹앱.
사용자는 한국인 1인 게임 개발자. Python CLI가 불편해서 GUI를 원함. **모든 UI 문구는 한국어**.
모델·LoRA를 사용자가 직접 설정할 수 있어야 하고, **설명(도움말)이 충분히** 있어야 함.

## 0. 실행 환경 (중요)

- 프로젝트 루트: `/Volumes/T7/VN-Pipeline` (외장 SSD, APFS)
- Python: **엔진 Python** `/Volumes/T7/ComfyUI/Installs/ComfyUI/standalone-env/bin/python` (3.13)
  - 사용 가능: `aiohttp 3.13`, `Pillow 12`, `yaml`, `numpy 2.4`, `onnxruntime 1.31`(태거용, 2026-11-08 설치), 표준 라이브러리. **그 밖의 pip 설치 금지**(엔진 환경 오염).
- macOS (Apple M4 Pro 24GB). 브라우저: Google Chrome, Safari 설치됨.
- ComfyUI: `http://127.0.0.1:8188` (현재 실행 중일 수 있음). 실행 스크립트: `/Volumes/T7/VN-Pipeline/start.sh`
- 생성은 느림: 기본 품질 1장 ≈ 4~5분, `hires/face/hands` 끄면 ≈ 1.5~2분. 스프라이트 세트 ≈ 12분.
  → UI는 **긴 대기를 전제**로 설계: 큐, 진행 단계 표시, 실시간 미리보기, 완료 알림.
- 외부 CDN/네트워크 의존 금지 (오프라인 동작). 프런트엔드는 빌드 도구 없는 **순수 HTML/CSS/JS(ES modules)**.

## 1. 파일 구조와 담당

```
VN-Pipeline/
  vn.py                    # CLI (완성됨, 수정 금지)
  vnlib/                   # 공용 라이브러리 (완성됨, 수정 금지 — 버그 발견 시 보고만)
    config.py  characters.py  graphs.py  modelinfo.py  comfy.py
  config/                  # presets.json, settings.json, loras.json (vnlib가 자동 생성/관리)
  characters/<id>.json     # 캐릭터 (예: haru.json)
  output/                  # ComfyUI 출력 (prompt/, <charId>/{concept,sprite,cg}/, backgrounds/)
  user/                    # 런타임 데이터 (server.log 등). studio 데이터는 user/studio/ 아래
  studio/
    server.py              # [백엔드 담당] aiohttp 서버 진입점
    *.py                   # [백엔드 담당] 필요시 모듈 분리 (comfy_link.py, jobs.py, gallery.py 등)
    web/                   # [프런트 담당] index.html, css/, js/
    web/help/              # [도움말 담당] 가이드 HTML 조각 + tips.json
  studio.sh                # [런처 담당]
  scripts/make_app.sh      # [런처 담당] → "VN Studio.app" 생성
```

## 2. vnlib API (이미 구현됨 — 그대로 import해서 사용)

서버에서 `sys.path.insert(0, ROOT)` 후 `from vnlib import config, characters, graphs, modelinfo`.

- `config.ROOT, CONFIG_DIR, CHAR_DIR, OUTPUT_DIR, USER_DIR, ENGINE_DIR, ENGINE_PYTHON, SIZES`
  - `SIZES = {"portrait": (832,1216), "landscape": (1216,832), "wide": (1344,768), "tall": (768,1344), "square": (1024,1024)}`
- `config.load_presets() / save_presets(dict)` — `{name: {label, ckpt, vpred, sampler, scheduler, cfg, steps, quality, negative, loras:[{name,weight}], note}}`
- `config.load_settings() / save_settings(dict)` — 키: `default_preset, comfy_url, studio_port(8190), autostart_comfy, hires_scale, hires_steps, hires_denoise, detail_steps, face_denoise, hand_denoise, expr_denoise, upscaler`
- `config.load_lora_meta() / save_lora_meta(dict)` — `{lora_filename: {trigger, weight, note}}`
  - 설정 파일이 없으면 기본값으로 만든다. 형식이 깨진 파일(JSON 문법 오류·빈 파일·객체가 아님)은 `<이름>.broken-<날짜시간>`으로 옮겨 보관한 뒤 기본값으로 다시 만들고,
    `config.RECOVERED`(목록: `{file, backup, error, message, time}`)에 기록 + 경고 로그를 남긴다. 읽기/보관 자체가 실패하면 `config.ConfigError`(ValueError 하위, 한국어 메시지에 파일 경로 포함).
  - `config.write_json(path, data)`: 임시 파일 + fsync(F_FULLFSYNC) + `os.replace` 원자적 저장. 실패하면 임시 파일을 지우고 예외를 그대로 올린다.
- `config.list_models(folder) -> {name: Path}` (folder: `checkpoints`, `loras`, `upscale_models` …), `config.find_model(folder, name)`, `config.model_dirs(folder)`, `config.MODEL_ROOTS`
  - 순서 = ComfyUI가 실제로 찾는 순서(같은 이름이면 앞쪽 우선): `VN-Pipeline/models`(첫 번째 = 설치 위치) → 엔진 `ComfyUI/models` → `ComfyUI/Shared/models`
- `characters.list_characters()`, `load(id)`, `save(dict) -> dict`, `delete(id)`(휴지통 이동), `normalize(dict)`, `valid_id(id)`, `TEMPLATE`, `DEFAULT_EXPRESSIONS`, `CharacterError`
  - 깨진 캐릭터 파일은 `load`에서 `CharacterError`(파일 이름·줄·칸 포함), `list_characters`에서는 `{id, name, error}` 항목으로 나온다.
  - 캐릭터 dict: `{id, name, count, appearance, outfit, style, negative, seed(int|None), model(프리셋명|""), loras:[{name,weight}], concept_pose, sprite_pose, expressions:{name:{prompt,denoise}}, memo}`
- `graphs.build(job) -> {"graph", "titles", "seeds", "preset", "summary", "prefixes"}` / `graphs.JobError`(한국어 메시지)
  - JobSpec: `{mode: prompt|concept|sprite|cg|bg, prompt, negative, character(id), preset, loras:[{name,weight}], size("portrait"… 또는 [w,h]), count, seed, hires, face, hands, upscale, raw, name, expressions:[이름…]|null}`
  - `graph`는 ComfyUI API 포맷. 각 노드에 `_meta.title`(한국어 단계명: "1차 생성 (1/4)", "하이레즈 리파인", "얼굴 보정", "손 보정", "표정: smile", "배경 제거", "저장" …). `titles = {node_id: title}`
  - `prefixes`: SaveImage filename_prefix 목록 (output/ 기준)
- `modelinfo.checkpoint_info(path) -> {arch, vpred, family}`, `modelinfo.lora_info(path) -> {arch, prediction, base_model, family, triggers[], rank, title?}`, `modelinfo.compatibility(lora_info, ckpt_info) -> ("ok"|"warn"|"bad", 설명)`
  - `arch`: `SDXL` | `SD1.5` | `SD2` | `Flux` | `SD3` | `unknown` (ss_base_model_version 우선, 없으면 가중치 키로 추정). 체크포인트와 다르면 `bad`.
  - `triggers`: 학습 태그 빈도에서 가장 흔한 태그의 절반 이상 붙은 것만, 등급(nsfw·general…)·품질/메타(absurdres·newest…)·일반 구도 태그와 5단어 이상 설명문 조각은 제외, 최대 8개.
- 스프라이트 `upscale`: 업스케일 모델 배율과 상관없이 기본 포즈 크기의 정확히 2배(`ImageScale`로 맞춤).
- `comfy.wait`(CLI): 연결이 연달아 끊기거나 작업이 history·큐 어디에도 없게 되면, 또는 중단되면 한국어 `RuntimeError`.

## 3. 백엔드 HTTP API (`studio/server.py`, 127.0.0.1:8190)

공통: JSON 응답. 오류는 `{"error": "한국어 메시지"}` + 4xx/5xx. 모든 상태변경(POST/PUT/DELETE)은
`Origin` 헤더가 있으면 `http://127.0.0.1:8190` 또는 `http://localhost:8190`만 허용(CSRF 방지). 바인드는 127.0.0.1만.
(Tailscale Serve 경유 원격 요청의 Host·Origin·신원 규칙은 §10.3)

### 정적
- `GET /` → `studio/web/index.html`, `GET /static/{path}` → `studio/web/` 아래 파일 (경로 탈출 차단, 캐시 비활성 `Cache-Control: no-cache`)
- `GET /files/{path}` → `output/` 아래 이미지 원본 (경로 탈출 차단)
- `GET /thumbs/{path}?w=384` → 썸네일 (Pillow로 생성, `user/studio/thumbs/`에 mtime 기반 캐시, JPEG/알파는 WEBP 또는 PNG)

### 상태 / ComfyUI 관리
- `GET /api/ping` → `{"studio": {"version": "1.0", "port": int, "pid": int}}`. ComfyUI에 묻지 않고 즉시 응답하는 생존 확인용(런처 `studio.sh`·`stop_studio.sh`가 사용).
  런처는 이 응답이 없으면 `/api/status`(최대 6초 대기)로 한 번 더 확인한다.
- `GET /api/status` →
  `{"studio": {"version": "1.0"}, "comfy": {"running": bool, "managed": bool, "starting": bool, "url": str, "version": str|null, "queue_running": int, "queue_pending": int, "ram_free": int|null}, "downloads": int, "config_warnings": [str]}`
  - `managed`: studio가 띄운 프로세스인지
  - `config_warnings`: 이번 실행에서 깨진 설정 파일을 기본값으로 복구한 안내문 (원본은 `config/<이름>.broken-<날짜시간>`으로 보관)
- `POST /api/comfy/start` → start.sh를 서브프로세스로 실행(로그 `user/server.log` append), 이미 실행 중이면 no-op. 즉시 `{"ok": true, "starting": true}`
- `POST /api/comfy/stop` → studio가 띄운 경우 SIGTERM, 아니면 8188 포트를 LISTEN 중인 PID(`lsof -tiTCP:8188 -sTCP:LISTEN`)의 커맨드라인에 `main.py`가 포함될 때만 종료. `{"ok": true}`
- `POST /api/comfy/restart`
- `GET /api/comfy/log?lines=200` → `{"lines": [str]}` (ANSI 색 코드 제거, `\r` 진행바는 마지막 줄만)
- `POST /api/shutdown` → ComfyUI(managed일 때) 및 studio 종료

### 모델 / 프리셋 / LoRA
- `GET /api/models` →
  ```json
  {"checkpoints": [{"name","path","size","mtime","arch","vpred","family","presets":[프리셋명…]}],
   "loras": [{"name","path","size","mtime","arch","prediction","base_model","family","triggers":[],"rank","title",
              "meta": {"trigger","weight","note"},            // config/loras.json 사용자 메모(없으면 기본값 weight 0.8)
              "compat": {"<preset>": {"level":"ok|warn|bad","reason":str}}}],
   "upscalers": [name…], "samplers": [..], "schedulers": [..],
   "model_dirs": {"checkpoints": [dir…], "loras": [dir…]}, "install_dir": {"checkpoints": dir, "loras": dir}}
  ```
  - samplers/schedulers는 ComfyUI `/object_info/KSampler`에서 가져오고 실패 시 기본 목록 `["euler","euler_ancestral","dpmpp_2m","dpmpp_2m_sde","dpmpp_sde","dpmpp_3m_sde","ddim","uni_pc"]`, `["normal","karras","exponential","sgm_uniform","simple","beta"]`
  - 헤더 파싱은 파일 mtime 캐시. 7GB 체크포인트도 헤더만 읽으므로 빠름.
- `GET /api/presets` → `{"presets": {...}, "default": "wai"}`
- `PUT /api/presets/{name}` body=프리셋 dict → 검증 후 저장 (name: `^[a-z0-9][a-z0-9_-]{0,39}$`; ckpt 존재 확인, cfg 1~20, steps 5~80, sampler/scheduler 문자열, loras 정규화) → `{"ok": true, "preset": {...}}`
- `DELETE /api/presets/{name}` → 기본 프리셋이거나 마지막 1개면 거부
- `POST /api/presets/default` body `{"name"}` → settings.default_preset 변경
- `PUT /api/loras/{filename}/meta` body `{"trigger","weight","note"}` → config/loras.json 저장
- `GET /api/settings` / `PUT /api/settings` (허용 키만, 숫자 범위 검증: hires_scale 1.0~2.0, *_denoise 0.05~1.0, *_steps 4~60)
- `POST /api/models/download` body `{"url", "folder": "checkpoints"|"loras"|"upscale_models", "filename"?: str}` →
  백그라운드 다운로드(aiohttp 스트리밍, `.part` 후 rename, 이어받기 불필요). `http(s)`만 허용, 파일명은 URL/Content-Disposition에서 추출 후 안전화, 확장자 `.safetensors|.pth|.pt|.ckpt`만. 저장 위치 `VN-Pipeline/models/<folder>/`.
  → `{"id", "filename"}` ; 진행은 SSE `download` 이벤트 + `GET /api/downloads` → `[{"id","filename","folder","received","total","status":"running|done|error|cancelled","error"}]`
  - `POST /api/downloads/{id}/cancel`
  - Civitai는 `?token=` 이 필요할 수 있음 — settings에 `civitai_token`(선택) 키가 있으면 civitai.com URL에 자동 부가.

### 캐릭터
- `GET /api/characters` → `{"characters": [{...캐릭터, "thumb": "/thumbs/<path>"|null}]}` (thumb: 해당 캐릭터의 가장 최근 sprite base → concept → cg 이미지)
- `GET /api/characters/{id}`, `PUT /api/characters/{id}` (body.id와 URL id 일치), `POST /api/characters` (신규, id 중복 시 409), `DELETE /api/characters/{id}`
- `GET /api/characters/template` → `characters.TEMPLATE`
- `POST /api/characters/{id}/seed` body `{"seed"}` → 해당 캐릭터 seed만 갱신 (갤러리 "이 시드로 고정")

### 작업(Job)
- `POST /api/jobs` body = JobSpec(§2) → `graphs.build` → ComfyUI `/prompt` 제출(studio 고유 client_id) →
  `{"job": Job}`  / JobError → 400 `{"error"}` / ComfyUI 꺼짐 → 503 `{"error": "ComfyUI가 실행 중이 아닙니다…"}`
- Job 객체:
  ```json
  {"id": "j_20261108_153012_ab12", "created": 1731000000.0, "spec": {...}, "summary": str, "preset": str, "seeds": [int],
   "prompt_id": str, "status": "queued|running|done|error|cancelled",
   "progress": {"stage": "하이레즈 리파인", "step": 5, "steps": 14, "done_nodes": 7, "total_nodes": 30, "percent": 42.0},
   "started": float|null, "finished": float|null, "outputs": [{"path": "haru/concept/x_00001_.png", "url": "/files/...", "thumb": "/thumbs/..."}],
   "error": str|null, "has_preview": bool}
  ```
  - percent = (완료 노드 + 현재노드 step/steps) / 실행 대상 노드 수 × 100 (캐시된 노드는 완료 처리)
    노드별 가중치(샘플러는 스텝 수)를 쓰고, 실행 중에는 뒤로 가지 않는다(얼굴/손 보정은 영역마다 스텝이 다시 시작되므로).
    studio 재시작으로 실행 도중부터 추적하는 작업만 `progress_state`의 정확한 값으로 한 번 내려갈 수 있다.
- `GET /api/jobs?limit=50` → `{"jobs": [Job…]}` (최신순)
- `GET /api/jobs/{id}`
- `POST /api/jobs/{id}/cancel` → running이면 ComfyUI `/interrupt`(해당 prompt가 실행 중일 때만), queued면 `/queue` `{"delete":[prompt_id]}`
- `POST /api/jobs/{id}/retry` → 같은 spec으로 새 job (seed는 원래 spec 그대로 → 랜덤이었으면 새 랜덤)
- `DELETE /api/jobs/{id}` → 기록만 삭제(파일은 유지)
- `GET /api/jobs/{id}/preview` → 최신 실시간 미리보기 JPEG/PNG (없으면 404)
- 저장소: `user/studio/jobs.sqlite3` (sqlite3 표준 라이브러리). 서버 재시작 시 queued/running이던 job은 ComfyUI `/history/{prompt_id}`로 복구 시도, 없으면 `error`("서버 재시작으로 추적 불가").

### 갤러리
- `GET /api/gallery?folder=&q=&char=&limit=60&offset=0` →
  `{"items": [{"path","url","thumb","folder","name","mtime","size","width","height","job_id"|null,"seed"|null,"preset"|null,"character"|null,"kind":"concept|sprite|cg|prompt|bg|other"}], "total": int, "folders": [str…]}`
  - output/ 하위 png/jpg/webp 재귀 스캔(`.trash` 제외), mtime 내림차순. `q`는 파일명/프롬프트 부분일치.
  - kind/character는 경로 규칙으로 판정: `prompt/…`→prompt, `backgrounds/…`→bg, `<char>/concept|sprite|cg/…`.
- `GET /api/gallery/info?path=` → `{"path", "job": Job|null, "positive": str|null, "negative": str|null, "seed": int|null, "ckpt": str|null, "loras": [], "width","height"}`
  - job DB에 있으면 그 정보, 없으면 PNG 텍스트 청크 `prompt`(API 그래프 JSON)에서 KSampler seed / CLIPTextEncode 텍스트(제목이 "긍정 프롬프트"/"부정 프롬프트" 또는 KSampler positive/negative 연결 추적) / Checkpoint / LoraLoader 추출.
- `POST /api/gallery/delete` body `{"paths": [..]}` → `output/.trash/`로 이동(복구 가능)
- `POST /api/gallery/reveal` body `{"path"}` → `open -R <file>` (Finder에서 보기)
- `POST /api/open-folder` body `{"which": "output"|"models_checkpoints"|"models_loras"|"characters"|"config"}` → `open <dir>`

### 실시간 이벤트 (SSE)
- `GET /api/events` → `text/event-stream`. 15초마다 `: ping`. 각 이벤트는 `event: <type>\ndata: <json>\n\n`
  - `status`   — `/api/status`와 동일 페이로드 (변화 시 + 10초마다)
  - `job`      — Job 객체 전체 (생성/상태변경/진행 변화 시; 진행 이벤트는 job당 최대 4Hz로 스로틀)
  - `preview`  — `{"job_id", "t": float}` (새 미리보기 수신; 프런트는 `/api/jobs/{id}/preview?t=` 재요청). 최대 2Hz.
  - `download` — 다운로드 객체
  - `log`      — (선택) ComfyUI 로그 새 줄

### ComfyUI 연동 사실 (구현 참고)
- 브라우저→ComfyUI 직접 호출 불가(ComfyUI가 Origin/Host 불일치 시 403). **모든 통신은 studio 백엔드가 중계**.
- 백엔드는 `ws://127.0.0.1:8188/ws?clientId=<studio_client_id>`에 상시 접속(끊기면 2초 간격 재접속), 제출 시 같은 client_id 사용.
- JSON 메시지: `status{status.exec_info.queue_remaining}`, `execution_start{prompt_id}`, `execution_cached{nodes[],prompt_id}`,
  `executing{node|null, prompt_id}` (node null = 해당 prompt 완료), `progress{value,max,node,prompt_id}`,
  `executed{node, output.images[{filename,subfolder,type}], prompt_id}`, `execution_success{prompt_id}`,
  `execution_error{prompt_id,node_id,node_type,exception_message,...}`, `execution_interrupted{prompt_id}`.
- 바이너리 메시지: 앞 4바이트 big-endian 이벤트 타입. `1`=PREVIEW_IMAGE → 다음 4바이트 이미지타입(1=JPEG,2=PNG) + 이미지 바이트.
  (현재 실행 중인 prompt의 미리보기로 간주). `start.sh`에 `--preview-method auto` 추가됨.
- 완료 확인/출력 목록: `GET /history/{prompt_id}` → `outputs[node].images[] (type=="output"만)`.
- 큐: `GET /queue` → `queue_running[[num, prompt_id, ...]]`, `queue_pending[...]`. 취소: `POST /interrupt`, `POST /queue {"delete":[id]}`.
- `GET /object_info/KSampler` → `input.required.sampler_name[0]`, `scheduler[0]`.

## 4. 프런트엔드 (`studio/web/`)

단일 페이지, 다크 테마 기본(라이트 지원), 1280px 데스크톱 기준이지만 900px까지 깨지지 않게.
한국어. 외부 라이브러리 없음. `fetch` + `EventSource`.

### 상단 바
- 앱 이름 "VN Studio", ComfyUI 상태 배지(● 실행 중 / ○ 꺼짐 / ◌ 시작 중) + [시작]/[중지]/[재시작], 큐 개수, 현재 진행 작업 요약(단계명 + %).
- ComfyUI가 꺼져 있으면 눈에 띄는 배너: "엔진이 꺼져 있습니다 [엔진 시작]".

### 탭
1. **생성** (기본 탭)
   - 프롬프트 textarea(태그 입력, Ctrl/⌘+Enter로 생성), 추가 네거티브(접힘), 캐릭터 선택(없음/캐릭터 → 외형 자동 포함 안내),
     모델 프리셋 select(라벨+노트 툴팁), LoRA 추가 UI(파일 선택 + 강도 슬라이더 0~1.5 + 호환성 배지 + 트리거 단어 "프롬프트에 넣기" 버튼),
     크기(세로/가로/와이드/톨/정사각 + 사용자 지정 W×H), 장수(1~16), 시드(랜덤/고정 + 🎲), 품질 토글(하이레즈/얼굴 보정/손 보정) + "빠른 미리보기" 프리셋 버튼(전부 끔), 예상 소요 시간 표시.
   - 우측: 현재 작업 실시간 미리보기 + 단계/진행바, 아래로 최근 결과 썸네일.
   - "프롬프트 도우미": 자주 쓰는 태그 칩(표정/포즈/구도/의상/배경/조명 카테고리) 클릭 시 삽입.
2. **캐릭터**
   - 좌측 캐릭터 카드 목록(썸네일·이름·ID) + [새 캐릭터]. 우측 편집 폼: 이름, ID(신규만), 기본 태그(count), 외형, 의상, 스타일, 추가 네거티브, 시드(비우면 랜덤), 모델 프리셋, LoRA 목록, 시안 포즈, 스프라이트 포즈, 표정 목록(행 추가/삭제: 이름·프롬프트·강도 슬라이더), 메모. [저장] [삭제].
   - 액션: [시안 N장 생성](N 입력) [스프라이트 생성](표정 체크박스로 일부만 선택 가능, 업스케일 옵션) [CG 생성](장면 프롬프트) — 품질 토글 공유.
   - 하단: 이 캐릭터의 결과물 갤러리(시안/스프라이트/CG 탭). 시안 이미지에 "이 시드로 고정" 버튼.
3. **배경** — 배경 설명, 파일 이름, 크기(기본 와이드), 장수, 품질 토글, 결과 갤러리(backgrounds).
4. **갤러리** — 폴더/종류/캐릭터 필터, 검색, 무한 스크롤 또는 더보기. 썸네일 그리드(투명 PNG는 체커보드 배경).
   라이트박스: 큰 이미지, ←/→ 이동, Esc 닫기, 정보 패널(프롬프트·시드·모델·LoRA·크기), 버튼: [같은 설정으로 다시] [이 시드로 고정(캐릭터)] [고품질로 다시](빠른 모드로 만든 경우) [프롬프트 복사] [Finder에서 보기] [삭제(휴지통)] [다운로드].
5. **작업** — 작업 목록(대기/진행/완료/실패), 진행률, 취소/재시도/기록삭제, 실패 메시지 전체 보기.
6. **모델·LoRA**
   - 프리셋 카드: 라벨, 체크포인트(select, 체크포인트별 arch/vpred 배지), vpred 토글(체크포인트 선택 시 자동 감지값 제안),
     샘플러/스케줄러 select, CFG/스텝 슬라이더, 품질 태그, 기본 네거티브, 기본 LoRA 목록, 노트. [저장] [복제] [삭제] [기본으로 지정].
     [새 프리셋] → 체크포인트 선택 → vpred 자동 감지 → 템플릿값(eps: euler_ancestral/cfg 6/28스텝/"masterpiece, best quality, amazing quality", vpred: euler/cfg 5/30스텝) 채움.
   - 체크포인트 목록 표: 이름, 크기, arch, vpred, 사용 중인 프리셋, (프리셋 없으면 [프리셋 만들기]).
   - LoRA 라이브러리 표/카드: 이름, 크기, arch, 학습 베이스, 예측방식, 트리거 후보(자동 추출), 사용자 메모(트리거/기본강도/설명 인라인 편집 저장), 프리셋별 호환성 배지(✅/⚠️/❌ + 사유 툴팁).
   - [모델 폴더 열기] [LoRA 폴더 열기] [목록 새로고침], **URL로 다운로드** 폼(폴더 선택, 진행률 바, 취소) — Civitai 토큰 입력란(settings.civitai_token).
   - 전역 설정 패널: 하이레즈 배율/스텝/강도, 얼굴/손 보정 강도, 표정 기본 강도, 보정 스텝 — 각 항목 설명 툴팁.
   - 각 섹션에 `help/` 가이드로 연결되는 "? 설명" 링크.
7. **도움말** — `help/` 의 가이드 HTML 조각들을 목차와 함께 표시.

### 공통 UX
- 토스트 알림(성공/오류), 작업 완료 시 토스트 + (허용 시) 브라우저 Notification.
- 모든 입력 필드 옆 ⓘ 툴팁: 문구는 `help/tips.json`의 키로 조회 (§5 키 목록). 없는 키는 툴팁 생략.
- 저장 안 한 변경이 있으면 탭 이동/페이지 이탈 시 경고.
- 최근 사용한 생성 옵션(프리셋/크기/품질 토글)은 localStorage에 기억 (try/catch).
- 접근성: 버튼에 label, 포커스 링, 키보드 조작.

## 5. 도움말 (`studio/web/help/`)

- `index.json` → `[{"id": "start", "title": "시작하기", "file": "start.html"}, ...]` (표시 순서)
- 각 `*.html`은 `<section>` 조각(전체 문서 아님, `<html>/<head>` 없음). 이미지 없이 텍스트/표/코드블록.
- 필수 가이드: 시작하기(앱 실행·종료, 엔진, 폴더 구조), 생성 워크플로(시안→시드 고정→스프라이트→CG/배경), 프롬프트 작성법(Danbooru 태그, 가중치 `(tag:1.2)`, 순서, 네거티브, 캐릭터 일관성 팁),
  **모델(체크포인트)이란 + 추가 방법**(다운로드처: Civitai/HuggingFace, 파일 위치, SDXL/SD1.5, eps vs v-pred, 프리셋 만들기와 각 값의 의미·권장값, 모델 페이지의 권장 설정 읽는 법),
  **LoRA란 + 추가·사용법**(종류: 캐릭터/그림체/의상/디테일/포즈, 강도 0.4~1.0, 트리거 단어, 여러 개 조합 시 주의, 베이스 호환성 ✅⚠️❌ 의미, 프리셋 기본 LoRA vs 캐릭터 LoRA vs 일회성 LoRA),
  품질 설정(하이레즈/얼굴/손 보정이 하는 일, 강도의 의미, 빠른 미리보기), 표정 차분과 투명 스프라이트, 문제 해결(엔진 시작 실패, 메모리 부족/느림, 손·눈 깨짐, 그림체 이상, LoRA 효과 없음, 검은 이미지/색 이상 = vpred 설정), 라이선스 주의(NoobAI 상업 이용 금지, 모델별 확인).
- 현재 설치된 모델/LoRA 기준 예시 포함: 체크포인트 `waiIllustriousSDXL_v170`(eps, 기본), `NoobAI-XL-Vpred-v1.0`(vpred), `NoobAI-XL-v1.1`(eps), `aamXLAnimeMix_v10`(eps, 프리셋 없음);
  LoRA `AddMicroDetails_Illustrious_v6`(디테일, 트리거 addmicrodetails), `detailed_hands_unhinged`(손), `noobai_vpred_1_masterpieces_v23`(vpred 품질), `add_detail`(SD1.5 → 비호환 예시) 등.
- `tips.json` → `{key: "한두 문장 한국어 설명"}`. 필수 키:
  `prompt, negative, character, preset, lora, lora_weight, lora_trigger, size, count, seed, hires, face, hands, fast, upscale,
   char_id, char_name, char_count, char_appearance, char_outfit, char_style, char_negative, char_seed, char_model, char_loras, char_concept_pose, char_sprite_pose, char_expressions, expr_denoise, char_memo,
   bg_prompt, bg_name,
   preset_label, preset_ckpt, preset_vpred, preset_sampler, preset_scheduler, preset_cfg, preset_steps, preset_quality, preset_negative, preset_loras, preset_note,
   set_hires_scale, set_hires_steps, set_hires_denoise, set_detail_steps, set_face_denoise, set_hand_denoise, set_expr_denoise, set_upscaler, civitai_token,
   lora_compat, ckpt_arch, ckpt_vpred, download_url`

## 6. 런처

- `studio.sh`: 엔진 Python으로 `studio/server.py` 실행. 이미 8190에서 응답하면 재실행하지 않음. 로그 `user/studio.log`.
  옵션 `--open`이면 서버 준비 후 브라우저 열기: Chrome 있으면 `open -na "Google Chrome" --args --app=http://127.0.0.1:8190 --window-size=1440,960`(앱 창 모드), 없으면 `open http://127.0.0.1:8190`.
- `scripts/make_app.sh`: `osacompile`로 `/Volumes/T7/VN-Pipeline/VN Studio.app` 생성 (더블클릭 → `studio.sh --open`을 백그라운드 실행, 터미널 창 없이).
  아이콘: `output/haru/concept/haru_wai_seed20261108_00001_.png`(있으면) 얼굴 부분을 정사각 크롭 → `sips`+`iconutil`로 .icns → 앱 번들에 적용. 실패해도 앱은 생성.
- `scripts/stop_studio.sh`: studio(8190)와 studio가 띄운 ComfyUI 종료 (`POST /api/shutdown` 후 남으면 PID 종료).
  studio가 띄운 ComfyUI = studio 프로세스의 자손, 또는 `user/studio/comfy_pid.json`에 기록된 프로세스(명령줄에 main.py, 기록된 시작 시각과 1분 이내로 일치 — PID 재사용 방지).
  studio가 죽었거나 재시작돼 엔진을 인계받은 경우에도 끈다. 정상 종료 요청이 실패하면 기다리지 않고 바로 PID로 종료하며, 대기는 실제 시간 기준 최대 20초.
- 런처의 생존 확인: `GET /api/ping`(2초) → 없으면 `GET /api/status`(6초). `studio.sh`의 준비 대기도 실제 시간 기준 `WAIT_SECS`(20초).
- 서버는 시작 시 settings.autostart_comfy가 true이고 ComfyUI가 꺼져 있으면 자동 시작.

## 7. 품질 기준
- 경로 탈출(`..`, 절대경로, 심볼릭 링크로 output 밖) 차단.
- 서버 예외가 프로세스를 죽이지 않을 것. 모든 핸들러는 JSON 오류 반환.
- ComfyUI가 꺼져 있어도 studio UI는 정상 표시(모델·캐릭터 편집 가능), 생성 버튼만 비활성 + 안내.
- 긴 목록(갤러리 수백 장)에서도 부드럽게: 썸네일 lazy-load(`loading="lazy"`), 페이지네이션.


## 8. 프롬프트 추출 (이미지·3D 모델 → Danbooru 태그) — 2026-11-08 추가

목적: 참고 이미지나 3D 캐릭터 모델에서 **프롬프트(Danbooru 태그)를 자동으로 뽑아** 생성 탭이나 캐릭터 외형/의상 칸으로 보낸다.
현재 체크포인트(WAI-Illustrious, NoobAI)는 Danbooru 태그로 학습됐으므로 자연어 캡션이 아니라 **태그**를 뽑는다.

### 8.1 태거 모델 (설치됨)
- `models/tagger/wd-eva02-large-tagger-v3/{model.onnx, selected_tags.csv}` (SmilingWolf, Apache-2.0, 1.26GB).
  - 입력: `float32 [1, 448, 448, 3]` NHWC, **BGR**, 0~255 (정규화 없음). 출력: `[1, 10861]` 시그모이드 확률.
  - `selected_tags.csv` 열: `tag_id,name,category,count`. category `9`=등급(general/sensitive/questionable/explicit), `0`=일반, `4`=캐릭터.
  - 전처리: EXIF 회전 보정 → 투명/팔레트 이미지는 흰 배경에 합성 → RGB → 긴 변 기준 흰색 정사각 패딩(가운데) → 448 BICUBIC 리사이즈 → BGR.
    (구현 메모) 긴 변이 `PAD_MAX`(4096)를 넘는 직사각형(세로로 긴 웹툰·스크롤 캡처 등)은 패딩 전에 긴 변 4096으로 먼저 줄인다 — max(w, h)² 캔버스가 수 GB가 되지 않게. 그 밖의 이미지는 참조 구현과 결과가 같다.
    EXIF가 손상돼 `ImageOps.exif_transpose`가 실패하면 Orientation 값만 읽어 직접 회전한다. `prepare()`의 그 밖의 예외는 모두 `TaggerError(kind="image")`(400)로 바꾼다.
  - onnxruntime **CPUExecutionProvider** 사용 (M4 Pro에서 1장 ≈0.7초, 로드 ≈1초. CoreML은 더 느려서 쓰지 않음).
- 다른 태거(같은 형식의 SmilingWolf v3 계열: wd-vit-tagger-v3 등)는 `models/tagger/<이름>/`에 두 파일을 넣으면 목록에 나타난다. 다운로드 UI는 만들지 않음(도움말로 안내).

### 8.2 `vnlib/tagger.py` (신규, CLI와 Studio 공용, 표준 라이브러리 + numpy + Pillow + onnxruntime)
- `DEFAULT_MODEL = "wd-eva02-large-tagger-v3"`, `list_models() -> [{name, path, size}]` (`config.model_dirs("tagger")` 아래에서 두 파일이 다 있는 하위 폴더).
- `TaggerError`(한국어 메시지). onnxruntime 미설치/모델 없음/이미지 못 읽음 → `TaggerError`.
- `get(name=None) -> Tagger` (이름별 캐시, 지연 로드, 스레드 안전 lock). `unload_all()`.
  - (구현 메모) 캐시 lock은 dict 읽기/쓰기에만 잠깐 잡고, 로드는 모델 이름별 lock으로 한 번만 한다 → 모델을 불러오는 중에도 `loaded()`(따라서 `GET /api/tagger`)가 바로 답한다(불러오는 중인 모델은 아직 `loaded`에 없음).
- `Tagger.predict(image: PIL.Image) -> {"rating": {general, sensitive, questionable, explicit}, "tags": [{tag, score, kind: "general"|"character", group}]}`
  - 점수 ≥ `FLOOR = 0.15`인 일반 태그와 ≥ 0.5인 캐릭터 태그만, 점수 내림차순. (UI가 기준값 슬라이더로 다시 거르므로 넉넉히 반환)
  - 태그 표기: 밑줄 → 공백. 단, 이모티콘 태그(`^_^`, `>_<`, `o_o`, `0_0`, `@_@`, `x_x`, `=_=`, `u_u`, `+_+`, `._.`, `|_|`, `||_||`, `<o>_<o>`, `<|>_<|>`, `(o)_(o)`, `3_3`, `6_9`, `>_o`, `+_-`)는 그대로.
- `classify(tag) -> group` — 키워드 규칙 기반. 그룹(표시 순서 = 프롬프트 순서):
  `count`(1girl, 2boys, solo, multiple girls, no humans…) → `character`(kind=character 전용) → `appearance`(머리카락·눈·피부·체형·귀/꼬리/뿔/날개·나이대·안경? 아님) → `outfit`(옷·신발·모자·장신구·안경·리본(머리 리본 포함)) → `expression`(표정·홍조·눈물·입 모양) → `pose`(자세·손동작·시선 `looking at viewer`) → `composition`(full body, upper body, cowboy shot, from side, close-up…) → `background`(배경색/simple background/장소/날씨/시간/조명) → `other` → `meta`(제외 권장: 3d, realistic, photorealistic, blender (medium), mikumikudance (medium), koikatsu (medium), vrchat, cgi, render, figure, doll, tachi-e, transparent background, virtual youtuber, signature, watermark, text, logo, artist name, english text, web address, dated, multiple views, reference sheet, expressions, sketch, speech bubble, comic, 검열 표시(censored…)).
  - `monochrome`/`greyscale`는 `other`(사용자가 판단). `t-pose`/`a-pose`/`outstretched arms`/`spread arms`는 3D 원본에서 흔한 기본자세 → `pose`로 분류하되(`meta` 아님) 아래 3D 기본 제외 목록에 포함.
  - 애매하면 `other`. 규칙은 모듈 상단 상수(정규식/단어 목록)로 두어 읽기 쉽게.
  - (구현 메모) 노출 부위가 옷 때문에 보이는 태그(navel, midriff, cleavage, bare shoulders, zettai ryouiki…)는 `outfit`. 들고 있는 물건·음식(cup, tray, sword…)은 `other`, 가구·건물·꽃·조명은 `background`, `holding X`는 `pose`.
    노골적인 성적 태그(nude, nipples, sex…)와 미성년자를 성적으로 다루는 태그(loli, shota, mesugaki…)는 `meta`(기본 제외)로 분류한다.
    wd-eva02 v3 태그 목록에는 `3d`, `blender (medium)`, `t-pose` 같은 태그가 없다(다른 태거용으로 규칙은 유지). 미술 재료 태그(watercolor (medium) 등)는 그림체이므로 `other`.
- (구현 메모) 그 밖의 공개 함수: `classify(tag, kind="general")`, `norm_tag(tag)`, `group_list() -> [{id, label}]`, `find_model(name)`, `default_name(preferred) -> 이름|None`(설정값 → DEFAULT_MODEL → 첫 설치 모델), `no_model_message()`, `runtime_error() -> 한국어|None`, `loaded() -> [이름]`, `open_image(path|bytes) -> PIL.Image`.
  `TaggerError.kind`: `unavailable`(onnxruntime·모델 없음/손상 → 503) · `not_found`(요청한 모델 이름 없음 → 400) · `image`(못 읽음·50MP 초과 → 400) · `error`(추론 실패 → 500).
  `predict()` 결과에는 `size: [w, h]`(EXIF 회전 보정 후)도 들어 있다. 50MP 제한은 전역 `Image.MAX_IMAGE_PIXELS`를 바꾸지 않고 `open_image`에서 크기를 직접 검사한다(갤러리 썸네일에 영향 없게).
  numpy·Pillow·onnxruntime은 함수 안에서 import한다 → 엔진 Python이 아닌 `python3`로 다른 CLI 명령을 써도 깨지지 않는다.
- `GROUP_LABELS = {count: "인원", character: "캐릭터", appearance: "외형", outfit: "의상", expression: "표정", pose: "포즈", composition: "구도", background: "배경", other: "기타", meta: "제외 권장"}`
- `escape(tag)`: ComfyUI 프롬프트용으로 `(`→`\(`, `)`→`\)` (가중치 문법과 충돌 방지). `to_prompt(tags)`: 그룹 순서대로 escape해서 `, ` 결합.
- `predict_file(path, ...)` 편의 함수.

### 8.3 CLI (`vn.py tag`)
`python3 vn.py tag <이미지> [--threshold 0.35] [--char-threshold 0.85] [--model 이름] [--all]` → 그룹별 태그(점수)와 최종 프롬프트 한 줄 출력. 기본은 `meta` 제외. ComfyUI 불필요.
- (구현 메모) 이미지 여러 개 가능. 기준값 기본은 settings(`tagger_threshold`/`tagger_char_threshold`), 범위 0.05~0.95 / 0.3~0.99. 캐릭터 태그는 기준값 이상이면 프롬프트에 포함(안내 문구 표시).
  numpy/onnxruntime이 없는 Python(예: Homebrew `python3`)으로 실행하면 엔진 Python으로 자동 재실행한다. 읽을 수 없는 이미지는 그 파일만 "오류:"로 표시하고 종료 코드 1.
  모델은 처음으로 열린 이미지가 나왔을 때 불러온다(없는 파일·못 읽는 파일만 있으면 모델을 불러오지 않음). 예상 못 한 오류도 그 파일만 실패로 표시하고 다음 파일로 넘어간다.

### 8.4 백엔드 API (`studio/tagging.py` 신규 + `server.py` 라우트)
- 추론은 `asyncio.to_thread` + 전역 `asyncio.Lock`(한 번에 하나). 마지막 사용 후 **15분** 지나면 모델 언로드(메모리 1.5GB 회수, 백그라운드 타이머).
- `GET /api/tagger` → `{models: [{name, size}], default: settings.tagger_model, loaded: 이름|null, available: bool(onnxruntime import 가능), error?: 한국어}`
  - (구현 메모) `default`는 실제로 쓸 설치된 이름(설정값이 설치돼 있지 않으면 DEFAULT_MODEL → 첫 모델, 하나도 없으면 null). 추가 필드: `configured`(설정값 그대로), `threshold`, `char_threshold`(설정 기준값), `groups: [{id, label}]`.
    `error`는 onnxruntime이 없을 때(`available: false`)와 모델이 하나도 없을 때(`available: true`, `models: []`) 둘 다 채워진다.
- `POST /api/interrogate`
  - 입력 ①: `multipart/form-data` — `image`(파일), 선택 필드 `model`, `source`(`image`|`3d`, 응답에 그대로 반영).
  - 입력 ②: JSON `{path: "output/ 기준 상대경로", model?, source?}` — 갤러리 이미지. `safe_path(OUTPUT_DIR, path)` 필수.
  - 제한: 업로드 최대 **20MB**(이 라우트만 예외적으로 허용하도록 `client_max_size`를 32MB로 올리되 다른 JSON 라우트는 기존 검사 유지 — 또는 핸들러에서 스트리밍 크기 검사), 픽셀 최대 50MP(`Image.MAX_IMAGE_PIXELS`), Pillow로 열 수 없는 파일 → 400 "이미지를 읽을 수 없습니다".
  - 업로드 파일은 디스크에 저장하지 않는다(메모리에서 처리). (구현 메모) 이미지를 먼저 열고 나서 모델을 불러온다 → 못 읽는 이미지는 모델 로드 없이 400.
  - 응답: `{model, elapsed, size: [w, h], source, rating: {...}, tags: [{tag, score, kind, group}], groups: [{id, label}]}` (`groups`는 표시 순서). 첫 호출(모델 로드)은 수 초 걸릴 수 있음.
    (구현 메모) 추가 필드: `cold`(이번 호출에서 모델을 불러왔으면 true), `name`(업로드 파일명 또는 경로의 파일명), `path`(JSON 방식일 때 요청한 경로). `elapsed`는 모델 로드 포함 초.
  - 오류: 태거 없음/onnxruntime 없음 → 503 + 한국어 안내(도움말 문구 포함). 
    (구현 메모) 503 본문에는 `reason: "unavailable"`, `help: "extract"`(도움말 id)도 들어 있다. 그 밖에: 이미지 못 읽음·50MP 초과·`source`가 image/3d가 아님·없는 `model`·`image` 필드 없음/빈 파일 → 400,
    path 탈출/숨김 → 403, 없는 파일 → 404, 업로드 20MB 초과 → 413(`Content-Length`로 미리 거르거나 읽는 도중 중단), JSON 본문 1MB 초과 → 413, 원본 이미지를 본문에 그대로(`Content-Type: image/*`) → 415.
    크기 검사는 핸들러가 multipart를 스트리밍으로 읽으며 하므로 앱 전체 `client_max_size`(8MB)는 그대로다. JSON은 `Content-Type`이 text/plain이어도 받는다(Origin 검사는 동일).
- settings 추가 키(`vnlib/config.DEFAULT_SETTINGS` + `library.SETTING_RULES`): `tagger_model`(str, 설치된 이름만), `tagger_threshold`(0.35, 0.05~0.95), `tagger_char_threshold`(0.85, 0.3~0.99).
- 메모리: ComfyUI(최대 ~10GB)와 동시에 돌아도 문제 없음(24GB).

### 8.5 프런트엔드 — 새 탭 **"프롬프트 추출"** (`#/extract`, view id `extract`)
탭 순서: 생성 · 캐릭터 · 배경 · **프롬프트 추출** · 갤러리 · 작업 · 모델·LoRA · 도움말.
레이아웃: 좌측 = 입력(원본), 우측 = 결과(태그). 1280px에서 두 열, 900px 이하 한 열.

**원본 선택**: 세그먼트 버튼 [이미지] [3D 모델].
- 이미지: 드롭존(끌어다 놓기·클릭해서 선택·⌘/Ctrl+V 붙여넣기), [갤러리에서 고르기](모달: `/api/gallery` 썸네일 그리드, 폴더 필터 정도), 미리보기.
  허용: png/jpg/jpeg/webp/gif(첫 프레임)/bmp. 업로드 전 브라우저에서 긴 변 2048px 초과 시 축소(PNG, 투명도 유지). 서버는 흰 배경 합성.
  라우트 `#/extract?path=<output 상대경로>`(또는 라이트박스 이벤트)로 들어오면 그 이미지를 바로 추출.
- 3D 모델: `studio/web/js/viewer3d.js`(§8.6) 사용. **three.js는 3D 모드를 처음 열 때 동적 import**(앱 시작 속도 유지).
  - [파일 고르기](여러 개 선택 가능) + [폴더 고르기](`webkitdirectory`, 텍스처가 따로 있는 FBX/OBJ/PMX용) + 드롭존(파일 여러 개/폴더 드롭 지원하면 좋음).
  - 지원: `.glb .gltf .vrm .fbx .obj(+.mtl) .pmx .pmd`. 텍스처: png/jpg/jpeg/tga/bmp/webp/dds(dds는 미지원 경고).
  - 도구 막대: 각도 프리셋 [정면][왼쪽 3/4][오른쪽 3/4][옆][뒤], 프레이밍 [전신][상반신][얼굴], 배경 [흰색][회색], 밝기 슬라이더, [팔 내리기](감지 시), 애니메이션 클립 select + 시간 슬라이더(클립 있을 때), [시점 초기화]. 마우스로 회전/확대(OrbitControls).
  - 정보 줄: 형식, 이름, 폴리곤 수, 누락 텍스처 경고, VRM이면 메타(제목·작가·라이선스/상업 이용 허가 여부)를 표시하고 "모델 이용 약관을 확인하세요" 안내.
  - [이 각도로 추출] → 현재 각도·프레이밍으로 1024×1024 PNG 캡처 → `/api/interrogate`(source=3d).
  - [여러 각도로 추출] → 정면 + 왼쪽 3/4 + 오른쪽 3/4 (체크로 뒤/옆 추가 가능) 캡처 → 각각 추출 → 태그별 **최고 점수**로 합침. 각도에서만 나오는 구도 태그(from side, from behind, profile, back)는 합칠 때 버림.
  - 캡처 썸네일을 결과 위에 작게 보여 줌(어떤 그림을 태깅했는지).

**결과 패널** (원본 공통)
- 상단: 사용 모델·소요 시간, 등급(general/sensitive/questionable/explicit 중 최고) 배지 — questionable/explicit이면 "생성 기본 네거티브에 nsfw가 있으니 태그를 확인하세요" 경고.
- 기준값 슬라이더 2개: 일반 태그(기본 settings.tagger_threshold), 캐릭터 태그(기본 settings.tagger_char_threshold). 서버 재호출 없이 클라이언트에서 필터.
- 그룹별 태그 칩(그룹 라벨 + [모두 켜기/끄기]): 칩 = 태그 + 점수(%) + 한국어 라벨이 `data/tags.js`에 있으면 툴팁. 클릭으로 포함/제외 토글. 점수 낮은 순으로 흐리게.
  - 기본 포함: 이미지 원본 = `meta` 빼고 전부. **3D 원본 = `count, character, appearance, outfit, expression, other`만**(pose·composition·background·meta 기본 제외, 칩은 보이되 꺼진 상태) + 3D 기본 제외 태그(t-pose, a-pose, outstretched arms, spread arms, simple background, white background, grey background, gradient background, full body, standing, expressionless)는 꺼진 상태.
  - 캐릭터 태그(예: hatsune miku)는 별도 줄 + 안내 "기존 캐릭터로 인식됨 — 넣으면 그 캐릭터 모습이 강하게 반영됩니다" (기본 꺼짐).
- 최종 프롬프트: 켜진 태그를 그룹 순서로 escape하여 만든 편집 가능한 textarea(직접 고치면 칩 토글 시 덮어쓰기 전에 확인 또는 "수정됨" 표시 후 [다시 만들기]).
- 버튼:
  - [복사]
  - [생성 탭으로 보내기] → 생성 탭 프롬프트를 이 프롬프트로 교체하고 생성 탭으로 이동. 기존 프롬프트가 있으면 기존 '생성 탭에서 편집'과 같은 12초 [되돌리기] 토스트. (구현: `emit('generate:prompt', {prompt, source})` → generate.js가 기존 `pendingLoad` 방식처럼 미방문 탭에서도 받음)
  - [새 캐릭터로 만들기] → `#/characters/new`를 열고 폼을 채움: 기본 태그 = count 그룹(없으면 `1girl, solo`), 외형 = appearance 그룹, 의상 = outfit 그룹, 메모 = "프롬프트 추출에서 가져옴 (원본: 파일명/3D 이름)" + 캐릭터 태그. 저장은 사용자가 확인 후 직접(자동 저장 금지). (구현: `emit('characters:prefill', {...})`, characters.js가 미방문이어도 받도록 pending 처리)
  - [기존 캐릭터에 적용…] → 캐릭터 선택 메뉴 → 그 캐릭터 편집기를 열고 외형/의상 칸을 이 값으로 **교체**(덮어쓰기 전 확인 대화상자, 저장은 사용자가). 
- 빈 상태/오류: 태거 없음(503) → 설치 안내 + 도움말 링크. 첫 추출 시 "태거 모델 불러오는 중…(처음 한 번 몇 초)" 스피너.
- 연동: 갤러리 라이트박스에 [태그 추출] 버튼 → `#/extract?path=...`; 생성 탭 프롬프트 칸 옆 작은 링크 "이미지·3D에서 가져오기" → `#/extract`.
- 모델·LoRA › 전역 설정에 "프롬프트 추출" 묶음: 태거 모델 select(설치 목록), 일반/캐릭터 기준값(ⓘ 툴팁).
- `index.html`: 탭/섹션 추가, `<script type="importmap">`(app.js 모듈 스크립트보다 **앞**):
  `{"imports": {"three": "/static/vendor/three/build/three.module.js", "three/addons/": "/static/vendor/three/examples/jsm/", "@pixiv/three-vrm": "/static/vendor/three-vrm/three-vrm.module.js"}}`
- `api.js`: `FormData` 본문 지원(Content-Type 자동, JSON.stringify 하지 않음) + 업로드용 긴 timeout(120초).

### 8.6 `studio/web/js/viewer3d.js` (3D 뷰어 모듈 — 독립 담당, 이 계약만 지키면 됨)
벤더 라이브러리(설치됨, 수정 금지): `studio/web/vendor/three/` (three.js r167: `build/three.module.js`, `examples/jsm/{controls/OrbitControls, loaders/GLTFLoader, FBXLoader, OBJLoader, MTLLoader, MMDLoader, TGALoader, curves/NURBS*, libs/fflate, libs/mmdparser, utils/BufferGeometryUtils, shaders/MMDToonShader}.js`), `studio/web/vendor/three-vrm/three-vrm.module.js` (@pixiv/three-vrm 3.5.5). import는 importmap 이름(`three`, `three/addons/...`, `@pixiv/three-vrm`)으로.
```js
export async function createViewer(container, { onStatus } = {}) // → viewer (컨테이너 크기에 맞춰 resize 관찰)
viewer.load(files /* File[] (FileList 가능, webkitRelativePath 유지) */) // → Promise<info>
  // info = { format: 'glb'|'gltf'|'vrm'|'fbx'|'obj'|'pmx'|'pmd', name, triangles, meshes, hasSkeleton,
  //          armsAdjustable: bool, clips: [name], meta: {title, author, version, license, commercial, allowedUser, ...}|null,
  //          warnings: ['텍스처를 찾지 못함: body.png', ...] }  // 실패 시 한국어 Error throw
viewer.setView(view /* 'front'|'left34'|'right34'|'side'|'back' */, framing /* 'full'|'upper'|'face' */) // 모델 경계상자/뼈(머리) 기준 자동 프레이밍
viewer.setBackground(color /* '#ffffff' 등 */); viewer.setBrightness(v /* 0.3~2 */)
viewer.setArmsDown(on /* bool */)  // 위팔 뼈를 찾아 월드 기준으로 아래(살짝 바깥)로 회전. VRM은 humanoid API, 그 외 이름 규칙(mixamorig:LeftArm, J_Bip_L_UpperArm, upperarm_l, 左腕 …)
viewer.setClip(name|null); viewer.setClipTime(t /* 0~1 */)
viewer.capture({ size = 1024, view, framing } = {}) // → Promise<Blob(PNG)> 정사각, 지정 각도로 오프스크린 렌더, 화면 시점은 그대로 유지
viewer.captureAngles(views, { size, framing }) // → Promise<[{view, blob}]>
viewer.reset(); viewer.dispose()
```
- 모델 정규화: 경계상자 기준 바닥 y=0, 가운데 정렬, 단위 자동 보정(FBX cm 등), 앞(+Z) 바라보게(VRM0는 `VRMUtils.rotateVRM0`). 앞 방향을 확신할 수 없으면 정면 프리셋이 반대일 수 있으니 [정면] 버튼 옆에 "앞뒤 바꾸기"(180° 회전) 제공.
- 조명: 부드러운 스튜디오(반구광 + 정면 위 방향광 + 약한 뒤 림라이트), 그림자 없음, `SRGBColorSpace`, 톤매핑 없음(색이 원본에 가깝게 — 태거가 색을 정확히 읽도록).
- 재질: MMD/VRM(MToon) 그대로. FBX/OBJ의 Phong/Lambert는 그대로. 텍스처 없는 재질은 회색.
- 외부 텍스처 해석: 선택된 파일 목록으로 `LoadingManager.setURLModifier` — 경로 끝부분(파일명, 대소문자 무시, `\`→`/`)으로 blob URL 매칭. 못 찾으면 warnings에 추가. blob URL은 dispose 때 해제.
- 큰 모델(>200MB 파일/수백만 폴리곤)은 경고 후 진행. 로딩 진행률은 onStatus({phase, progress, message}).
- WebGL 미지원/컨텍스트 손실 → 한국어 오류.

### 8.7 도움말·문서
- 새 가이드 `help/extract.html` (index.json에 '프롬프트 추출', '모델(체크포인트)' 다음 위치 무관 — 생성 워크플로 근처 권장):
  태거가 하는 일(태그+확률), 기준값 의미(낮추면 많이·부정확, 높이면 적게·정확), 그룹과 기본 제외 이유(3d/t-pose/흰 배경 같은 '원본 특성' 태그), 이미지 사용법, 3D 사용법(형식, 텍스처 폴더 선택, 각도/여러 각도, 팔 내리기, 앞뒤 바꾸기), 결과 활용(생성 탭/새 캐릭터/기존 캐릭터), 정확도 한계(색은 조명 영향 — 눈·머리색 확인, 작은 장신구 누락, 캐릭터 태그), 3D 모델·참고 이미지의 **이용 약관/저작권** 주의(VRM 메타 라이선스 표시 활용), 다른 태거 추가 방법(§8.1), CLI `vn.py tag`.
- tips.json 키: `extract_source, extract_image, extract_3d_files, extract_view, extract_framing, extract_arms, extract_flip, extract_clip, extract_bg, extract_brightness, extract_capture, extract_multi, extract_threshold, extract_char_threshold, extract_groups, extract_prompt, extract_to_generate, extract_new_character, extract_apply_character, tagger_model, set_tagger_threshold, set_tagger_char_threshold`
- start.html(탭 목록), files.html(models/tagger, vendor), troubleshoot.html(3D가 안 보임/검게 보임/텍스처 누락/모델이 뒤를 봄/추출이 503) 갱신. README에 기능 요약.

## 9. 포즈 따라 그리기 (ControlNet OpenPose) — 2026-11-09 추가

목적: **3D 모델의 자세**(또는 참고 이미지의 자세)를 뼈대 그림(OpenPose 맵)으로 만들어, 생성할 때 그 자세를 따라 그리게 한다.
프롬프트 추출(§8)과 같은 탭·같은 3D 뷰어를 쓰고, 생성 탭/캐릭터 탭에서 포즈를 붙여 생성한다.

### 9.1 모델 (설치됨)
- ControlNet(SDXL OpenPose) 2종:
  - `models/controlnet/noob_openpose.safetensors` — Laxhar, **NoobAI/Illustrious 계열 전용**으로 학습(WAI·NoobAI와 그림체가 잘 맞음). 라이선스는 NoobAI 계열(상업 이용 제한 가능 — 도움말에서 원본 확인 안내).
  - 엔진 `ComfyUI/models/controlnet/controlnet-openpose-sdxl-1.0.safetensors` — xinsir, SDXL 범용(Apache-2.0). 굵은 뼈대 선(아래 그리기 규칙)을 전제로 학습.
  - **기본값 `noob_openpose.safetensors`, 강도 1.0, 적용 구간 끝 1.0** (§9.10 실측). xinsir는 굵은 선 + 강도 1.2 이상이어야 팔 같은 큰 동작을 따라감.
  - `extra_model_paths.yaml`의 `vn_pipeline`에 `controlnet: controlnet` 추가함(ComfyUI 재시작 완료). `config.model_dirs("controlnet")`로 둘 다 보임.
- 포즈 감지(이미지 → 뼈대): DWPose ONNX — `…/ComfyUI/custom_nodes/comfyui_controlnet_aux/ckpts/yzd-v/DWPose/{yolox_l.onnx, dw-ll_ucoco_384.onnx}` (설치됨).
  - **ComfyUI의 DWPreprocessor 노드는 쓰지 않는다**(엔진 쪽 onnxruntime 감지 실패로 OpenCV 대체 경로가 돌아 뼈대가 엉뚱한 위치·크기로 그려지는 것을 확인함). Studio/CLI 프로세스에서 onnxruntime(CPU)으로 직접 돌린다 — 1장 0.3~0.7초.
  - `comfyui_controlnet_aux/src/custom_controlnet_aux/dwpose/dw_onnx/{cv_ox_det.py, cv_ox_pose.py}`는 cv2+numpy만 import → `importlib`로 **파일 경로에서 직접 로드**해 재사용(패키지 `__init__`은 torch를 import하므로 쓰지 말 것). 함수: `inference_detector(session, img_bgr, detect_classes=[0], dtype=np.float32) -> boxes[n,4]`, `inference_pose(session, boxes, img_rgb, (288, 384), dtype=np.float32) -> (kps[n,133,2], scores[n,133])` (원본 픽셀 좌표).
  - **채널 순서가 서로 다르다**: YOLOX(사람 상자)는 cv2 BGR로 학습 → BGR, RTMPose(dw-ll_ucoco_384, `bgr_to_rgb=True`로 학습, `cv_ox_pose.preprocess`는 RGB 순서 mean/std로 정규화만 하고 채널을 바꾸지 않음) → **RGB** (comfyui_controlnet_aux도 RGB를 넘김). 관절 모델에 BGR을 주면 전신 스프라이트에서 한 손이 통째로 빠지거나 손목이 어긋남(하루 22장 실측: 6장이 한 손만, 손 점수 평균 0.32 → RGB 0.76). 참조 스크립트(cntest/dw_direct.py)는 이 BGR 실수를 그대로 가지고 있다.
  - 133점(COCO-WholeBody) → OpenPose 18점 변환(DWPose 방식): `neck = mean(kp[5], kp[6])`(두 어깨 점수 모두 >0.3일 때만 유효), `np.insert(kps, 17, neck, axis=1)` 후 `new[:, [1,2,3,4,6,7,8,9,10,12,13,14,15,16,17]] = new[:, [17,6,8,10,7,9,12,14,16,13,15,2,1,4,3]]`. 손: 변환 후 인덱스 92~112(왼손), 113~133(오른손) 각 21점. 얼굴 68점(24~91)은 쓰지 않음.
  - 점수 기준 0.3 미만 점은 없는 것으로 처리. 여러 명이면 기본은 **가장 큰 사람 1명**(박스 면적), 옵션으로 모두.
  - 실측: 전신 그림(하루 스프라이트)은 정확, 얼굴이 화면을 채우는 상반신 클로즈업은 부정확할 수 있음(도움말에 안내).

### 9.2 OpenPose 맵 그리기 규칙 (정확히 이 값 — 최종 맵은 **Python `vnlib.pose.draw` 한 곳에서만** 그림)
검은 배경 `W×H`. `k = min(W,H)/512`, `md = max(W,H)/k`.
- **선 굵기 스타일**은 ControlNet 모델마다 다르다(실측, §9.10):
  - `standard`(기본, noob_openpose 등 일반 OpenPose 학습 모델): `stick_scale = 1`
  - `thick`(xinsir 모델): `stick_scale = 1 if md < 500 else min(2 + floor(md/1000), 7)` (DWPose `scale_stick_for_xinsr_cn`과 같음)
  - 모델 → 스타일·권장 강도 표는 `vnlib.pose.CONTROLNETS = {"noob_openpose.safetensors": {"style": "standard", "strength": 1.0, "label": "NoobAI OpenPose (WAI·NoobAI 권장)"}, "controlnet-openpose-sdxl-1.0.safetensors": {"style": "thick", "strength": 1.2, "label": "xinsir OpenPose (SDXL 범용)"}}`, 표에 없는 모델은 `standard`/1.0.
- 몸통 선 17개 `limbSeq`(1부터 셈): `[2,3],[2,6],[3,4],[4,5],[6,7],[7,8],[2,9],[9,10],[10,11],[2,12],[12,13],[13,14],[2,1],[1,15],[15,17],[1,16],[16,18]`
- 색 18개(RGB): `[255,0,0],[255,85,0],[255,170,0],[255,255,0],[170,255,0],[85,255,0],[0,255,0],[0,255,85],[0,255,170],[0,255,255],[0,170,255],[0,85,255],[0,0,255],[85,0,255],[170,0,255],[255,0,255],[255,0,170],[255,0,85]`
- 선 i: 두 점을 잇는 **채운 타원**(중심=중점, 긴 반지름=길이/2, 짧은 반지름=`4*stick_scale*k`, 각도=선 방향), 색 = colors[i] × 0.6. 먼저 모든 선, 그다음 점.
- 점 j: 반지름 `round(4*k)` 채운 원, 색 = colors[j]. 없는 점은 건너뛰고 그 점을 쓰는 선도 건너뜀.
- 손(선택): 21점, 선 20개 `[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[0,9],[9,10],[10,11],[11,12],[0,13],[13,14],[14,15],[15,16],[0,17],[17,18],[18,19],[19,20]`, 선 i 색 = HSV(i/20, 1, 1)→RGB, 굵기 `max(1, round(2*k))`, 점 = 반지름 `round(4*k)` 파란색 `[0,0,255]`.
- 18점 순서: 0 코, 1 목(두 어깨 중점), 2 오른어깨, 3 오른팔꿈치, 4 오른손목, 5 왼어깨, 6 왼팔꿈치, 7 왼손목, 8 오른엉덩이, 9 오른무릎, 10 오른발목, 11 왼엉덩이, 12 왼무릎, 13 왼발목, 14 오른눈, 15 왼눈, 16 오른귀, 17 왼귀. **오른쪽/왼쪽은 인물 기준**(정면이면 인물의 오른쪽이 화면 왼쪽).
- 이 규칙으로 그린 832×1216 맵이 WAI + ControlNet에서 자세를 따라가는 것을 확인함(§9.10).
- 3D 뷰어(JS)는 **키포인트만** 만들어 서버로 보내고(최종 맵은 서버가 스타일별로 그림), 화면 겹쳐 보기(overlay)·미리보기용으로만 같은 규칙(standard)으로 직접 그린다.
- (구현 메모) 좌표는 `int(x·W)`(DWPose와 같은 버림), 짧은 반지름 `int(4·stick_scale·k)`, 손 선 색 = HSV→RGB×255 반올림. 몸통·손 선은 참조 구현(cntest/dw_direct.py)과 픽셀 단위로 같다.
  단, 참조 스크립트는 손 점을 BGR 뒤집기 실수로 **빨강**으로 그렸고, `vnlib.pose.draw`는 이 규칙대로(=DWPose `draw_handpose`) **파랑** `[0,0,255]`.

### 9.3 포즈 파일 (포즈 라이브러리)
- 위치: `input/poses/` (ComfyUI 입력 폴더 = `VN-Pipeline/input`, start.sh `--input-directory`). LoadImage는 `poses/<파일>`처럼 하위 폴더 경로를 받는다(VALIDATE_INPUTS가 실제 존재만 검사).
- 이름: `pose_YYYYmmdd_HHMMSS_<4hex>.png` = **standard 맵**, 같은 이름 `.thick.png` = thick 맵, `.json` = 메타+키포인트, 선택 `.src.jpg` = 원본/렌더 미리보기.
  - 메타: `{name, width, height, source: "3d"|"image"|"upload", origin: "파일/모델 이름", view?, framing?, clip?, people, hands: bool, created, keypoints: {people: [{body: [[x,y]|null ×18], left_hand: [[x,y]|null ×21]|null, right_hand: …}]}}` — 좌표는 0~1 정규화(맵 크기 기준).
  - `source: "upload"`(다른 도구에서 만든 OpenPose 그림을 그대로 올린 경우)는 키포인트가 없으므로 `.thick.png`도 없고, 두 스타일 모두 그 파일을 쓴다.
- 삭제는 `user/trash/poses/`로 이동.

### 9.4 `vnlib/pose.py` (신규, CLI·Studio 공용; numpy, cv2, Pillow, onnxruntime)
- `POSE_DIR`, `PoseError`(한국어, `.kind`: `unavailable|not_found|image|no_person|error`).
- `list_poses() -> [meta + {name, size}]`(최신순), `load_meta(name)`, `save_pose(png_bytes, meta, src_bytes=None) -> meta`(PNG 검증: 디코드 가능·512~2048, 맵 크기 = 메타 크기), `delete_pose(name)`, `pose_path(name)`(이름 검증: `^pose_[0-9_]+_[0-9a-f]{4}\.png$` 또는 사용자가 넣은 파일도 허용하려면 `[\w.-]+\.png`, 경로 탈출 금지).
- `detect(image: PIL.Image, width=None, height=None, hands=True, all_people=False) -> {"keypoints": {...정규화...}, "people": n, "size": [W, H], "cropped": bool}` (맵은 `save_pose`가 그림): 감지 결과를 원본 비율 그대로 목표 크기(지정 없으면 원본 크기를 8의 배수로, 긴 변 최대 2048)로 그려 반환. 목표 비율이 원본과 다르면 **가운데 기준으로 잘라 맞춤**(ComfyUI의 center crop과 같은 방식)하고 결과에 `cropped: true`.
  - 세션은 지연 로드·캐시·스레드 안전(lock). 사람 없음 → `PoseError(kind="no_person", "사람(인물)을 찾지 못했습니다 …")`.
- `draw(keypoints, W, H, hands=True, style="standard") -> np.ndarray(RGB)` (§9.2 규칙). `save_pose(meta, keypoints=None, map_png=None, src_bytes=None)`: 키포인트가 있으면 standard·thick 두 맵을 그려 저장, 없으면(`upload`) map_png를 그대로 저장.
- `variant_for(pose_name, controlnet_name) -> "poses/<name>.png" | "poses/<name>.thick.png"` (모델 스타일에 맞는 맵, thick 파일이 없으면 standard).
- `fit_size(w, h) -> (w8, h8)`: 512~2048, 8의 배수.
- (구현 메모 — 명세와 다른 점) **감지 기본 크기**(width/height를 안 주면)는 "원본 크기"가 아니라 `gen_size(원본)`:
  비율이 `config.SIZES` 프리셋과 같으면(±1.5%) 그 크기, 아니면 넓이를 약 1024²에 맞춰(1024²의 0.85~1.1배 밖이면 줄이거나 키움) `fit_size`. 갤러리의 하이레즈 결과(1248×1824)에서
  감지하면 832×1216 맵이 된다 — 원본 크기 그대로면 그 크기로 1차 생성(+하이레즈 1.5배 = 1872×2736)이 되어 SDXL에서 몸이 겹치고 매우 느리거나 메모리 부족.
  키포인트는 0~1 정규화라 맵 크기를 줄여도 자세는 같다. 작은 그림도 키운다 — SD1.5용 512×768 포즈 그림·600×900 참고 그림 → 832×1248
  (원본 크기 그대로면 SDXL을 0.4~0.5메가픽셀로 생성해 흐리고 형태가 무너짐). 8의 배수로 맞춘 결과도 다시 프리셋·넓이를 확인해 `gen_size(gen_size(x)) == gen_size(x)`(감지한 맵 크기 = 생성 크기).
- (구현 메모) 그 밖의 공개 함수·상수: `INPUT_DIR`, `TRASH_DIR`(user/trash/poses), `CONTROLNETS`, `DEFAULT_CONTROLNET`, `MIN_SIDE/MAX_SIDE`(512/2048),
  `normalize_name(name)`('pose_x.png'·'poses/pose_x.png'·'input/poses/pose_x.png'·input/poses 안 절대경로 → 'pose_x.png', 그 밖은 `PoseError(kind="invalid")`),
  `valid_name`, `base_name_of("poses/x.thick.png") -> "x.png"`, `pose_path(name, variant="standard"|"thick"|"json"|"src")`, `style_for(cn)`, `recommended_strength(cn)`,
  `list_controlnets() -> [{name, path, size, style, strength, label, known}]`(표에 있는 것 먼저), `gen_size(w, h)`, `crop_box(ow, oh, W, H)`(ComfyUI center crop 계산),
  `png_size(path)`(IHDR만 읽음 — Pillow 없는 python3에서도 graphs가 동작), `runtime_error()`/`detect_error()`(DWPose 모델·코드 파일까지 확인) → 한국어|None,
  `open_image(path|bytes)`(50MP 제한), `to_rgb`, `preview_jpeg(image, W, H)`(맵과 같은 영역을 가운데 자르기 → 긴 변 1024 이하 JPEG, 겹쳐 보기용),
  `clean_keypoints(kp, hands)`(형식 검증: 몸 18점·손 21점, [x,y]|null; ±0.01 밖은 화면 밖으로 보고 생략; 빈 사람 제거), `encode_png`, `read_map_image`, `loaded()`, `unload()`, `exists(name)`.
  `PoseError.kind`에 `invalid`(이름·키포인트·크기 형식 → 400) 추가.
  `detect()` 결과 추가 필드: `detected`(감지된 사람 수), `elapsed`, `cold`. 관절이 2개 미만이고 손도 없는 사람(잘린 영역 밖 등)은 버리고, 남는 사람이 없으면 `no_person`.
  사람 상자(YOLOX 점수 0.3 초과, DWPose와 같음)가 하나도 없으면 — 인물이 세로를 거의 꽉 채운 시안(832×1216 전신, 흰 배경)은 점수가 0.03 안팎이라 이 경우가 흔함 —
  ① 그림을 2배 흰 캔버스 가운데에 놓고 다시 감지(상자는 원본 좌표로 되돌려 잘라 냄, 같은 그림이 0.79) ② 두 번 중 가장 좋은 상자(점수 0.02 이상) ③ 그림 전체를 상자로,
  순서로 시도하고 관절 추정은 언제나 원본 그림에서 한다. 결과 `box`: `"detector"|"padded"|"weak"|"whole"`(API 응답에는 넣지 않고 로그에만), `detected`는 ③이면 0.
  사람이 없는 그림(단색·노이즈 등)은 ③에서 관절이 2개 미만이라 그대로 `no_person`.
  `cropped`는 한쪽이 1% 넘게 잘릴 때만 true — 8의 배수 맞춤으로 몇 픽셀 잘리는 것(예: 2110×800 → 1656×624)은 false.
  `save_pose(meta, keypoints=None, map_png=None, src_bytes=None) -> meta`(아래 시그니처가 정본). JSON 메타 추가 필드: `cropped`, `detected`(감지에서 만든 경우).
  목록·`load_meta`는 JSON이 없거나 깨진 PNG(사용자가 직접 넣은 그림)도 `source: "upload"`로 보여 준다. 같은 이름 JSON이라도 `source`가 `3d|image|upload`가 아니면
  (OpenPose 편집기·ControlNet 'JSON 내려받기' 등 다른 도구의 JSON) 무시하고 업로드 그림으로 본다. 메타 값은 형식을 맞춘다: width·height가 양의 정수가 아니면 PNG 헤더,
  created가 숫자가 아니면 파일 수정 시각, people은 정수만, 문자열 필드(origin·view·framing·clip)가 문자열이 아니면 버림, 키포인트는 `clean_keypoints` 통과 못 하면 null — 손으로 고친 JSON 하나 때문에 목록 전체가 죽지 않게. 저장 순서는 thick → src → json → standard(.png, 마지막) — 반쯤 저장된 포즈가 목록에 안 보이게.
  첫 감지는 모델 로드 포함 약 1~9초(외장 SSD 캐시 상태에 따라), 이후 1장 약 0.2초.

### 9.5 생성 그래프 (`vnlib/graphs.py`)
- JobSpec에 `pose`: `{"name": "pose_….png", "strength": 1.0, "end": 1.0, "model": "<controlnet 파일명>"?}` — 그래프는 `pose.variant_for(name, model)`로 스타일에 맞는 맵 파일을 LoadImage에 넣는다 (prompt·concept·cg·sprite 모드. **bg는 무시**하고 summary에 언급).
- `Ctx.render()`의 **1차 생성(KSampler)에만** ControlNet 적용: `LoadImage("포즈 불러오기", image)` → (생성 크기와 다르면) `ImageScale("포즈 크기 맞춤", upscale_method="lanczos", width=w, height=h, crop="center")` → `ControlNetLoader("ControlNet 로드")`(한 번만) → `ControlNetApplyAdvanced("포즈 적용", positive, negative, control_net, image, strength, start_percent=0, end_percent=end, vae)` → 1차 KSampler의 positive/negative로. 하이레즈 리파인·얼굴/손 보정은 **원래 conditioning**(포즈 없이) — 이미 자세가 잡힌 그림을 다듬는 단계라 불필요하고 느려짐.
  - 스프라이트: 기본 포즈(base) 1차 생성에만. 표정은 그 위 인페인트라 영향 없음.
- 크기: `pose`가 있고 `size`가 비어 있으면 **포즈 이미지 크기**를 사용(`config.ROOT/"input"/image`를 Pillow로 열어 크기 읽기, `fit_size`). `size`가 있으면 그 크기 + 위 ImageScale(center crop).
- 검증: 포즈 파일 없음 → `JobError("포즈 파일을 찾을 수 없습니다: …")`, 경로 탈출 금지. ControlNet 파일 없음 → 기존 check_models 경로로 한국어 오류. 프리셋이 SDXL이 아니면(체크포인트 arch) `JobError`.
- settings 추가: `pose_model`(기본 `noob_openpose.safetensors`, 설치된 ControlNet 파일명), `pose_strength` 1.0 (0.1~2.0), `pose_end` 1.0 (0.1~1.0). `library.SETTING_RULES`. UI에서 ControlNet을 바꾸면 그 모델의 권장 강도(`CONTROLNETS[...].strength`)로 슬라이더를 옮겨 준다.
- ControlNet을 쓰면 1차 생성이 약 40% 느려진다(실측 3.4 → 4.9 s/it). ETA 계산(프런트 eta.js)에 반영.
- (구현 메모) `pose`는 이름 문자열만 줘도 된다. 빈 `strength`: `model`이 settings.pose_model과 같으면 settings.pose_strength, 다른 모델이면 그 모델 권장 강도(`CONTROLNETS`, 표에 없으면 1.0).
  빈 `end`: settings.pose_end. `size`가 비어 있을 때의 생성 크기는 `pose.gen_size(포즈 크기)`(우리가 만든 맵은 이미 SDXL 크기라 그대로, 넓이가 1메가픽셀에서 먼 업로드 그림만 약 1024²로 줄이거나 키움).
  노드: `LoadImage`("포즈 불러오기", 그래프에 1개) → (크기가 다르면) `ImageScale`("포즈 크기 맞춤", 크기별 1개) → `ControlNetLoader`("ControlNet 로드", 1개) → 1차 생성마다 `ControlNetApplyAdvanced`("포즈 적용").
  `graphs.build()` 반환에 `"pose": {name, image, model, strength, end, size: [w, h], gen_size: [w, h]} | None`(실제 적용값) 추가. `graphs.resolve_pose(job, settings, preset_name, preset)`, `graphs.POSE_STRENGTH/POSE_END`.
  SDXL 검사는 `modelinfo.checkpoint_info`의 arch가 SDXL·unknown이 아니면 JobError. ControlNet 파일 존재는 graphs가 아니라 Studio `check_models`(CLI는 `--pose-model`을 인자 단계에서 검사).
  생성 그래프는 라이브 `/object_info`로 모드 5종 × 포즈(없음/standard/xinsir=thick/가로 포즈/업로드/크기 다름) × 하이레즈·얼굴·손·업스케일 토글 × wai·noob 프리셋 576가지를 검증함.

### 9.6 CLI
- `vn.py <prompt|concept|cg|sprite> … --pose poses/파일.png [--pose-strength 0.8] [--pose-end 0.8] [--pose-model 파일]`
- `vn.py pose detect <이미지> [--size 832x1216] [--all] [--no-hands]` → `input/poses/`에 저장하고 이름 출력. `vn.py pose list`.
- (구현 메모) `--size`는 `832x1216` 또는 크기 프리셋 이름(portrait 등). 이미지 여러 개 가능. numpy·cv2·onnxruntime이 없는 python3면 엔진 Python으로 다시 실행(tag와 같음).
  `--pose`는 `poses/파일.png`·`파일.png`·`input/poses/파일.png` 모두 허용. `--pose-*`는 `--pose` 없이 쓰면 오류. bg 모드에서는 "포즈: 배경 모드에서는 쓰지 않습니다" 출력.

### 9.7 백엔드 API (`studio/poses.py` 신규 + `server.py`)
- `GET /api/poses` → `{poses: [{name, width, height, source, origin, created, url, thumb, src_url|null, people, hands}]}` (최신순)
- `GET /poses/{name}` (맵 PNG), `GET /poses/{name}/src` (원본 미리보기, 없으면 404). `safe_path(POSE_DIR)`.
- `POST /api/poses` (multipart): ① 3D — `keypoints`(JSON 문자열, §9.3 형식), `width`, `height`, 선택 `src`(PNG/JPEG 렌더), 필드 `origin, view, framing, clip` → 서버가 두 스타일 맵을 그려 저장. ② 업로드 — `pose`(이미 그려진 OpenPose PNG) → `source: upload`로 그대로 저장. 20MB 제한(§8 interrogate와 같은 방식).
- `POST /api/poses/detect`: multipart `image` 또는 JSON `{path}`(output/ 상대), 선택 `width, height, all_people, hands` → `vnlib.pose.detect`를 스레드에서(전역 lock) → 저장(src = 원본 축소본) → 항목 + `{people, cropped}`. 사람 없음 → 422 한국어.
- `DELETE /api/poses/{name}` → 휴지통.
- `/api/models`에 `controlnets: [{name, size, style, strength, label}]` 추가(`CONTROLNETS` 표 + 설치 목록). `jobs.sanitize_spec`이 `pose`를 허용·검증(이미지 이름 형식, 숫자 범위). `check_models`에 ControlNetLoader(controlnet 폴더) 추가.
- 갤러리 정보(`/api/gallery/info`)에 사용한 포즈(이름·강도) 표시용 필드 `pose`.
- (구현 메모 — 정확한 응답 모양)
  - 포즈 항목: `{name, width, height, source, origin, created(epoch 초), url: "/poses/<name>", thumb(= url), src_url: "/poses/<name>/src"|null, people(업로드는 null), hands,
    has_thick, gen_size: [w, h](이 포즈로 생성할 때 쓰는 기본 크기), size(파일 바이트, 저장 직후 응답은 null), view?, framing?, clip?, cropped?, detected?}`.
  - `GET /api/poses` → `{poses: [항목…], dir, detect_available: bool, detect_error?: 한국어, loaded: bool}`. 목록에는 키포인트를 넣지 않는다.
  - `GET /api/poses/{name}` (추가) → 항목 + `keypoints`. 없으면 404, 이름 형식 오류 400.
  - `POST /api/poses`: multipart 필드 `keypoints`(JSON 문자열, 1MB 이하)·`width`·`height`(512~2048 정수)·선택 `src`·`origin`·`view`·`framing`·`clip`·`hands`(false면 손 빼고 그림)·`source`(3d 기본|image),
    또는 `pose`(OpenPose 그림, PNG/JPEG/WEBP 등, 투명은 검은 배경에 합성, 512~2048 밖이면 비율을 지켜 맞춘 뒤 저장; 선택 `src`·`origin`(기본: 파일명)).
    같은 내용을 JSON 본문으로도 받는다(src 없이, `keypoints`는 객체 그대로). 응답 = 항목(평평한 객체).
  - `POST /api/poses/detect`: multipart `image` + 선택 `width`·`height`(둘 다 또는 둘 다 없음)·`all_people`·`hands`·`origin`, 또는 JSON `{path, width?, height?, all_people?, hands?, origin?}`.
    선택 `view`·`framing`·`clip`(문자열, `POST /api/poses`와 같음)·`source`(`image` 기본|`3d`): 3D 모델의 관절 매핑이 안 돼 렌더 그림에서 감지할 때(렌더에서 감지)
    각도·프레이밍·동작을 메타에 저장해 카드·고르기 창이 3D 포즈로 보여 준다. 다른 source 값은 400.
    응답 = 항목 + `{people, cropped, detected, elapsed, cold, path?}`(평평한 객체). 원본 미리보기(`src`)는 맵과 같은 영역(가운데 자름)이라 겹쳐 보기가 정확히 맞는다.
  - 오류: 이름·키포인트·크기 형식 400(`reason: "invalid"`), 이미지 못 읽음 400(`image`), 포즈 없음 404, 사람 없음 422(`no_person`), 감지 불가 503(`unavailable`, `help: "pose"`),
    파일 20MB 초과 413, 원본 이미지를 본문 그대로 415, path 탈출 403. `DELETE` → `{ok, name, moved: [파일…], trash}`.
    대기 중·진행 중 작업(`JobManager.active`의 `job.pose.name`, 없으면 `spec.pose.name`)이 그 포즈를 쓰면 `DELETE`는 409(`reason: "in_use"`, "대기 중이거나 진행 중인 작업 N개가 이 포즈를 쓰고 있습니다…") —
    ComfyUI는 LoadImage 파일을 제출 때만 확인하고 실행할 때 다시 읽으므로, 지우면 대기열의 작업이 '포즈 불러오기' 단계에서 FileNotFoundError로 실패한다.
    (그래도 Finder에서 지운 경우 실행 오류에 '포즈 파일이 삭제되었거나 옮겨졌습니다' 안내를 붙인다 — `jobs._hint`.)
  - 감지 모델은 마지막 사용 15분 뒤 메모리에서 내린다(tagging과 같은 방식). `POST /api/open-folder`의 `which`에 `poses`, `models_controlnet` 추가.
  - `/api/models`의 `controlnets` 항목: `{name, path, size, style, strength, label, known}`. `model_dirs`·`install_dir`에 `controlnet` 추가.
  - Job 객체에 `pose`(graphs가 실제 적용한 `{name, image, model, strength, end, size, gen_size}` | null) 추가 — `size`는 맵 크기, `gen_size`는 `spec.size`가 비어 있을 때 쓰는 생성 크기(`pose.gen_size(size)`; 이 필드가 없는 예전 기록은 프런트가 같은 계산으로 구함). `spec.pose`는 sanitize된 입력 그대로(`{name, strength?, end?, model?}`).
    진행률 가중치: ControlNet을 받는 샘플러는 스텝 가중치 ×1.4(`jobs.graph_weights`, `CONTROLNET_SLOWDOWN`). `ControlNetLoader`는 2.0
    (2.5GB — ComfyUI 캐시에 없으면 외장 SSD에서 1분 가까이 걸림; 캐시되면 가중치 합에서 빠짐. 로더는 단계 진행을 보내지 않아 로드가 끝날 때 막대가 한 번에 오른다).
  - `/api/gallery/info`의 `pose`: `{name, model, strength, end, exists: bool, url|null, src_url|null}` | null — 작업 기록(실제 적용값) → spec → PNG 그래프(ControlNetApply* → LoadImage/ControlNetLoader) 순.
    포즈 파일이 지워졌으면 `exists: false`(프런트는 안내 후 포즈 없이). PNG 그래프 해석에서 ControlNetApplyAdvanced의 출력 1(negative)을 따라가도록 고쳐서,
    얼굴·손 보정이 꺼진 이미지의 부정 프롬프트가 긍정 프롬프트로 잘못 나오지 않는다.

### 9.8 3D 뷰어 추가 (`viewer3d.js`)
```js
info.poseAvailable   // 몸통 관절(목/어깨/팔꿈치/손목/엉덩이/무릎/발목/머리) 매핑 성공 여부
info.handsAvailable  // 손가락 뼈 매핑 성공 여부
viewer.capturePose({ width, height, view, framing, hands = true }) // → Promise<{ keypoints: {people:[{body, left_hand, right_hand}]} (0~1 정규화, §9.3), render: Blob(PNG, 같은 카메라·흰 배경), preview: Blob(standard 맵, JS로 그린 미리보기), missing: [관절 이름] }>
viewer.setPoseOverlay(on)  // 화면에 뼈대(§9.2 색) 겹쳐 보기
viewer.capture({ width, height, ... })  // 정사각이 아닌 크기도 지원하도록 확장(기존 size 인자는 그대로 동작)
```
- 비정사각 캡처: 카메라 aspect = width/height, 프레이밍은 그 비율 기준으로 다시 맞춤(전신이 잘리지 않게).
- 관절 매핑: 기존 `findBonesVRM/findBonesByName`를 확장 — VRM humanoid(neck, head, left/rightUpperArm·LowerArm·Hand, left/rightUpperLeg·LowerLeg·Foot, left/rightEye, 손가락 Thumb Metacarpal/Proximal/Distal, Index/Middle/Ring/Little Proximal/Intermediate/Distal), Mixamo(`mixamorig:Neck/Head/LeftArm/LeftForeArm/LeftHand/LeftUpLeg/LeftLeg/LeftFoot/LeftHandThumb1-4/…/HeadTop_End`), VRoid FBX(`J_Bip_L_UpperArm/LowerArm/Hand/UpperLeg/LowerLeg/Foot`, `J_Bip_C_Neck/Head`, `J_Adj_L_FaceEye`), UE(`upperarm_l/lowerarm_l/hand_l/thigh_l/calf_l/foot_l/neck_01/head`), MMD(`左腕/左ひじ/左手首/左足/左ひざ/左足首/首/頭/左目`, `腕`·`ひじ`·`手首` 등).
- 키포인트: 어깨=위팔 뼈 머리, 팔꿈치=아래팔 머리, 손목=손 머리, 엉덩이=허벅지 머리, 무릎=종아리 머리, 발목=발 머리, 목=두 어깨 중점(OpenPose 정의), 눈=눈 뼈(없으면 머리 위치+얼굴 앞·위·옆 오프셋 추정), 코=두 눈 중점에서 앞·아래, 귀=머리 좌우. 머리 크기는 목~머리 거리로 추정.
- 얼굴 점 가시성: 얼굴 앞 방향과 카메라 방향 내적으로 판단 — 뒤를 보면 코·눈 생략(귀만), 옆모습이면 먼 쪽 눈·귀 생략. 몸통 점은 가려져도 그린다(OpenPose와 같음).
- 손가락: 손가락 뼈가 있으면 21점(손목 + 손가락마다 4점, 끝점은 마지막 마디 방향으로 연장), 없으면 손 생략.
- 화면 밖 점은 생략. 모든 좌표는 capture와 **같은 카메라**로 투영해 맵과 렌더가 정확히 겹쳐야 함.
- 관절 매핑 실패 시 `poseAvailable=false` → 프런트가 "렌더 이미지에서 감지"(렌더 → `/api/poses/detect`)로 대체.

### 9.9 프런트엔드
- **프롬프트 추출 탭 → 3D 모델**: 도구 막대에 `[뼈대 보기]` 토글, `포즈 크기` 선택(세로 832×1216 / 가로 1216×832 / 와이드 1344×768 / 정사각 1024×1024, 기본 세로), `[포즈 저장]`, `[이 포즈로 생성…]`(저장 후 생성 탭으로 포즈 + (있으면) 추출한 프롬프트를 함께 보냄). `poseAvailable=false`면 두 버튼이 "렌더에서 감지" 경로로 동작하고 안내 문구 표시. 저장 성공 토스트에 [생성 탭으로].
  - 포즈를 만들 때 쓸모 있는 조작 안내: 애니메이션 클립·시간 슬라이더로 자세 고르기, 팔 내리기, 각도(정면/3/4/옆), 전신/상반신 프레이밍.
- **프롬프트 추출 탭 → 이미지**: `[이 그림에서 포즈 감지]` → `/api/poses/detect` → 결과 맵을 원본 위에 겹쳐 보기 토글 + `[생성 탭으로]`.
- **생성 탭**: LoRA 아래 `포즈 (ControlNet)` 묶음 — 포즈 카드(맵 썸네일, 원본 미리보기 hover, 이름·크기) + `[포즈 고르기]`(모달: `/api/poses` 그리드, 원본/뼈대 전환, 삭제, `[이미지에서 감지]` 업로드, `[3D에서 만들기]` 링크 → `#/extract`) + `[빼기]`; `강도` 슬라이더(0.1~2.0, 기본 settings.pose_strength, ControlNet을 바꾸면 그 모델 권장값으로), `적용 구간(끝)` 슬라이더(0.1~1.0), `ControlNet` select(설치 목록, 기본 settings.pose_model, 모델별 설명 툴팁). 포즈를 고르면 **크기를 포즈 크기로 자동 설정**(프리셋과 같으면 그 버튼, 아니면 사용자 지정 W×H) + 안내. 크기를 바꾸면 "포즈가 가운데 기준으로 잘립니다" 경고. ETA에 ControlNet 반영.
  - 이벤트 `generate:pose` `{name, prompt?}` — 미방문 탭도 받도록 pending 처리. 프롬프트가 같이 오면 기존 [되돌리기] 방식으로 교체.
- **캐릭터 탭 생성하기 패널**: 같은 포즈 선택 컴팩트 컨트롤(카드 + 강도) — 시안/스프라이트/CG에 공통 적용. 스프라이트는 "기본 포즈에만 적용" 안내.
- 작업 목록·갤러리 정보·라이트박스: 포즈 썸네일/이름 표시, [같은 설정으로 다시]·[생성 탭에서 편집]이 포즈를 유지(포즈 파일이 삭제됐으면 안내 후 포즈 없이).
- 모델·LoRA › 전역 설정: `포즈 (ControlNet)` 묶음 — 기본 ControlNet, 기본 강도, 기본 적용 구간.

### 9.10 기본값을 정한 실측 (A/B)
WAI v17, 빠른 모드(832×1216, 28스텝), 같은 시드·프롬프트("maid … full body, indoors, cafe" — 팔 동작 태그 없음), 참고 포즈 = DWPose(이 문서 방식)로 뽑은 '한 팔 번쩍 + 반대 손 허리 + 다리 벌림':
- ControlNet 없음: 자세 무관.
- xinsir, thick 선, 강도 0.8/끝 0.8 및 1.0/1.0: 다리·허리 손만 따라가고 **든 팔은 무시**. 강도 1.2/끝 1.0: 든 팔까지 따라감(쟁반을 든 모습으로 해석).
- noob_openpose, thick 선 0.8/0.8: 든 팔 무시. **standard(얇은) 선, 1.0/1.0: 든 팔(손 흔들기)·허리 손·다리 모두 정확**, 옷(긴 메이드 드레스)·구도도 프롬프트를 잘 지킴. → 기본값.
- ControlNet 사용 시 1차 생성 3.4 → 4.9 s/it (≈+40%), 빠른 모드 1장 ≈ 100초 → ≈ 200초.
- ComfyUI의 DWPreprocessor(OpenCV 대체 경로)는 뼈대를 엉뚱하게 그려 사용 불가 → 직접 감지.

### 9.11 도움말
- 새 가이드 `help/pose.html` "포즈 따라 그리기": ControlNet/OpenPose가 하는 일(뼈대 그림이 자세를 정함, 옷·얼굴은 프롬프트가 정함), 3D → 포즈 순서(모델 불러오기 → 클립/시간·팔 내리기·각도 → 뼈대 보기 → 포즈 저장/이 포즈로 생성), 이미지 → 포즈 감지(전신 그림이 정확, 클로즈업은 부정확, 여러 명이면 가장 큰 사람), 강도·적용 구간의 의미와 권장값(자세가 안 따라오면 강도↑/구간↑, 그림이 딱딱하거나 뭉개지면↓), ControlNet 두 종류 차이와 라이선스, 프롬프트 팁(자세와 모순되는 태그 빼기 — 예: 포즈는 서 있는데 `sitting`; 구도 태그를 포즈 프레이밍과 맞추기 `full body`/`upper body`), 한계(손가락은 손 뼈대가 있어야, 체형 비율이 극단적인 3D(SD 캐릭터)는 비율도 따라감, 느려짐 약 40%), CLI.
- tips 키: `pose, pose_pick, pose_strength, pose_end, pose_model, pose_fit, pose_overlay, pose_size, pose_save, pose_send, pose_detect, pose_library, set_pose_model, set_pose_strength, set_pose_end`.
- start/workflow/troubleshoot(포즈를 안 따라와요, 손이 이상해요, 감지 실패, ControlNet 파일 없음) 갱신, README 기능 요약.

## 10. 원격 접속 (Tailscale) + 휴대폰 화면 — 2026-11-09 추가

목적: 사용자가 **같은 테일넷의 다른 기기(Windows PC, Linux PC, iPhone)** 브라우저로 Studio에 접속해 이미지 생성까지 할 수 있게 한다. 사용자 결정: **HTTPS**(Tailscale Serve), 자동 실행·잠자기 방지는 **지금은 넣지 않음**(나중에 검토), **휴대폰에서도 생성까지** 편하게(모바일 레이아웃).

### 10.1 구조 (확인한 사실)
- Studio는 그대로 **127.0.0.1:8190에만** 바인드. 테일넷 노출은 `tailscale serve --bg --https=443 http://127.0.0.1:8190` 가 맡는다(테일넷 전용, 인터넷 공개 아님). **Funnel은 절대 쓰지 않는다.**
- Tailscale: `/Applications/Tailscale.app/Contents/MacOS/Tailscale` (1.102.4, PATH에 없음; `/usr/local/bin/tailscale`, `/opt/homebrew/bin/tailscale`도 후보). 이 Mac(예시): `my-mac`, MagicDNS `my-mac.tail1234.ts.net`, IP `100.x.y.z`. 테일넷 사용자 1명 `you@example.com`.
- `tailscale status --json`: `Self.DNSName`(끝의 `.` 제거), `Self.TailscaleIPs`, `MagicDNSSuffix`, `CurrentTailnet.Name`, `User{id: {LoginName, DisplayName}}`, `CertDomains`(null이면 **HTTPS 인증서 꺼짐** → 관리 화면 https://login.tailscale.com/admin/dns 에서 "HTTPS Certificates" 켜야 함), `BackendState`("Running").
- `tailscale serve status --json` 으로 현재 설정 확인, 끄기는 `tailscale serve --https=443 off`. `--bg` 설정은 재부팅 후에도 유지된다.
- 실측(테스트 포트 `--http`로 확인): Serve가 넘기는 요청은 **클라이언트 주소 127.0.0.1**, `Host: my-mac.tail1234.ts.net[:포트]`(원래 호스트 유지), `X-Forwarded-Host`(같음), `X-Forwarded-For: <원격 기기의 100.x IP>`, 그리고 신원 헤더 `Tailscale-User-Login: you@example.com`, `Tailscale-User-Name: =?utf-8?q?...?=`(RFC 2047 인코딩 → `email.header.decode_header`로 풀기), `Tailscale-User-Profile-Pic`, `Tailscale-Headers-Info`. IP로 직접 접속(`http://100.x.y.z:포트`)은 Serve가 404.
- HTTPS가 꺼진 상태에서 `tailscale serve --https=443 …`을 실행하면 CLI가 "The Tailscale GUI failed to start …"로 실패했다(관리 화면에서 켜야 함). → 백엔드는 이 상황을 `https_enabled=false`로 판별해 안내만 하고, 실행 결과 문자열도 사용자에게 보여 준다.

### 10.2 설정 (`vnlib/config.DEFAULT_SETTINGS` + `library.SETTING_RULES`)
- `remote_enabled` (bool, 기본 false) — Studio가 원격 요청을 받을지. Tailscale Serve 설정과 별개(둘 다 켜져야 접속됨).
- `remote_allowed_logins` (문자열 목록, 기본 `[]` → 비어 있으면 **켤 때 `tailscale status`의 테일넷 사용자 LoginName 전부**로 채움). 대소문자 무시 비교.
- `remote_hosts` (문자열 목록, 자동 — 켤 때 `Self.DNSName`과 짧은 이름 `my-mac`을 저장. 사용자가 편집할 일 없음).
- `studio_port`, `comfy_url`처럼 GUI의 일반 설정 저장으로는 바꿀 수 없음(원격 전용 API로만).

### 10.3 백엔드 (`studio/remote.py` 신규 + `server.py`)
- **요청 판별**(미들웨어 guard 확장): `host = request.host`의 호스트명(포트 제외, 소문자).
  - 로컬: `127.0.0.1` / `localhost` → 기존 규칙 그대로.
  - 원격 후보: 호스트명이 `remote_hosts`에 있거나(포트 무관), 요청에 `Tailscale-User-Login` 또는 `X-Forwarded-For`가 있으면 원격으로 본다.
    - `remote_enabled`가 false → 403 "원격 접속이 꺼져 있습니다. Mac의 VN Studio › 모델·LoRA › 전역 설정 › 원격 접속에서 켜세요."
    - 호스트명이 `remote_hosts`에 없음 → 403(DNS 리바인딩 방지 유지).
    - `Tailscale-User-Login` 없음 → 403 "테일넷 사용자 확인 헤더가 없습니다(Funnel·태그 기기 접속 차단)".
    - 로그인이 허용 목록에 없음 → 403 "허용되지 않은 사용자입니다: …".
  - 원격의 상태변경 요청 Origin: `https://<remote_host>` 또는 `http://<remote_host>[:포트]`만 허용(없으면 통과 — 기존 규칙과 같음).
  - 그 외 호스트 → 기존처럼 403.
  - `request["client"] = {"remote": bool, "login": str|None, "name": str|None, "ip": X-Forwarded-For|None}`.
- 403 응답: `/api/…`는 JSON, 그 외(브라우저 페이지 요청)는 **한국어 HTML 안내 페이지**(무엇을 하면 되는지).
- **원격에서 막는 동작**(로컬 전용, 403 + 이유): `POST /api/shutdown`("원격에서 종료하면 다시 켤 방법이 없습니다"), `POST /api/open-folder`, `POST /api/gallery/reveal`(Mac 화면에서 Finder가 열릴 뿐), 원격 설정 변경 API. 엔진 시작/중지/재시작·생성·삭제(휴지통)·다운로드·설정 저장은 허용.
- `GET /api/status`에 `client` 추가 + `remote: {enabled, url|null}` (URL = `https://<DNSName>/` — Serve 설정이 실제로 있을 때만).
- `GET /api/remote` → `{tailscale: {installed, path, running, backend_state, dns_name, short_name, ips, tailnet, users: [{login, name}], https_enabled}, serve: {configured, https: bool, target, url, raw?}, settings: {remote_enabled, remote_allowed_logins, remote_hosts}, client, warnings: [..]}` — `tailscale` 호출은 스레드 + 타임아웃 5초, 결과 10초 캐시.
- `POST /api/remote/enable` (로컬 전용): HTTPS 꺼져 있으면 409 + 안내(관리 화면 링크). 아니면 `tailscale serve --bg --https=443 http://127.0.0.1:<port>` 실행(타임아웃 20초) → 성공 시 `remote_enabled=true`, `remote_hosts`, (비어 있으면) `remote_allowed_logins` 저장 → `GET /api/remote` 결과 반환. 실패 시 CLI 출력 요약을 한국어 오류와 함께.
  - 이미 다른 HTTPS Serve 설정(다른 대상)이 443에 있으면 덮어쓰지 말고 409 + 설명.
- `POST /api/remote/disable` (로컬 전용): `tailscale serve --https=443 off`(우리 대상일 때만) + `remote_enabled=false`.
- `PUT /api/remote` (로컬 전용): `{remote_allowed_logins: [...]}` 검증(이메일 형태 또는 `*@도메인` 불허 — 정확한 로그인만), 최소 1개.
- Serve 없이 Studio만 켜도 원격 접속은 생기지 않음(바인드가 127.0.0.1) — 이 점을 도움말에 명시.
- 실행기: `studio.sh`·`stop_studio.sh`는 변경 없음(Serve는 Tailscale이 유지). Studio가 꺼져 있으면 원격 브라우저는 Tailscale의 502를 본다 → 도움말 문제 해결에 안내.
- **구현 메모 (실제 동작·정확한 필드, 위와 다르거나 더 구체적인 부분)** — `studio/remote.py`
  - 원격 표시 헤더는 `Tailscale-User-Login`·`X-Forwarded-For`에 더해 `Tailscale-User-Name`·`Tailscale-Funnel-Request`·`X-Forwarded-Host`·`Forwarded`도 본다. 하나라도 있으면 Host가 `127.0.0.1:<port>`여도 원격(→ 주소가 `remote_hosts`에 없으므로 403). `Tailscale-Funnel-Request`가 있으면 로그인 헤더가 있어도 `remote_identity` 403. 로그인 헤더도 RFC 2047로 올 수 있어 이름과 똑같이 푼다.
  - 원격 Origin은 `https://<remote_host>[:포트]`·`http://<remote_host>[:포트]` (https에도 포트 허용 — `--https=8443` 같은 Serve). 로컬 Origin 규칙은 그대로.
  - guard의 모든 403 = `/api/…`는 JSON `{"error", "code"}`, 그 밖은 한국어 HTML 안내(무엇을 하면 되는지 목록). `code`: `host`(모르는 Host, 기존 메시지 그대로) · `remote_disabled` · `remote_host` · `remote_identity` · `remote_login` · `origin` · `local_only`. 로컬 전용 판정은 aiohttp가 고른 라우트(`resource.canonical`)로 한다(경로 표기를 바꿔도 우회 불가).
  - `remote_*` 값은 settings.json의 mtime·크기·inode가 바뀔 때만 다시 읽는다(원격 요청마다 디스크를 읽지 않음). 손으로 고친 이상한 값은 꺼짐/비어 있음(`remote_enabled`는 JSON `true`일 때만 켜짐). 로컬 요청은 settings를 읽지 않는다.
  - `request["client"]`/`status.client` = `{"remote", "login", "name", "ip"}` (`ip` = `X-Forwarded-For`의 마지막 값). SSE도 같은 모양: 첫 `status`와 이후 방송되는 `status` 이벤트에 **그 연결의** `client`를 백엔드가 끼워 넣는다. `status.remote` = `{"enabled", "url"}` (url은 캐시만 사용; 원격이 켜져 있으면 `/api/status`가 10초 지난 캐시를 백그라운드로 갱신).
  - `tailscale` CLI는 asyncio 서브프로세스(스레드 아님, 새 세션)로 실행: status/serve status 5초, serve 켜기·끄기 20초. 시간 초과면 프로세스 그룹째 끝내고 그때까지의 출력을 보여 준다. 두 조회는 동시에, 결과는 10초 캐시(켜기·끄기 때는 강제 갱신).
  - `GET /api/remote` 추가 필드: `tailscale.{version, host_name, magic_dns_suffix, self_login, cert_domains, admin_url, error}`, `serve.{port, background, funnel, conflict, entries[{host,port,scheme,path,target,ours,funnel,background}], error}`, 최상위 `port`, `checked_at`. `serve.configured` = 루트(`/`)가 `http://127.0.0.1|localhost:<port>`를 프록시하는 Serve 설정이 있음(443 우선). `serve.conflict` = 443에 Studio가 아닌 것(다른 대상·다른 경로·TCP 포워딩)이 있으면 그 설명.
  - 테일넷 사용자(`tailscale.users`, 켤 때 허용 목록 자동 채우기) = 이 Mac과 피어 기기의 주인 중 로그인에 `@`가 있는 계정. 이 Mac을 공유받은 손님 기기(`ShareeNode`)의 주인·태그 기기(`tagged-devices`)는 뺀다.
  - `POST /api/remote/enable` 실패 코드: 409 `tailscale_missing`·`tailscale_stopped`·`no_magicdns`·`https_disabled`(+`admin_url`)·`serve_unknown`·`serve_conflict`(+`conflict`)·`no_users`, 500 `serve_failed`(+`output` 요약, `links` — CLI가 낸 https 링크). 이미 443에 우리 Serve가 있으면 CLI를 다시 실행하지 않고 설정만 저장. 성공 응답 = `GET /api/remote` 결과 + `ok`, `message`, `output`.
  - `POST /api/remote/disable`: `remote_enabled=false`를 **먼저** 저장(즉시 차단) → 443의 설정이 전부 Studio 것일 때만 `serve --https=443 off`. 끄기 실패는 200 + `warnings`(Studio는 이미 거부 중). `remote_hosts`·허용 목록은 다시 켤 때를 위해 남긴다. 응답 = 결과 + `ok`, `message`, `output`.
  - `PUT /api/remote`: `remote_allowed_logins`만 바꿈(`library.clean_remote_logins`: 문자열 목록, `*` 금지, `이름@도메인` 형태 — `octocat@github`처럼 점 없는 도메인 허용, 대소문자 무시 중복 제거, 1~50개). 응답 = 결과 + `ok`, `message`, `ignored`(무시한 다른 키). `library.REMOTE_KEYS`는 `PUT /api/settings`에서 항상 무시(`ignored`에 표시, 값이 같으면 생략).
  - 정적 파일 MIME에 `.webmanifest`(`application/manifest+json`) 추가.

### 10.4 프런트엔드 — 원격 표시·설정
- 상단 바: 원격일 때 `원격 · <이름>` 배지(툴팁: 로그인, 원격 IP). `⋯` 메뉴에서 로컬 전용 항목(폴더 열기류, Finder에서 보기, VN Studio 종료)은 원격일 때 **숨김** 또는 비활성 + 이유. 라이트박스 [Finder에서 보기]도 숨기고 [다운로드]를 앞에.
- 모델·LoRA › 전역 설정에 **원격 접속 (Tailscale)** 묶음(`js/remote.js` 신규):
  - 상태 줄: Tailscale 설치 / 연결 / HTTPS 인증서 / Serve / Studio 원격 허용 — 각 ✅/⚠️ + 해결 방법(HTTPS 꺼짐 → 관리 화면 버튼 + 단계 설명).
  - [원격 접속 켜기]/[끄기] (로컬에서만), 접속 주소 + [복사] + **QR 코드**(`/static/vendor/qrcode/qrcode.mjs`, `qrcode(0,'M')` → SVG/canvas; 휴대폰 카메라로 열기), 허용된 로그인 목록 편집.
  - 원격에서 열었을 때는 읽기 전용 + "설정 변경은 Mac에서" 안내.
- 휴대폰 홈 화면 앱: `manifest.webmanifest`(name "VN Studio", short_name "VN Studio", display "standalone", theme/background color 다크, start_url "/", 아이콘 192/512 PNG — `scripts/make_app.sh`가 쓰는 haru 시안 얼굴 크롭과 같은 방식으로 생성해 `studio/web/icons/`에 저장; 없으면 기존 SVG 파비콘 색으로 단색 아이콘), `apple-touch-icon`, `<meta name="apple-mobile-web-app-capable">`. 서비스 워커는 만들지 않음(오프라인 캐시 불필요).

### 10.5 프런트엔드 — 휴대폰 레이아웃 (세로 360~430px, 가로 ~900px)
- 기준: iPhone 13 Pro(390×844)·작은 안드로이드(360×740)에서 **가로 스크롤 없음, 모든 조작 가능, 탭 대상 최소 44px**, 입력 글자 16px 이상(iOS 확대 방지), `env(safe-area-inset-*)` 반영.
- 상단 바: 로고 아이콘만, 엔진 배지는 점+짧은 글자, 현재 작업 진행은 얇은 바, 나머지는 `⋯` 메뉴로. 탭 8개는 **하단 고정 탭 바**(아이콘+짧은 글자, 가로 스크롤 가능) 또는 상단 가로 스크롤 — 엄지로 닿게 하단 권장.
- 생성: 한 열. 프롬프트 → (접힘) 고급 → 캐릭터·프리셋 → LoRA → 포즈 → 크기·장수·시드 → 품질 토글. **[생성] 버튼은 화면 하단에 고정**(하단 탭 바 위), 예상 시간 함께. 실시간 미리보기·결과는 폼 아래 또는 생성 시작 시 자동으로 스크롤/시트로 표시.
- 캐릭터: 목록 → 편집(뒤로 버튼) 2단계. 생성하기 패널은 편집 폼 아래.
- 갤러리: 2열 그리드, 필터는 접기. 라이트박스: 전체 화면, **좌우 스와이프** 이동, 정보는 아래에서 올라오는 시트, 버튼은 줄바꿈.
- 작업: 카드형, 취소·재시도 버튼 크게.
- 프롬프트 추출: 한 열. 이미지 고르기는 `accept="image/*"`(카메라·사진 보관함), 3D는 동작은 하되 "휴대폰에서는 무거울 수 있음" 안내.
- 모델·LoRA·도움말: 한 열로 읽기 쉽게, 표는 가로 스크롤 상자 안에.
- ⓘ 툴팁은 탭으로 열고 닫기(호버 없음), 모달은 전체 화면 시트.
- 데스크톱(≥1024px) 레이아웃은 바뀌면 안 됨.

### 10.6 도움말
- 새 가이드 `help/remote.html` "원격 접속 (휴대폰·다른 PC)": 필요한 것(두 기기 모두 Tailscale 로그인, Mac 켜짐·잠자기 안 함·T7 연결·Studio 실행 중), 한 번만 하는 설정(관리 화면 HTTPS 켜기 — CT 로그에 기기 이름이 남는다는 점, Studio에서 [원격 접속 켜기]), 접속 방법(주소/QR, 휴대폰 홈 화면에 추가), 원격에서 안 되는 것(종료·Finder 열기)과 이유, 보안(테일넷 전용, Funnel 금지, 허용 로그인), 휴대폰 사용 팁(생성은 Mac이 하므로 휴대폰 배터리·성능 무관, 3D는 무거움), 문제 해결(접속 안 됨/502/403/느림/Mac 잠자기 — 자동 실행·잠자기 방지는 아직 없음, 수동 방법: 시스템 설정 › 배터리 › 전원 어댑터 연결 시 자동 잠자기 방지 / `caffeinate`).
- tips: `remote_status, remote_toggle, remote_url, remote_qr, remote_logins, remote_https`.
- start.html/troubleshoot.html/README 갱신.
