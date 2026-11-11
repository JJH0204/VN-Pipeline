# VN-Pipeline

ComfyUI로 연애 시뮬레이션·비주얼 노벨 에셋(캐릭터 시안, 표정 차분 스탠딩, 이벤트 CG, 배경)을 만드는 로컬 파이프라인입니다.
모든 생성은 이 Mac(M4 Pro, MPS)에서 처리되므로 API 비용이 들지 않습니다.

## 빠른 시작 — VN Studio (GUI)

**`VN Studio.app`을 더블클릭**하면 끝입니다. (Dock에 끌어다 두면 편합니다.)

- 서버(127.0.0.1:8190)가 뜨고 앱 창(Chrome 앱 모드, 없으면 기본 브라우저)이 열립니다.
- 생성 엔진(ComfyUI, 8188)은 Studio가 자동으로 켭니다. 첫 시작은 20~60초 걸립니다.
- 창을 닫아도 서버는 계속 돌아갑니다(진행 중 작업 유지). 완전히 끄려면 상단 `⋯` 메뉴 → **VN Studio 종료**.

터미널에서 실행하려면:

```bash
./studio.sh --open
```

```bash
scripts/stop_studio.sh
```

### 탭 구성

| 탭 | 하는 일 |
|---|---|
| 생성 | 프롬프트를 직접 입력해 그리기. 프리셋·LoRA·**포즈(ControlNet)**·크기·장수·시드·품질 단계 선택, 실시간 미리보기 |
| 캐릭터 | 캐릭터 만들기/편집(외형·의상·표정·시드·모델), 시안 → 스프라이트(투명 PNG) → CG까지 한 화면에서 (포즈 지정 가능) |
| 배경 | 인물 없는 배경 생성 |
| 스프라이트 시트 | 게임 캐릭터 애니메이션 시트: 동작(대기·걷기·달리기·공격·줍기·쓰러짐·휴식) × 4방향, 투명 PNG 격자(선택: 도트화) |
| 도트 | 픽셀 아트 리소스(캐릭터·아이템·배경)를 실제 픽셀 크기 PNG로 (팔레트 색 수·디더링·1비트 투명) |
| 아이콘 | 게임 UI 아이콘 세트: 한 줄에 하나, 같은 스타일·시드, 투명 PNG + 크기별(512~32px) |
| 프롬프트 추출 | 참고 이미지나 3D 모델(VRM·FBX·PMX 등)에서 Danbooru 태그를 뽑아 생성 탭·캐릭터 외형/의상으로 보내기, 같은 원본의 **자세를 포즈(뼈대 그림)로 저장** (엔진 불필요) |
| 갤러리 | 결과물 보기·검색·필터, 이미지별 프롬프트/시드/모델 정보, "같은 설정으로 다시", "고품질로 다시", "이 시드로 고정", "태그 추출" |
| 작업 | 대기열·진행률·취소·재시도, 엔진 로그 |
| 모델·LoRA | **프리셋 편집**(체크포인트, 샘플러, CFG, 스텝, 품질 태그, 기본 LoRA), 체크포인트 목록, **LoRA 메모**(트리거·기본 강도·설명·호환성 자동 판별), URL 다운로드, 전역 설정(품질·프롬프트 추출·포즈 기본값·**원격 접속**) |
| 도움말 | 사용법·프롬프트 작성법·모델/LoRA 설명·문제 해결 (모든 설정 옆 `i` 아이콘에도 설명이 있음) |

### 모델·LoRA를 직접 설정하는 법 (요약)

1. 체크포인트(.safetensors)를 `models/checkpoints/`에, LoRA를 `models/loras/`에 넣습니다. (모델·LoRA 탭의 **다운로드**에 Civitai/HuggingFace URL을 붙여 넣어도 됩니다.)
2. 모델·LoRA 탭 → **목록 새로고침**.
3. **프리셋** → **+ 새 프리셋**: 체크포인트를 고르고 모델 페이지의 권장 샘플러·CFG·스텝·품질 태그를 적습니다. v-prediction 모델은 자동 감지되어 **감지값 적용** 버튼이 나옵니다.
4. **LoRA** 카드에 트리거 단어·기본 강도·메모를 적어 두면 생성 화면에서 바로 쓸 수 있습니다. 베이스 모델과 맞지 않는 LoRA는 ❌/⚠️로 표시됩니다.

