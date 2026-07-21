import gc
import json
import os
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import torch
from PIL import Image

try:
    from torchvision.models.detection import fasterrcnn_resnet50_fpn
    from torchvision.ops import nms as torchvision_nms
    from torchvision.transforms.functional import to_tensor as pil_to_tensor
except Exception as exc:  # pragma: no cover - surfaced by load_detector
    fasterrcnn_resnet50_fpn = None
    torchvision_nms = None
    pil_to_tensor = None
    IMPORT_ERROR = exc
else:
    IMPORT_ERROR = None


os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

DEFAULT_CONFIDENCE = float(os.getenv("UI_DETECTOR_CONFIDENCE", "0.45"))
DEFAULT_HIGH_CONFIDENCE = float(os.getenv("UI_DETECTOR_HIGH_CONFIDENCE", "0.60"))
DEFAULT_NMS_IOU = float(os.getenv("UI_DETECTOR_NMS_IOU", "0.35"))
DEFAULT_MAX_DETECTIONS = int(os.getenv("UI_DETECTOR_MAX_DETECTIONS", "80"))
DEFAULT_MAX_SIDE = int(os.getenv("UI_DETECTOR_MAX_SIDE", "960"))

BLOCKED_CANONICAL_TYPES = {"unknown", "text", "heading", "subheading", "paragraph"}
IGNORE_IPHONE_STATUS_BAR = True
IPHONE_STATUS_BAR_HEIGHT_RATIO = 0.075

PRIVACY_LABELS_HIDE = {
    "password input",
    "password reset form",
    "pin input",
    "otp input",
    "keyboard",
    "text keyboard",
    "numeric keypad",
}

PRIVACY_LABELS_BLUR = {
    "auto complete input",
    "chat input",
    "chat input field",
    "input",
    "input field",
    "number input",
    "text area",
    "textarea",
    "text input",
    "textinput field",
    "text input field",
}


def clear_gpu_memory() -> None:
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
        torch.cuda.ipc_collect()


def clean_text(value: Any) -> str:
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value).strip())


def normalized_label(value: Any) -> str:
    label = clean_text(value).lower().replace("-", " ").replace("_", " ")
    return re.sub(r"\s+", " ", label).strip()


def clip_bbox(bbox: List[int], width: int, height: int) -> List[int]:
    x1, y1, x2, y2 = bbox
    return [
        max(0, min(width, x1)),
        max(0, min(height, y1)),
        max(0, min(width, x2)),
        max(0, min(height, y2)),
    ]


def norm_bbox(bbox: List[int], width: int, height: int) -> List[float]:
    x1, y1, x2, y2 = bbox
    if width <= 0 or height <= 0:
        return [0, 0, 0, 0]
    return [
        round(x1 / width, 6),
        round(y1 / height, 6),
        round(x2 / width, 6),
        round(y2 / height, 6),
    ]


def is_inside_iphone_status_bar(bbox: Any, image_height: Optional[int]) -> bool:
    if not IGNORE_IPHONE_STATUS_BAR or not image_height:
        return False
    if not isinstance(bbox, list) or len(bbox) != 4:
        return False
    return float(bbox[3]) <= float(image_height) * IPHONE_STATUS_BAR_HEIGHT_RATIO


def infer_num_classes_from_state_dict(state_dict: Dict[str, Any]) -> int:
    for key in (
        "roi_heads.box_predictor.cls_score.weight",
        "model.roi_heads.box_predictor.cls_score.weight",
        "module.roi_heads.box_predictor.cls_score.weight",
    ):
        value = state_dict.get(key)
        if value is not None and hasattr(value, "shape") and len(value.shape) >= 1:
            return int(value.shape[0])
    return 284


def load_label_map(path: Path, num_classes: int) -> Dict[int, str]:
    mapped: Dict[int, str] = {}
    if path.exists():
        raw = json.loads(path.read_text(encoding="utf-8"))
        mapped = {int(k): str(v) for k, v in raw.items()}
    for i in range(num_classes):
        mapped.setdefault(i, f"class_{i}")
    return mapped


