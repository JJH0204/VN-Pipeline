"""VN-Pipeline 공용 라이브러리 (CLI vn.py 와 GUI studio 가 공유)."""
from . import characters, config, graphs, modelinfo, pose, tagger  # noqa: F401  (tagger·pose: numpy/onnxruntime은 사용할 때 불러옴)