자세한 설명은 앱의 도움말 탭(모델·프리셋, LoRA 추가·사용, 품질 설정)을 보세요.

## 프롬프트 추출 (이미지·3D 모델 → 태그)

참고 그림이나 3D 캐릭터 모델을 넣으면 태거(`models/tagger/wd-eva02-large-tagger-v3`, SmilingWolf, Apache-2.0)가 그림을 읽어 **Danbooru 태그와 확률**을 뽑습니다. Studio 서버가 CPU로 처리하므로 엔진(ComfyUI)이 꺼져 있어도 되고, 1장에 약 1초 걸립니다. 넣은 파일은 저장하거나 외부로 보내지 않습니다.

- **이미지**: 끌어다 놓기 / 클릭 / ⌘V 붙여넣기 / 갤러리에서 고르기 (png·jpg·webp·gif·bmp, 20MB까지). 갤러리 큰 이미지 보기의 **태그 추출** 버튼으로도 열립니다.
- **3D 모델**: `.vrm .glb .gltf .fbx .obj(+.mtl) .pmx .pmd`. 텍스처가 따로 있으면 **폴더 고르기**. 각도(정면·3/4·옆·뒤)·프레이밍(전신·상반신·얼굴)을 맞춰 1024px로 찍어 추출하며, **팔 내리기**(T자 자세 해제)와 **여러 각도로 추출**(태그별 최고 점수로 합침)을 지원합니다. VRM은 파일에 든 이용 조건(라이선스·상업 이용)을 함께 보여 줍니다.
- **결과**: 기준값 슬라이더(일반 0.35 / 캐릭터 0.85)와 그룹별 태그 칩(인원·외형·의상·표정·포즈·구도·배경·기타·제외 권장). `white background`, `tachi-e`, T자 자세의 `outstretched arms` 같은 '원본 특성' 태그는 기본으로 꺼져 있고, 3D 원본은 포즈·구도·배경도 꺼집니다. 최종 프롬프트를 **복사**하거나 **생성 탭으로 보내기**, **새 캐릭터로 만들기**, **기존 캐릭터에 적용…**(외형·의상 교체, 저장은 직접)으로 씁니다.
- **주의**: 머리색·눈 색은 조명에 따라 틀리기 쉬우니 직접 확인하세요. 남의 그림·3D 모델을 원본으로 쓸 때는 저작권과 이용 약관을 확인하세요.
- 다른 SmilingWolf v3 태거(`wd-vit-tagger-v3` 등)는 `models/tagger/<이름>/`에 `model.onnx`와 `selected_tags.csv`를 넣으면 모델·LoRA 탭 → 전역 설정 → 프롬프트 추출에서 고를 수 있습니다.

자세한 사용법·레시피·문제 해결은 앱의 도움말 탭 → **프롬프트 추출 (이미지·3D)** 을 보세요.

## 포즈 따라 그리기 (ControlNet OpenPose)

3D 모델이나 참고 그림의 **자세**를 OpenPose 뼈대 그림(포즈 맵)으로 만들어 두고, 생성할 때 SDXL ControlNet으로 그 자세를 따라 그리게 합니다. 팔다리 위치와 몸 방향은 포즈가, 얼굴·옷·장소·표정은 프롬프트가 정합니다.