def normalize_detector_label(raw_label: Any) -> str:
    label = normalized_label(raw_label)
    if not label or label in {"background", "backdrop", "overlay", "overlay layer", "watermark", "offline", "explicit"}:
        return "unknown"

    aliases = {
        "arrow iocn": "arrow icon",
        "buttt": "button",
        "ill": "illustration",
        "empty": "empty state",
        "circle charts": "chart",
        "loader": "loading",
        "loading screen": "loading",
        "bottom sheet": "bottom sheet",
        "explore icon": "icon",
        "learn icon": "icon",
        "invest icon": "icon",
        "message icon": "icon",
        "settings icon": "icon",
        "pause icon": "icon",
        "play icon": "icon",
        "camera": "icon",
        "b": "icon",
        "hamburger menu": "menu icon",
        "overflow menu": "menu",
        "more": "menu",
        "mini map": "map",
        "minimap": "map",
        "contentinfo": "footer",
    }
    label = aliases.get(label, label)

    if "status bar" in label:
        return "unknown"
    if any(k in label for k in ["donut chart", "pie chart", "trend line chart", "histogram", "gauge", "graph", "analytics", "chart"]):
        return "chart"
    if any(k in label for k in ["search box", "search field", "search bar"]):
        return "search_bar"
    if label == "search":
        return "search_bar"
    if label == "search icon":
        return "icon"
    if any(k in label for k in ["auto complete input", "autocomplete", "chat input", "password input", "text input", "number input", "otp input", "pin input", "input field", "textinput", "text input field", "text area", "textarea", "captcha", "login form", "signup form", "password reset form"]):
        return "input"
    if label == "form":
        return "form"
    if any(k in label for k in ["button", "floating action", "split button", "context button", "clipboard copy", "download button", "logout button", "play button", "pause button", "menu button", "dropdown button", "add button"]):
        return "button"
    if any(k in label for k in ["bottom navigation", "bottom nav"]):
        return "bottom_nav"
    if any(k in label for k in ["navigation bar", "app bar", "nav bar", "navbar", "navigation panel", "toolbar", "header", "sidebar", "footer", "breadcrumbs", "breadcrumb", "page control", "pagination"]):
        return "navigation"
    if any(k in label for k in ["tablist", "tabs", "tab control"]):
        return "tabs"
    if label in {"menu", "floating menu", "dropdown menu"}:
        return "navigation"
    if any(k in label for k in ["dropdown", "multiselect", "select", "tree selector", "tag selector", "sort control"]):
        return "dropdown"
    if "checkbox" in label:
        return "checkbox"
    if "radio button" in label:
        return "radio"
    if any(k in label for k in ["toggle switch", "toggle button"]):
        return "switch"
    if any(k in label for k in ["range slider", "range selector", "slider"]):
        return "slider"
    if any(k in label for k in ["stepper", "color picker", "date picker", "time picker", "calendar", "scheduler"]):
        return "input"
    if any(k in label for k in ["progress bar", "progress circle", "progress indicator", "progressbar", "upload progress"]):
        return "progress"
    if any(k in label for k in ["modal", "dialog", "alertdialog", "confirmation dialog", "popup", "action sheet"]):
        return "modal"
    if "bottom sheet" in label or label == "sheet":
        return "bottom_sheet"
    if any(k in label for k in ["alert", "warning", "error message", "notification", "toast", "snackbar"]):
        return "alert"
    if any(k in label for k in ["loading", "spinner", "skeleton"]):
        return "loading"
    if "empty state" in label:
        return "empty_state"
    if any(k in label for k in ["tooltip", "help icon"]):
        return "tooltip"
    if any(k in label for k in ["card", "hover card", "panel", "box", "container", "section", "frame", "callout", "review box", "alert box", "message box", "chat box", "column", "canvas", "hud", "display", "drill down widget", "stack"]):
        return "card"
    if any(k in label for k in ["list", "virtual scroll", "comment thread", "scroll area"]):
        return "list"
    if "table" in label:
        return "table"
    if any(k in label for k in ["grid", "tiles", "gallery", "grid view"]):
        return "grid"
    if "carousel" in label:
        return "carousel"
    if any(k in label for k in ["illustration", "hero image", "3d viewer"]):
        return "illustration"
    if any(k in label for k in ["image", "background image", "profile image", "profile picture", "qr code", "country flag", "gift box"]):
        return "image"
    if "avatar" in label or label in {"add user", "user icon"}:
        return "avatar"
    if "logo" in label or label in {"facebook icon", "google icon", "instagram icon", "whatsapp logo", "youtube icon"}:
        return "logo"
    if "map" in label:
        return "map"
    if "video" in label:
        return "video"
    if any(k in label for k in ["audio", "music", "sound wave", "equaliser"]):
        return "audio"
    if "icon" in label or label in {"bluetooth", "fingerprint", "incognito", "keyboard", "numeric keypad", "subtract", "exchange", "connect", "receive", "send", "transfer", "transaction", "payment", "record", "refresh", "replay", "reshuffle", "x", "x icon", "device icon", "volume icon"}:
        return "icon"
    if any(k in label for k in ["badge", "status indicator", "status", "user badge", "rating stars"]):
        return "badge"
    if any(k in label for k in ["chip", "pill", "tag", "filter chip"]):
        return "tag"
    if any(k in label for k in ["heading", "subtitle", "paragraph", "label", "placeholder", "text"]):
        return "unknown"
    if label in {"divider", "scroll bar", "scroll indicator", "swipe indicator", "drag handle", "resizer"}:
        return "divider"
    return "unknown"


