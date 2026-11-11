#!/bin/zsh
# ComfyUI 서버 실행 (기존 엔진 재사용, 입출력/설정은 VN-Pipeline 폴더 사용)
P="${0:A:h}"
ENGINE="$P/ComfyUI/Installs/ComfyUI"
cd "$ENGINE/ComfyUI"
exec "$ENGINE/standalone-env/bin/python" main.py \
  --listen 127.0.0.1 --port 8188 \
  --extra-model-paths-config "$P/extra_model_paths.yaml" \
  --output-directory "$P/output" \
  --input-directory "$P/input" \
  --user-directory "$P/user" \
  --preview-method auto \
  --disable-auto-launch "$@"