- **3D → 포즈** (프롬프트 추출 탭 › 3D 모델): 애니메이션 클립·시간 슬라이더, 팔 내리기, 각도(정면·3/4·옆·뒤), 전신/상반신으로 자세를 잡고 **뼈대 보기**로 확인 → **포즈 크기**(세로 832×1216 / 가로 1216×832 / 와이드 1344×768 / 정사각 1024×1024) → **포즈 저장** 또는 **이 포즈로 생성…**(추출한 프롬프트와 함께 생성 탭으로). 관절은 모델의 뼈(VRM·Mixamo·VRoid FBX·UE·MMD 이름)에서 바로 계산하고, 뼈를 못 찾는 모델은 렌더 그림에서 감지합니다.
- **이미지 → 포즈** (프롬프트 추출 탭 › 이미지, 또는 생성 탭의 포즈 고르기 › 이미지에서 감지): **이 그림에서 포즈 감지** — DWPose ONNX를 Studio가 CPU로 직접 돌립니다(1장 0.3~0.7초, 엔진 불필요). 전신 그림이 정확하고, 얼굴이 화면을 채운 클로즈업은 부정확할 수 있으며, 여러 명이면 가장 큰 1명.
- **생성에 쓰기**: 생성 탭의 **포즈 (ControlNet)** 묶음(포즈 카드, 포즈 고르기, 빼기, 강도 0.1~2.0, 적용 구간(끝) 0.1~1.0, ControlNet 선택)과 캐릭터 탭 생성하기 패널(시안·스프라이트·CG, 스프라이트는 기본 포즈에만). 포즈를 고르면 생성 크기가 포즈 크기로 맞춰지고, 크기를 바꾸면 가운데 기준으로 잘립니다. 포즈는 1차 생성에만 적용되고 하이레즈·얼굴·손 보정은 원래대로입니다. 배경 탭은 포즈를 쓰지 않습니다.
- **ControlNet 2종** (약 2.5GB씩): `noob_openpose.safetensors`(기본, Laxhar, NoobAI·Illustrious 전용 학습, 얇은 선, 강도 1.0/구간 1.0) — 저장소에 라이선스 표기가 없어 NoobAI와 같은 **비상업** 조건으로 보는 것이 안전. `controlnet-openpose-sdxl-1.0.safetensors`(xinsir, SDXL 범용, Apache-2.0, 굵은 선, 강도 1.2 이상). 포즈마다 얇은 선·굵은 선 맵을 함께 저장해 두고 고른 ControlNet에 맞는 쪽을 씁니다(파일 이름으로 판단하므로 이름을 바꾸지 마세요).
- **실측** (WAI v17, 빠른 미리보기, 같은 시드·프롬프트, "한 팔 번쩍 + 허리 손 + 다리 벌림" 포즈): NoobAI OpenPose + 얇은 선 1.0/1.0은 든 팔·허리 손·다리 모두 정확하고 옷·구도도 프롬프트대로. xinsir + 굵은 선은 0.8/0.8·1.0/1.0에서 든 팔을 무시, 1.2/1.0에서 따라감. ControlNet을 쓰면 1차 생성 3.4 → 4.9초/스텝(약 +40%), 빠른 미리보기 1장 약 100초 → 약 200초.
- **포즈 파일**: `input/poses/pose_YYYYmmdd_HHMMSS_xxxx.png`(얇은 선) + `.thick.png`(굵은 선) + `.json`(정보·관절 좌표) + `.src.jpg`(원본/렌더 미리보기). 삭제하면 `user/trash/poses/`로 이동.

자세한 사용법·강도 조절·프롬프트 팁·문제 해결은 앱의 도움말 탭 → **포즈 따라 그리기 (ControlNet)** 를 보세요.

## 원격 접속 (Tailscale — 휴대폰·다른 PC)

같은 Tailscale 테일넷에 있는 내 기기(iPhone, Windows·Linux PC 등)의 브라우저에서 **`https://<Mac 이름>.<테일넷>.ts.net/`**(원격 접속 설정 화면에 나오는 주소)으로 이 Mac의 Studio를 열어 생성까지 할 수 있습니다. 생성은 여전히 Mac이 하고, 휴대폰에서는 한 열 레이아웃(하단 탭, 하단 고정 생성 버튼, 2열 갤러리, 스와이프 라이트박스)으로 바뀝니다. 홈 화면에 추가하면 앱처럼 열립니다.

- **구조**: Studio는 그대로 `127.0.0.1:8190`에만 바인드. 테일넷 노출은 Tailscale Serve(`tailscale serve --bg --https=443 http://127.0.0.1:8190`)가 맡습니다(테일넷 전용, **Funnel은 쓰지 않음**). Serve 없이는 원격 접속이 생기지 않습니다.
- **느슨한 경계 — 앱을 연 동안만 열림**: 원격 접속은 Mac에서 **VN Studio.app으로 연 Studio**(`studio.sh --open` → `server.py --app`)에서만 받습니다. 앱으로 열면 Serve를 붙이고(원격 허용이 켜져 있을 때), Studio를 종료하면 Serve를 뗍니다. 터미널(`./studio.sh`)·자동 실행으로 켠 Studio는 로컬 전용이라 원격 요청은 403(`remote_no_app`)이고, 시작할 때 남아 있는 Serve도 걷어 냅니다. 그래서 테일넷 443 포트는 Mac에서 앱을 열어 둔 동안에만 열려 있습니다. 원격 허용 설정(`remote_enabled`)은 "앱으로 열면 원격도 연다"는 기본값으로 남습니다.
- **한 번만 하는 설정**
  1. 접속할 기기에 Tailscale 설치 → Mac과 **같은 계정**으로 로그인.
  2. 관리 화면 https://login.tailscale.com/admin/dns → (MagicDNS 켜짐 확인) → **HTTPS Certificates** → **Enable**. 기기 이름(`my-mac.tail1234.ts.net`)이 공개 인증서 투명성(CT) 로그에 남습니다(이름만 공개, 접속은 테일넷 안에서만).
  3. Mac의 Studio → 모델·LoRA › 전역 설정 › **원격 접속 (Tailscale)** → **원격 접속 켜기** → 접속 주소·복사·QR 코드. 상태 줄: Tailscale 설치 / Tailscale 연결 / HTTPS 인증서 / Tailscale Serve / Studio 원격 허용 (상단 `⋯` 메뉴 → 원격 접속 (Tailscale)로도 이동).