def canonical_to_ui_element_type(canonical: str) -> str:
    return {
        "button": "button",
        "icon": "icon",
        "input": "input",
        "search_bar": "search_bar",
        "card": "card",
        "list": "list",
        "table": "table",
        "grid": "grid",
        "chart": "chart",
        "navigation": "navbar",
        "bottom_nav": "bottom_nav",
        "tabs": "tab_bar",
        "modal": "modal",
        "bottom_sheet": "bottom_sheet",
        "illustration": "illustration",
        "image": "image",
        "avatar": "avatar",
        "logo": "image",
        "badge": "badge",
        "tag": "tag",
        "progress": "progress_bar",
        "switch": "switch",
        "checkbox": "checkbox",
        "radio": "radio",
        "slider": "slider",
        "map": "map",
        "video": "video",
        "alert": "toast",
        "loading": "loading_state",
        "empty_state": "empty_state",
        "form": "form",
        "divider": "divider",
        "tooltip": "tooltip",
        "carousel": "carousel",
        "audio": "video",
    }.get(canonical, "unknown")


def privacy_action_for(raw_label: str, canonical: str) -> Tuple[str, str]:
    label = normalized_label(raw_label)
    if label in PRIVACY_LABELS_HIDE or any(k in label for k in ["password", "pin input", "otp input", "keyboard", "keypad"]):
        return "hide", f"ui-auto-{label.replace(' ', '-')}"
    if canonical == "input" or label in PRIVACY_LABELS_BLUR:
        return "blur", f"ui-auto-{label.replace(' ', '-') or 'input'}"
    return "none", "ui-auto-ignored"


def load_detector(checkpoint_path: Path, label_map_path: Path):
    if fasterrcnn_resnet50_fpn is None or pil_to_tensor is None:
        raise RuntimeError(f"torchvision detection import failed: {IMPORT_ERROR}")
    if not checkpoint_path.exists():
        raise FileNotFoundError(f"checkpoint not found: {checkpoint_path}")

    checkpoint = torch.load(checkpoint_path, map_location="cpu")
    if isinstance(checkpoint, dict):
        state_dict = checkpoint.get("model_state_dict") or checkpoint.get("model") or checkpoint.get("state_dict") or checkpoint
    else:
        state_dict = checkpoint

    cleaned = {}
    for key, value in state_dict.items():
        new_key = key
        if new_key.startswith("module."):
            new_key = new_key[len("module."):]
        if new_key.startswith("model."):
            new_key = new_key[len("model."):]
        cleaned[new_key] = value

    num_classes = infer_num_classes_from_state_dict(cleaned)
    id_to_label = load_label_map(label_map_path, num_classes)

    model = fasterrcnn_resnet50_fpn(weights=None, weights_backbone=None, num_classes=num_classes)
    model.load_state_dict(cleaned, strict=False)

    preferred_device = os.getenv("UI_DETECTOR_DEVICE", "").strip().lower()
    if preferred_device == "cpu":
        device = torch.device("cpu")
    elif preferred_device == "cuda" and torch.cuda.is_available():
        device = torch.device("cuda")
    else:
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    model.to(device).eval()
    return model, device, id_to_label, num_classes


