#!/bin/zsh
# VN-Pipeline 모델 다운로드 (이어받기 지원)
set -e
M="${0:A:h}/../models"
dl() { [ -f "$2" ] && [ ! -f "$2.part" ] && { echo "skip $2"; return; }; curl -fL -C - --retry 5 -o "$2.part" "$1" && mv "$2.part" "$2"; }
dl https://huggingface.co/Comfy-Org/BiRefNet/resolve/main/background_removal/birefnet.safetensors "$M/background_removal/birefnet.safetensors"
dl https://huggingface.co/Bingsu/adetailer/resolve/main/face_yolov8m.pt "$M/ultralytics/bbox/face_yolov8m.pt"
dl https://huggingface.co/Bingsu/adetailer/resolve/main/hand_yolov8s.pt "$M/ultralytics/bbox/hand_yolov8s.pt"
dl https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.2.4/RealESRGAN_x4plus_anime_6B.pth "$M/upscale_models/RealESRGAN_x4plus_anime_6B.pth"
dl https://huggingface.co/Laxhar/noobai-XL-Vpred-1.0/resolve/main/NoobAI-XL-Vpred-v1.0.safetensors "$M/checkpoints/NoobAI-XL-Vpred-v1.0.safetensors"
# WAI-Illustrious v17 (eps, 캐릭터 일러스트에 강함)
dl https://huggingface.co/LyliaEngine/waiIllustriousSDXL_v170/resolve/main/waiIllustriousSDXL_v170.safetensors "$M/checkpoints/waiIllustriousSDXL_v170.safetensors"
echo ALL_DONE2