- **접근 제어**: Tailscale이 붙이는 `Tailscale-User-Login`을 **접속을 허용할 테일넷 로그인** 목록(처음 켤 때 테일넷 사용자 전부, 정확한 로그인만, 최소 1개)과 비교. 신원 헤더 없는 요청(Funnel·태그 기기), 다른 호스트 이름, 허용되지 않은 사용자는 403(한국어 안내 페이지). 설정은 `config/settings.json`의 `remote_enabled`·`remote_allowed_logins`·`remote_hosts`(원격 전용 API로만 변경, 서버 코드 `studio/remote.py`).
- **원격에서 막는 것**: VN Studio 종료(다시 켤 방법이 없음), 폴더 열기·Finder에서 보기(Mac 화면에서만 열림), 원격 접속 설정 변경. 엔진 시작/중지/재시작·생성·삭제(휴지통)·다운로드·설정 저장은 됩니다.
- **잠자기 방지**: 앱으로 열었고 원격 접속이 켜져 있으면 `studio.sh`가 서버와 함께 `caffeinate -i -w <서버 PID>`를 띄워 Studio가 도는 동안 유휴 잠자기를 막습니다(서버가 끝나면 같이 끝남). MacBook은 덮개를 닫으면 여전히 잠듭니다(전원 + 외장 모니터 클램셸 모드 제외).
- **자동 실행 (선택, 로컬 전용)**: `scripts/autostart.sh install` — 로그인할 때와 T7이 연결될 때 Studio를 자동으로 켭니다(LaunchAgent `com.vnpipeline.studio`). 자동 실행으로 켠 Studio는 앱 세션이 아니라 **원격 접속을 받지 않습니다**. 해제는 `scripts/autostart.sh uninstall`. 원격으로 쓰려면 재시동 후 Mac에서 VN Studio.app을 열어야 합니다.
- **문제 해결 요약**: 시간 초과 = Mac 잠자기·Tailscale 꺼짐, 접속 불가·502 = Studio 꺼짐 또는 앱으로 열지 않음(Mac에서 VN Studio.app 열기, T7 확인), 403 = 원격 허용 꺼짐·허용되지 않은 계정·앱이 아닌 방법으로 켠 Studio, 인증서 경고 = 전체 `https://` 주소가 아님. 끄기는 Mac에서 **원격 접속 끄기**(Serve 설정도 제거).

자세한 단계·보안·휴대폰 사용 팁·문제 해결은 앱의 도움말 탭 → **원격 접속 (휴대폰·다른 PC)** 을 보세요.

## 시크릿 모드 (테스트·시연용, 끄면 삭제)

테스트나 시연으로 만든 그림이 디스크에 쌓이지 않게 하는 모드입니다. 상단 바의 **시크릿** 버튼(또는 `⋯` 메뉴)으로 켭니다.

