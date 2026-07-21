import asyncio
import os
from io import BytesIO
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image, UnidentifiedImageError

from detector_core import (
    DEFAULT_CONFIDENCE,
    DEFAULT_HIGH_CONFIDENCE,
    DEFAULT_MAX_DETECTIONS,
    DEFAULT_MAX_SIDE,
    DEFAULT_NMS_IOU,
    clear_gpu_memory,
    load_detector,
    run_detector_from_image,
)


APP_DIR = Path(__file__).resolve().parent
DEFAULT_CHECKPOINT = APP_DIR / "models" / "faster_rcnn_uiland_checkpoint_stopped.pth"
DEFAULT_LABEL_MAP = APP_DIR / "models" / "ui_detector_label_map.json"

CHECKPOINT_PATH = Path(os.getenv("UI_DETECTOR_CHECKPOINT", str(DEFAULT_CHECKPOINT)))
LABEL_MAP_PATH = Path(os.getenv("UI_DETECTOR_LABEL_MAP", str(DEFAULT_LABEL_MAP)))
CONCURRENCY = max(1, int(os.getenv("UI_DETECTOR_CONCURRENCY", "1")))
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "UI_DETECTOR_ALLOWED_ORIGINS",
        "https://rendervideos.uiland.workers.dev,http://localhost:5173,http://127.0.0.1:5173,http://localhost:8080,http://127.0.0.1:8080,null",
    ).split(",")
    if origin.strip()
]

app = FastAPI(title="Uiland UI Detector", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

model = None
device = None
id_to_label = None
num_classes = None
model_error: Optional[str] = None
infer_semaphore = asyncio.Semaphore(CONCURRENCY)


def ensure_model_loaded() -> None:
    global model, device, id_to_label, num_classes, model_error
    if model is not None:
        return
    try:
        model, device, id_to_label, num_classes = load_detector(CHECKPOINT_PATH, LABEL_MAP_PATH)
        model_error = None
    except Exception as exc:
        model_error = str(exc)
        raise


@app.on_event("startup")
def startup() -> None:
    if os.getenv("UI_DETECTOR_LOAD_ON_STARTUP", "1") == "1":
        ensure_model_loaded()


@app.get("/health")
def health():
    return {
        "ok": model_error is None,
        "model_loaded": model is not None,
        "model_error": model_error,
        "checkpoint": str(CHECKPOINT_PATH),
        "label_map": str(LABEL_MAP_PATH),
        "concurrency": CONCURRENCY,
        "allowed_origins": ALLOWED_ORIGINS,
    }


@app.post("/warmup")
def warmup():
    try:
        ensure_model_loaded()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"ok": True, "model_loaded": True, "device": str(device), "num_classes": num_classes}


@app.post("/detect-ui")
async def detect_ui(
    file: UploadFile = File(...),
    frame_id: str = Form(""),
    timestamp_sec: Optional[float] = Form(None),
    confidence: float = Form(DEFAULT_CONFIDENCE),
    high_confidence: float = Form(DEFAULT_HIGH_CONFIDENCE),
    nms_iou: float = Form(DEFAULT_NMS_IOU),
    max_detections: int = Form(DEFAULT_MAX_DETECTIONS),
    max_side: int = Form(DEFAULT_MAX_SIDE),
    include_all: bool = Form(False),
):
    try:
        ensure_model_loaded()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"model failed to load: {exc}") from exc

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="empty image upload")

    try:
        image = Image.open(BytesIO(raw)).convert("RGB")
    except UnidentifiedImageError as exc:
        raise HTTPException(status_code=400, detail="upload is not a supported image") from exc

    async with infer_semaphore:
        try:
            return await asyncio.to_thread(
                run_detector_from_image,
                model,
                device,
                id_to_label,
                image,
                frame_id=frame_id,
                timestamp_sec=timestamp_sec,
                confidence_threshold=confidence,
                high_confidence_threshold=high_confidence,
                nms_iou_threshold=nms_iou,
                max_detections=max_detections,
                max_side=max_side,
                include_all=include_all,
            )
        except RuntimeError as exc:
            if "out of memory" in str(exc).lower():
                clear_gpu_memory()
            raise HTTPException(status_code=500, detail=str(exc)) from exc