def resize_for_detection(image: Image.Image, max_side: int) -> Tuple[Image.Image, float]:
    width, height = image.size
    longest = max(width, height)
    if max_side <= 0 or longest <= max_side:
        return image, 1.0
    scale = max_side / float(longest)
    resized = image.resize((max(1, round(width * scale)), max(1, round(height * scale))), Image.Resampling.BICUBIC)
    return resized, scale


def scale_box(box: List[int], scale: float, width: int, height: int) -> List[int]:
    if scale == 1:
        return clip_bbox(box, width, height)
    inv = 1.0 / scale
    return clip_bbox([round(v * inv) for v in box], width, height)


def run_detector_from_image(
    model,
    device,
    id_to_label: Dict[int, str],
    image: Image.Image,
    *,
    frame_id: str = "",
    timestamp_sec: Optional[float] = None,
    confidence_threshold: float = DEFAULT_CONFIDENCE,
    high_confidence_threshold: float = DEFAULT_HIGH_CONFIDENCE,
    nms_iou_threshold: float = DEFAULT_NMS_IOU,
    max_detections: int = DEFAULT_MAX_DETECTIONS,
    max_side: int = DEFAULT_MAX_SIDE,
    include_all: bool = False,
) -> Dict[str, Any]:
    started = time.perf_counter()
    original = image.convert("RGB")
    width, height = original.size
    detect_image, scale = resize_for_detection(original, max_side)
    tensor = pil_to_tensor(detect_image)

    with torch.inference_mode():
        pred = model([tensor.to(device)])[0]

    boxes = pred.get("boxes", torch.empty((0, 4))).detach().cpu()
    labels = pred.get("labels", torch.empty((0,), dtype=torch.long)).detach().cpu()
    scores = pred.get("scores", torch.empty((0,))).detach().cpu()

    keep = scores >= confidence_threshold
    boxes, labels, scores = boxes[keep], labels[keep], scores[keep]

    if len(boxes) > 0 and torchvision_nms is not None:
        keep_idx = torchvision_nms(boxes, scores, nms_iou_threshold)
        boxes, labels, scores = boxes[keep_idx], labels[keep_idx], scores[keep_idx]

    if len(scores) > 0:
        order = torch.argsort(scores, descending=True)[:max_detections]
    else:
        order = torch.empty((0,), dtype=torch.long)

    detections: List[Dict[str, Any]] = []
    for idx in order.tolist():
        raw_id = int(labels[idx].item())
        raw_label = id_to_label.get(raw_id, f"class_{raw_id}")
        canonical = normalize_detector_label(raw_label)
        if canonical in BLOCKED_CANONICAL_TYPES:
            continue

        scaled_box = scale_box([int(round(v)) for v in boxes[idx].tolist()], scale, width, height)
        if is_inside_iphone_status_bar(scaled_box, height):
            continue

        action, source = privacy_action_for(raw_label, canonical)
        if action == "none" and not include_all:
            continue

        score = float(scores[idx].item())
        detections.append({
            "type": canonical_to_ui_element_type(canonical),
            "canonical_type": canonical,
            "raw_type": raw_label,
            "label_id": raw_id,
            "bbox": scaled_box,
            "bbox_norm": norm_bbox(scaled_box, width, height),
            "width_px": scaled_box[2] - scaled_box[0],
            "height_px": scaled_box[3] - scaled_box[1],
            "confidence": round(score, 4),
            "confidence_bucket": "high" if score >= high_confidence_threshold else "medium",
            "privacy_action": action,
            "source": source,
            "pad_before_sec": 0.4,
            "pad_after_sec": 0.4,
        })

    elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
    return {
        "ok": True,
        "frame_id": frame_id,
        "timestamp_sec": timestamp_sec,
        "width": width,
        "height": height,
        "detector_width": detect_image.size[0],
        "detector_height": detect_image.size[1],
        "scale": round(scale, 6),
        "device": str(device),
        "elapsed_ms": elapsed_ms,
        "count": len(detections),
        "detections": detections,
    }