- **켜 둔 동안**: 새 작업은 시크릿으로 기록되고 그림은 `output/_secret/` 아래에 저장됩니다. 갤러리·캐릭터 탭·작업 탭에서 평소처럼 보이고, 썸네일에 **시크릿** 표시가 붙습니다. 상단 바 아래에 보라색 띠가 나옵니다.
- **끄거나 Studio를 종료하면**: 그동안의 작업 기록(DB), 그림, 썸네일, 실시간 미리보기, ComfyUI 실행 기록을 **휴지통을 거치지 않고** 지웁니다. 진행·대기 중인 시크릿 작업은 취소합니다. DB는 지운 내용이 파일에 남지 않게 덮어씁니다(`secure_delete` + WAL 정리). 로그에도 시크릿 작업의 프롬프트는 남기지 않습니다.
- **비정상 종료**(강제 종료·전원 끊김)로 지우지 못했으면 다음에 Studio를 시작할 때 지웁니다. 시크릿 모드는 서버 메모리에만 있어서 재시작하면 꺼진 상태로 시작합니다.
- **지우지 않는 것**: 캐릭터 설정, 프리셋, LoRA 메모, 저장한 포즈, 다운로드한 모델 같은 직접 저장한 설정. 남길 그림은 끄기 전에 라이트박스의 **다운로드**로 받아 두세요.
- 갤러리에서 시크릿 그림을 삭제하면 휴지통으로 옮기지 않고 바로 지웁니다.
- 서버 코드: `studio/secret.py`, API: `GET /api/secret`, `POST /api/secret/enable`, `POST /api/secret/disable`.

## 스프라이트 시트 · 도트 · 아이콘 (게임 리소스)

- **스프라이트 시트** (`sheet`): 동작마다 OpenPose 뼈대를 프레임별로 계산해(`vnlib/spritesheet.py`, 3D 뼈대를 정면·옆·뒤로 투영) 한 줄(동작 × 방향)의 프레임을 **한 장으로 함께** 그립니다(`multiple views` — 프레임끼리 캐릭터가 맞음). 줄은 같은 시드·캐릭터로 그리고, 왼쪽은 기본으로 오른쪽을 칸마다 좌우 반전합니다. 쓰러짐 동작과 뒷모습 줄은 한 장에 나란히 그리면 깨져서(누운 몸이 이어짐, 한 프레임이 정면) 프레임마다 따로 그립니다. 배경 제거 → (도트화) → 줄을 쌓아 `output/sheets/이름_칸가로x칸세로_열x줄_seed….png`. 칸 4프레임 384×576 / 6프레임 336×504, 줄 순서 = 동작 안에서 아래·왼쪽·오른쪽·위. 포즈 ControlNet(전역 설정의 포즈 기본값)이 필요합니다. 생성 1회 약 2~2.5분(걷기 × 4방향 4프레임 = 6회).
- **도트** (`pixel`): 1차 생성 → 면적 평균으로 실제 도트 크기까지 축소 → `ImageQuantize`(팔레트) → 투명이면 BiRefNet 마스크를 같이 줄여 1비트 알파. `output/pixel/이름_가로x세로_seed….png`. 1장 약 2분(실측 116초, 64×64·16색).
- **아이콘** (`icon`): 한 줄에 하나(`파일이름: 설명` 가능), 세트 전체가 같은 시드. 스타일 게임 아이템·플랫·앱 아이콘·도트. 앱 아이콘은 모델이 그린 심볼(배경 제거, 테두리에 맞춰 긴 변 64%)을 코드로 그린 둥근 사각형 색 타일(`input/icon_tiles/`, 8색·자동 순환)에 합성. 원본 `output/icons/세트/이름_seed….png` + 크기별 `output/icons/세트/<N>px/`.
- 세 모드 모두 ComfyUI 기본 노드만 씁니다(추가 설치 없음). 썸네일·라이트박스는 작은 그림을 최근접 확대로 보여 줍니다.

## 품질 파이프라인 (기본값)

1. 1차 생성 (832x1216)
2. 애니 업스케일러로 1.5배 확대한 뒤 2차 리파인 (하이레즈 픽스). 눈, 옷 주름, 라인이 정리되고 팔다리 오류도 상당수 교정됩니다.
3. 얼굴 보정: 얼굴을 감지해 확대한 뒤 다시 그립니다. 얼굴이 이미 크게 그려진 경우(상반신 등)에는 자동으로 건너뜁니다.
4. 손 보정: 손을 감지해 확대한 뒤 다시 그립니다.

GUI에서는 하이레즈/얼굴 보정/손 보정 토글로, CLI에서는 `--fast`(하이레즈 생략)·`--no-hands`(손 보정 생략)로 끌 수 있습니다.
강도(denoise)·스텝 등 기본값은 모델·LoRA 탭 → **전역 설정**에서 바꿉니다.

## 기본 프리셋

| 프리셋 | 특징 |
|---|---|
| `wai` (기본) | WAI-Illustrious v17. 깔끔한 애니 캐릭터 그림체이고 손과 팔다리가 안정적입니다 |
| `noob` | NoobAI-XL Vpred 1.0. 색감이 강하고 태그를 잘 따르지만, 그림체 편차가 큽니다 |
| `noob-hq` | `noob` + 품질 LoRA(`noobai_vpred_1_masterpieces_v23`, 0.7) |
| `noob-eps` | NoobAI-XL 1.1 (일반 eps 버전) |

## 소요 시간 (M4 Pro 24GB 기준, 1장당)

- 기본(하이레즈 + 얼굴 + 손): 약 4~5분
- 빠른 미리보기(보정 모두 끔): 약 1.5~2분
- 스프라이트 세트(스탠딩 + 표정 6종 + 투명 배경): 약 12분, 결과 해상도 1248x1824
- 포즈(ControlNet)를 붙이면 1차 생성이 약 40% 느려짐(빠른 미리보기 1장 약 100초 → 약 200초). 보정 단계 시간은 그대로

시안은 빠른 미리보기로 구도를 고른 뒤, 갤러리에서 **고품질로 다시**를 누르면 같은 시드로 품질 단계를 켜서 다시 만듭니다.

## 파일 구성

| 경로 | 내용 |
|---|---|
| `VN Studio.app`, `studio.sh` | GUI 실행기 |
| `studio/` | Studio 서버(`*.py`)와 웹 화면(`web/`), 도움말(`web/help/`) |
| `vnlib/` | CLI와 GUI가 함께 쓰는 생성 로직(워크플로 구성, 설정, 캐릭터, 모델 정보) |
| `config/presets.json` · `loras.json` · `settings.json` | 프리셋 / LoRA 메모 / 전역 설정 (GUI에서 편집) |
| `characters/*.json` | 캐릭터 파일 (GUI 캐릭터 탭에서 편집) |
| `output/` | 결과물 (`prompt/`, `<캐릭터ID>/concept|sprite|cg/`, `backgrounds/`, `sheets/`, `pixel/`, `icons/<세트>/`). 갤러리에서 삭제하면 `output/.trash/`로 이동 |
| `models/` | 체크포인트, LoRA, 임베딩(`embeddings/`), 업스케일러, 감지 모델, 프롬프트 추출용 태거(`tagger/<이름>/model.onnx` + `selected_tags.csv`) |
| `models/controlnet/` | 포즈용 ControlNet(`noob_openpose.safetensors`). xinsir `controlnet-openpose-sdxl-1.0.safetensors`는 엔진 폴더 `ComfyUI/models/controlnet/`에 있음(둘 다 인식) |
| `input/spritesheet/` | 스프라이트 시트용 포즈 맵(동작·방향·프레임별, 자동 생성·재사용) |
| `input/poses/` | 포즈 라이브러리(엔진 입력 폴더 = `input/`). 포즈마다 `.png`(얇은 선)·`.thick.png`(굵은 선)·`.json`·`.src.jpg`. 삭제하면 `user/trash/poses/`로 이동 |
| `studio/web/vendor/` | 3D 뷰어용 라이브러리(three.js r167, @pixiv/three-vrm 3.5.5, MIT)와 원격 접속 QR 코드용 qrcode-generator 2.0.4(MIT). 오프라인 동작을 위해 포함, 수정 금지 |
| `studio/web/manifest.webmanifest`, `studio/web/icons/` | 휴대폰 홈 화면에 추가할 때 쓰는 앱 정보와 아이콘(192/512 PNG) |
| `user/` | 로그(`server.log` 엔진, `studio.log` Studio), 작업 기록 DB, 썸네일 캐시 |
| `start.sh` | ComfyUI 엔진만 단독 실행 (Studio가 알아서 실행하므로 보통 필요 없음) |

## CLI (선택)

GUI와 같은 설정 파일을 공유합니다. ComfyUI가 켜져 있어야 합니다(Studio 또는 `./start.sh`). 단, `tag`와 `pose detect`·`pose list`는 엔진 없이 동작합니다.

```bash
python3 vn.py prompt "1girl, solo, maid, black hair, twintails, holding tray, cafe, smile" --n 4
```

```bash
python3 vn.py prompt
```

```bash
python3 vn.py prompt "waving, park, cherry blossoms" --char haru
```

| 모드 | 용도 | 예시 |
|---|---|---|
| `prompt` | 자유 프롬프트 (텍스트 없이 실행하면 대화형) | `vn.py prompt "태그..." --n 4` |
| `concept` | 캐릭터 시안 N장 | `vn.py concept haru --n 8` |
| `sprite` | 스탠딩 + 표정 차분 투명 PNG | `vn.py sprite haru` |
| `cg` | 이벤트 CG (1344x768) | `vn.py cg haru "장면 태그"` |
| `bg` | 배경, 인물 없음 | `vn.py bg "classroom, sunset" --name classroom` |
| `sheet` | 스프라이트 시트 (동작 × 4방향) | `vn.py sheet haru --motions walk,attack --frames 4 --cell-px 64` |
| `pixel` | 도트(픽셀 아트) | `vn.py pixel "red potion" --subject object --px 64 --colors 16` |
| `icon` | 아이콘 세트 (줄마다 1개, `;`로도 구분) | `vn.py icon "sword;shield;gold coin" --style game --name rpg_items` |
| `export` | ComfyUI 화면용 워크플로 JSON을 `workflows/`에 저장 | `vn.py export haru` |
| `tag` | 이미지에서 Danbooru 태그 추출 (그룹별 점수 + 최종 프롬프트 한 줄, 엔진 불필요) | `vn.py tag 그림.png --threshold 0.35` |
| `pose detect` | 그림에서 자세를 감지해 `input/poses/`에 저장하고 이름 출력 (엔진 불필요) | `vn.py pose detect 그림.png --size 832x1216` |
| `pose list` | 저장된 포즈 목록 | `vn.py pose list` |

캐릭터는 ID(`haru`) 또는 JSON 경로 모두 됩니다. 옵션: `--model <프리셋>`, `--lora 파일명:강도`, `--n`, `--seed`, `--size portrait|landscape|wide|tall|square`, `--fast`, `--no-hands`, `--upscale`, `--neg`, `--raw`.

포즈: `prompt`·`concept`·`cg`·`sprite`에 `--pose poses/파일.png [--pose-strength 1.0] [--pose-end 1.0] [--pose-model 파일]`(생략한 값은 전역 설정의 기본값). `pose detect` 옵션: `--size WxH`(생략하면 원본 비율의 SDXL 생성 크기: 비율이 기본 크기와 같으면 그 크기(예: 1248×1824 → 832×1216), 아니면 약 1메가픽셀 이하·8의 배수. 비율이 다르면 가운데 기준으로 잘라 맞춤), `--all`(모든 사람), `--no-hands`(손 뼈대 빼기).

`tag` 옵션: `--threshold`(일반 태그, 기본 0.35), `--char-threshold`(캐릭터 태그, 기본 0.85), `--model <태거 폴더 이름>`, `--all`(제외 권장 태그까지 출력). 태거에 필요한 onnxruntime·Pillow·numpy(`pose detect`는 OpenCV도)는 엔진 Python에만 있으므로, `python3`에서 모듈이 없다는 오류가 나면 엔진 Python으로 실행하세요:

```bash
/Volumes/T7/ComfyUI/Installs/ComfyUI/standalone-env/bin/python vn.py tag output/haru/sprite/haru_smile_00001_.png
```

## 라이선스 주의

이 저장소의 코드는 [MIT 라이선스](LICENSE)입니다. `studio/web/vendor/`의 외부 라이브러리(three.js, @pixiv/three-vrm, qrcode-generator)는 각자의 라이선스(모두 MIT)를 따르고, 모델 파일은 저장소에 들어 있지 않으며 아래처럼 모델마다 조건이 다릅니다.

NoobAI-XL의 라이선스는 모델로 만든 결과물을 포함해 모든 상업적 이용을 금지합니다. 판매할 게임에 쓸 에셋이라면 `noob`, `noob-hq`, `noob-eps` 결과물은 쓰지 마세요. 포즈용 `noob_openpose` ControlNet도 같은 팀의 모델이고 라이선스 표기가 없으므로 같은 조건으로 보고, 판매용에는 Apache-2.0인 xinsir ControlNet을 쓰세요. WAI 등 다른 모델도 원본 배포 페이지의 라이선스를 직접 확인한 뒤 사용하세요.

## 모델 다시 받기

```bash
scripts/download_models.sh
```

이미 받은 파일은 건너뜁니다.
