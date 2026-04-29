"""
KoraLink KYC — FastAPI Backend v1.6.0
======================================
POST /validate — AI-powered KYC validation with multilingual support (English/Kinyarwanda)
Changes in v1.6.0:
  - Added full i18n support with Kinyarwanda translations for all validation messages
  - New 'lang' parameter in request (en/rw) to control response language
  - All user-facing error messages now support bilingual output
  - Maintains backward compatibility with v1.5.1
"""

import os
import re
import base64
import logging
import math
from datetime import date, datetime
from typing import Optional, List, Dict, Tuple

import cv2
import numpy as np
from PIL import Image, ImageOps, ImageFilter
import pytesseract
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, validator

try:
    from pdf2image import convert_from_bytes
    PDF2IMAGE_AVAILABLE = True
except ImportError:
    PDF2IMAGE_AVAILABLE = False
    logging.warning("pdf2image not available — PDF cert mode will be rejected")

try:
    import dlib
    DLIB_AVAILABLE = True
    PREDICTOR_PATH = os.path.join(os.path.dirname(__file__), "models", "shape_predictor_68_face_landmarks.dat")
    DLIB_MODEL_AVAILABLE = os.path.exists(PREDICTOR_PATH)
    if not DLIB_MODEL_AVAILABLE:
        logging.warning(f"dlib 68-point landmark model not found at {PREDICTOR_PATH}")
except ImportError:
    DLIB_AVAILABLE = False
    DLIB_MODEL_AVAILABLE = False
    logging.warning("dlib not available — advanced validation disabled")

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("koralink-kyc")

# ═══════════════════════════════════════════════════════════════
#  TRANSLATIONS (i18n) — English & Kinyarwanda
# ═══════════════════════════════════════════════════════════════

TRANSLATIONS = {
    "en": {
        # General
        "approved": "Verification Approved!",
        "rejected": "Verification Failed",
        "confidence_score": "Confidence Score",
        "issues_found": "Issues Found",
        "approved_message": "Your data has been securely saved. You will receive confirmation shortly.",
        "rejected_message": "Please correct the issues above and try again.",
        
        # Quality checks
        "resolution_low": "{name}: Resolution too low ({w}×{h}px). Minimum {min_w}×{min_h}px.",
        "too_blurry": "{name}: Image appears blurry (score {score:.0f}). Please retake in better light.",
        "too_dark": "{name}: Too dark (brightness {brightness:.0f}/255). Improve lighting.",
        "overexposed": "{name}: Overexposed (brightness {brightness:.0f}/255). Reduce glare.",
        
        # Selfie validation
        "selfie_resolution_low": "Selfie resolution insufficient ({w}×{h}px). Minimum {min_w}×{min_h}px required.",
        "selfie_too_blurry": "Selfie too blurry (sharpness {score:.0f}). Please retake.",
        "selfie_too_dark": "Selfie too dark ({brightness:.0f}/255). Please face a light source.",
        "selfie_overexposed": "Selfie overexposed ({brightness:.0f}/255). Please reduce glare.",
        "selfie_low_contrast": "Selfie contrast low ({contrast:.0f}). Ensure good lighting.",
        "face_too_small": "Face too small ({ratio:.1%}). Move closer — face must fill ≥15% of frame.",
        "face_too_large": "Face too large ({ratio:.1%}). Move back to show shoulders.",
        "face_not_centered": "Face not centered. Position face in center of frame.",
        "face_position_low": "Face positioned low in frame.",
        "background_cluttered": "Background too cluttered ({score:.0%} uniformity). Use a plain wall with no patterns or objects.",
        "background_not_plain": "Background not plain enough ({score:.0%} uniformity). A solid color wall is recommended.",
        "background_too_many_objects": "Background has too many objects ({ratio:.0%} edges). Remove pictures or patterns from background.",
        "head_turned": "Head turned {severity} ({angle:.0f}°). Face the camera.",
        "head_tilted_up_down": "Head tilted {severity} up/down ({angle:.0f}°). Keep head level.",
        "head_tilted_sideways": "Head tilted {severity} sideways ({angle:.0f}°). Keep head straight.",
        "shoulders_not_visible": "Shoulders not clearly visible. Frame from head to upper chest.",
        
        # Document validation
        "front_not_id": "Front image does not look like an ID card. Please recapture.",
        "back_not_id": "Back image does not look like an ID card. Please recapture.",
        "no_face_in_id": "No face detected in the ID card front image.",
        "no_face_in_selfie": "No face detected in your selfie. Ensure your face is fully visible and well lit.",
        "face_match_failed": "Your selfie does not match the face on the ID card (similarity: {sim}%). Please retake your selfie.",
        "cert_face_match_warning": "Your selfie may not match the photo on the certificate (similarity: {sim}%). Please retake your selfie facing the camera directly. Note: certificate photos are small — if this is an error, your application will still be reviewed.",
        
        # Certificate validation
        "cert_not_valid": "The uploaded document does not appear to be a valid Rwandan ID replacement certificate (Icyemezo Gisimbura Indangamuntu). Expected keywords not found: {keywords}. Please upload the official PDF from Irembo.",
        "cert_expired": "The replacement certificate appears to have expired on {date}. Please obtain a new certificate from your local Umurenge office.",
        
        # OCR validation
        "id_not_found": "ID number '{id}' was not found in the scanned {doc_type}. Ensure the front side is in focus and the correct ID number was entered.",
        "name_mismatch": "Name '{name}' does not match the name on the {doc_type}. Please ensure your name is entered exactly as it appears on your document.",
        "gender_mismatch": "Gender '{gender}' does not match the gender on the {doc_type} ('{ocr_gender}'). Please check your details.",
        "dob_mismatch": "Date of birth '{dob}' does not match the date on the {doc_type} ('{ocr_dob}'). Please verify your date of birth.",
        
        # File errors
        "pdf_unavailable": "PDF processing unavailable.",
        "pdf_read_error": "Could not read the uploaded PDF.",
        "front_read_error": "Front ID image could not be read.",
        "back_read_error": "Back ID image could not be read. Please retake or re-upload.",
        "selfie_read_error": "Selfie could not be read.",
        
        # Severity
        "too_far": "too far",
        "slightly": "slightly",
    },
    
    "rw": {
        # General
        "approved": "Gisuzumwe Byemewe!",
        "rejected": "Gisuzumwe Byanze",
        "confidence_score": "Amanota yo Kwizera",
        "issues_found": "Ibibazo Byabonetse",
        "approved_message": "Amakuru yawe yabitswe neza. Uzamenyeshwa vuba.",
        "rejected_message": "Nyamuneka kosora ibibazo hejuru ugerageze nanone.",
        
        # Quality checks
        "resolution_low": "{name}: Ifoto ntiyera neza ({w}×{h}px). Minima {min_w}×{min_h}px.",
        "too_blurry": "{name}: Ifoto ntigaragarira neza (amanota {score:.0f}). Fongera ufite urumuri rwiza.",
        "too_dark": "{name}: Bimaranye ubumanga (urumuri {brightness:.0f}/255). Shaka urumuri.",
        "overexposed": "{name}: Byeruye cyane (urumuri {brightness:.0f}/255). Kugabanya urumuri.",
        
        # Selfie validation
        "selfie_resolution_low": "Ifoto y'ubusobanuro ntiyera neza ({w}×{h}px). Minima {min_w}×{min_h}px.",
        "selfie_too_blurry": "Ifoto y'ubusobanuro ntigaragarira neza (amanota {score:.0f}). Fongera.",
        "selfie_too_dark": "Ifoto y'ubusobanuro nijimye ({brightness:.0f}/255). Raba ahari urumuri.",
        "selfie_overexposed": "Ifoto y'ubusobanuro yeruye cyane ({brightness:.0f}/255). Kugabanya urumuri.",
        "selfie_low_contrast": "Ifoto y'ubusobanuro itandukanye nke ({contrast:.0f}). Reba ko hari urumuri rwiza.",
        "face_too_small": "Mu maso make cyane ({ratio:.1%}). Kwegera — mu maso agomba kuzura ≥15% bya fremu.",
        "face_too_large": "Mu maso menshi cyane ({ratio:.1%}). Kwirengagiza kugirango amabere yakwire.",
        "face_not_centered": "Mu maso atari mu murongo. Shyira mu maso mu murongo wa fremu.",
        "face_position_low": "Mu maso ashyizwe hasi mu fremu.",
        "background_cluttered": "Inyuma yawe hari ibintu byinshi ({score:.0%} isuku). Koresha urukuta rutagira imishusho.",
        "background_not_plain": "Inyuma yawe ntago ari isuku ({score:.0%} isuku). Koresha urukuta rumwe.",
        "background_too_many_objects": "Inyuma yawe hari ibintu byinshi ({ratio:.0%} imirongo). Kuraho imishusho cyangwa imice.",
        "head_turned": "Mutwe wahindutse {severity} ({angle:.0f}°). Raba muri kamera.",
        "head_tilted_up_down": "Mutwe wahindutse {severity} hejuru/hasi ({angle:.0f}°). Reka mutwe utereye.",
        "head_tilted_sideways": "Mutwe wahindutse {severity} ku ruhande ({angle:.0f}°). Reka mutwe utereye.",
        "shoulders_not_visible": "Amabere ntago yagaragara neza. Fata kuva mu mutwe kugera mu kirere.",
        
        # Document validation
        "front_not_id": "Ifoto y'imbere ntifana na Indangamuntu. Fongera.",
        "back_not_id": "Ifoto y'inyuma ntifana na Indangamuntu. Fongera.",
        "no_face_in_id": "Nta mu maso yabonetse mu ifoto y'Indangamuntu y'imbere.",
        "no_face_in_selfie": "Nta mu maso yabonetse mu ifoto yawe. Raba ko mu maso yawe yagaragara neza.",
        "face_match_failed": "Ifoto yawe ntifana na mu maso ku Indangamuntu (kufana: {sim}%). Fongera ifoto yawe.",
        "cert_face_match_warning": "Ifoto yawe ntishobora kufana na ifoto ku cyemezo (kufana: {sim}%). Fongera ifoto yawe raba muri kamera. Icyitonderwa: amafoto ku cyemezo mato — niba ari ikosa, usabwa uzasuzumwa.",
        
        # Certificate validation
        "cert_not_valid": "Inyandiko wohereje ntifana na Icyemezo Gisimbura Indangamuntu. Amagambo yateganyijwe ntiyabonetse: {keywords}. Shyira PDF yemewe ya Irembo.",
        "cert_expired": "Icyemezo cyarangiye ku itariki {date}. Shyira icyemezo gishya mu ofisi y'Umurenge.",
        
        # OCR validation
        "id_not_found": "Nimero y'Indangamuntu '{id}' ntiyabonetse mu {doc_type}. Raba ko uruhande rw'imbere rwiza kandi nimero yanditswe neza.",
        "name_mismatch": "Izina '{name}' ntifana n'izina kuri {doc_type}. Reka izina ryanditswe uko riboneka ku nyandiko yawe.",
        "gender_mismatch": "Igitsina '{gender}' ntifana n'igitsina kuri {doc_type} ('{ocr_gender}'). Reka amakuru yawe.",
        "dob_mismatch": "Itariki yavukiyeho '{dob}' ntifana n'itariki kuri {doc_type} ('{ocr_dob}'). Reka itariki yavukiyeho yawe.",
        
        # File errors
        "pdf_unavailable": "Gusoma PDF ntibikunda.",
        "pdf_read_error": "PDF ntiyashoboye gusomwa.",
        "front_read_error": "Ifoto y'imbere ntiyashoboye gusomwa.",
        "back_read_error": "Ifoto y'inyuma ntiyashoboye gusomwa. Fongera cyangwa ushyire indi.",
        "selfie_read_error": "Ifoto y'ubusobanuro ntiyashoboye gusomwa.",
        
        # Severity
        "too_far": "cyane",
        "slightly": "bukeya",
    }
}

def t(key: str, lang: str = "en", **kwargs) -> str:
    """Get translated string with optional format arguments."""
    translation = TRANSLATIONS.get(lang, TRANSLATIONS["en"]).get(key, key)
    if kwargs:
        return translation.format(**kwargs)
    return translation

# ═══════════════════════════════════════════════════════════════
#  Model Paths & DNN Loaders
# ═══════════════════════════════════════════════════════════════

MODEL_DIR       = os.path.join(os.path.dirname(__file__), "models")
PROTOTXT_PATH   = os.path.join(MODEL_DIR, "deploy.prototxt")
CAFFEMODEL_PATH = os.path.join(MODEL_DIR, "res10_300x300_ssd_iter_140000.caffemodel")

_dnn_net = None
_dlib_predictor = None

def get_dnn_net():
    global _dnn_net
    if _dnn_net is None:
        if os.path.exists(PROTOTXT_PATH) and os.path.exists(CAFFEMODEL_PATH):
            _dnn_net = cv2.dnn.readNetFromCaffe(PROTOTXT_PATH, CAFFEMODEL_PATH)
            logger.info("OpenCV DNN face detector loaded.")
        else:
            logger.warning("DNN model files missing — using Haar cascade fallback.")
    return _dnn_net

def get_dlib_predictor():
    global _dlib_predictor
    if _dlib_predictor is None and DLIB_AVAILABLE and DLIB_MODEL_AVAILABLE:
        try:
            _dlib_predictor = dlib.shape_predictor(PREDICTOR_PATH)
            logger.info("Dlib 68-point landmark predictor loaded.")
        except Exception as e:
            logger.error(f"Failed to load dlib predictor: {e}")
    return _dlib_predictor

# ═══════════════════════════════════════════════════════════════
#  BALANCED PASSPORT-STYLE SELFIE THRESHOLDS (v1.4.3)
# ═══════════════════════════════════════════════════════════════

SELFIE_MIN_WIDTH         = 640
SELFIE_MIN_HEIGHT        = 480
SELFIE_FACE_MIN_RATIO    = 0.15
SELFIE_FACE_MAX_RATIO    = 0.50
SELFIE_BLUR_THRESHOLD    = 50.0
SELFIE_BRIGHTNESS_MIN    = 45
SELFIE_BRIGHTNESS_MAX    = 230
SELFIE_BG_UNIFORMITY     = 0.75
SELFIE_BG_EDGE_RATIO     = 0.25
SELFIE_CONTRAST_MIN      = 35
SELFIE_POSE_YAW_MAX      = 20.0
SELFIE_POSE_PITCH_MAX    = 15.0
SELFIE_POSE_ROLL_MAX     = 15.0
SELFIE_SHOULDER_MIN_Y    = 0.65
SELFIE_CENTER_TOLERANCE  = 0.30

BLUR_THRESHOLD       = 80.0
BLUR_THRESHOLD_CERT  = 12.0
BRIGHTNESS_MIN       = 40
BRIGHTNESS_MAX       = 220
BRIGHTNESS_MAX_CERT  = 250
MIN_WIDTH            = 400
MIN_HEIGHT           = 250
DNN_CONFIDENCE       = 0.5
FACE_MATCH_THRESHOLD = 0.65
MAX_BASE64_MB        = 10

OCR_LANG = "eng"

CERT_REQUIRED_KEYWORDS = [
    "indangamuntu",
    "icyemezo",
    "irembo",
    "gisimbura",
]

# ═══════════════════════════════════════════════════════════════
#  v1.5.0 — OCR FIELD VALIDATION CONFIGURATION
# ═══════════════════════════════════════════════════════════════

OCR_NAME_LABELS     = ["amazina", "names"]
OCR_DOB_LABELS      = ["itariki yavutseho", "date of birth"]
OCR_GENDER_LABELS   = ["igitsina", "sex"]
OCR_ID_LABELS       = ["indangamuntu", "national id no"]

GENDER_MAP: Dict[str, List[str]] = {
    "m":    ["gabo", "m", "male"],
    "male": ["gabo", "m", "male"],
    "gabo": ["gabo", "m", "male"],
    "f":    ["gore", "f", "female"],
    "female": ["gore", "f", "female"],
    "gore": ["gore", "f", "female"],
}

NAME_FUZZY_DIST = 2

FACE_MODEL_POINTS = np.array([
    (0.0, 0.0, 0.0),
    (0.0, -330.0, -65.0),
    (-225.0, 170.0, -135.0),
    (225.0, 170.0, -135.0),
    (-150.0, -150.0, -125.0),
    (150.0, -150.0, -125.0)
], dtype=np.float32)

app = FastAPI(title="KoraLink KYC API", version="1.6.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)

class KYCRequest(BaseModel):
    first_name:   str
    last_name:    str
    gender:       str
    dob:          Optional[str] = None
    id_number:    str
    phone_number: str
    msisdn:       str
    district:     str
    doc_type:     Optional[str] = "id"
    front_image:  str
    back_image:   str
    selfie:       str
    front_is_pdf: Optional[bool] = False
    lang:         Optional[str] = "en"  # NEW: Language preference (en/rw)

    @validator("doc_type")
    def check_doc_type(cls, v):
        if v not in ("id", "cert", None):
            raise ValueError("doc_type must be 'id' or 'cert'")
        return v or "id"
    
    @validator("lang")
    def check_lang(cls, v):
        if v not in ("en", "rw", None):
            raise ValueError("lang must be 'en' or 'rw'")
        return v or "en"

    @validator("front_image", "selfie")
    def check_front_selfie_size(cls, v):
        raw = v.split(",")[1] if "," in v else v
        if len(raw) > MAX_BASE64_MB * 1024 * 1024 * 4 / 3:
            raise ValueError(f"Image/PDF exceeds {MAX_BASE64_MB}MB limit")
        return v

    @validator("back_image")
    def check_back_size(cls, v):
        raw = v.split(",")[1] if "," in v else v
        if len(raw) > MAX_BASE64_MB * 1024 * 1024 * 4 / 3:
            raise ValueError(f"Back image exceeds {MAX_BASE64_MB}MB limit")
        return v

    @validator("id_number")
    def check_id(cls, v):
        digits = re.sub(r"[\s\-]", "", v)
        if len(digits) < 10 or not digits.isdigit():
            raise ValueError("ID number must be >= 10 digits")
        return digits

    @validator("phone_number", "msisdn")
    def check_phone(cls, v):
        if not re.match(r"^07\d{8}$", v):
            raise ValueError("Phone must be 07XXXXXXXX")
        return v

    @validator("dob")
    def check_dob(cls, v):
        if v is None:
            return v
        for fmt in ("%d/%m/%Y", "%Y-%m-%d", "%d-%m-%Y"):
            try:
                datetime.strptime(v, fmt)
                return v
            except ValueError:
                continue
        raise ValueError("dob must be DD/MM/YYYY or YYYY-MM-DD")

class KYCResponse(BaseModel):
    status: str
    score:  float
    issues: List[str]
    ocr_fields: Optional[Dict] = None
    lang: str = "en"  # NEW: Return language used

# ═══════════════════════════════════════════════════════════════
#  Image helpers
# ═══════════════════════════════════════════════════════════════

def decode_image(b64: str) -> Optional[np.ndarray]:
    try:
        raw = b64.split(",")[1] if "," in b64 else b64
        arr = np.frombuffer(base64.b64decode(raw), dtype=np.uint8)
        return cv2.imdecode(arr, cv2.IMREAD_COLOR)
    except Exception as e:
        logger.error(f"decode_image: {e}")
        return None

def pdf_to_images(b64: str) -> List[np.ndarray]:
    if not PDF2IMAGE_AVAILABLE:
        logger.error("pdf2image not available")
        return []
    try:
        raw   = b64.split(",")[1] if "," in b64 else b64
        pages = convert_from_bytes(base64.b64decode(raw), dpi=200)
        return [cv2.cvtColor(np.array(p.convert("RGB")), cv2.COLOR_RGB2BGR) for p in pages]
    except Exception as e:
        logger.error(f"pdf_to_images: {e}")
        return []

def is_placeholder(b64: str) -> bool:
    try:
        img = decode_image(b64)
        if img is None:
            return True
        h, w = img.shape[:2]
        return w <= 4 and h <= 4
    except Exception:
        return True

# ═══════════════════════════════════════════════════════════════
#  Quality check (with i18n)
# ═══════════════════════════════════════════════════════════════

def check_quality(img: np.ndarray, name: str, is_cert_page: bool = False, lang: str = "en") -> List[str]:
    issues = []
    h, w = img.shape[:2]
    if w < MIN_WIDTH or h < MIN_HEIGHT:
        issues.append(t("resolution_low", lang, 
                       name=name, w=w, h=h, min_w=MIN_WIDTH, min_h=MIN_HEIGHT))
    gray        = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    blur        = cv2.Laplacian(gray, cv2.CV_64F).var()
    brightness  = float(gray.mean())
    blur_thresh = BLUR_THRESHOLD_CERT if is_cert_page else BLUR_THRESHOLD
    bright_max  = BRIGHTNESS_MAX_CERT  if is_cert_page else BRIGHTNESS_MAX

    if blur < blur_thresh:
        issues.append(t("too_blurry", lang, name=name, score=blur))
    if brightness < BRIGHTNESS_MIN:
        issues.append(t("too_dark", lang, name=name, brightness=brightness))
    elif brightness > bright_max:
        issues.append(t("overexposed", lang, name=name, brightness=brightness))

    logger.info(
        f"Quality [{name}] {w}×{h} blur={blur:.1f} bright={brightness:.1f} "
        f"cert_page={is_cert_page} blur_t={blur_thresh} bright_max={bright_max}"
    )
    return issues

# ═══════════════════════════════════════════════════════════════
#  BALANCED PASSPORT-STYLE SELFIE VALIDATION (v1.4.3) with i18n
# ═══════════════════════════════════════════════════════════════

def validate_selfie_passport_style(img: np.ndarray, face_box: Optional[Tuple] = None, lang: str = "en") -> Tuple[bool, List[str], Dict]:
    critical_issues = []
    warnings = []
    debug_info = {}
    h, w = img.shape[:2]

    if w < SELFIE_MIN_WIDTH or h < SELFIE_MIN_HEIGHT:
        critical_issues.append(t("selfie_resolution_low", lang, 
                               w=w, h=h, min_w=SELFIE_MIN_WIDTH, min_h=SELFIE_MIN_HEIGHT))

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    blur_score = cv2.Laplacian(gray, cv2.CV_64F).var()
    brightness = float(gray.mean())
    contrast = float(gray.std())

    debug_info.update({"blur": blur_score, "brightness": brightness, "contrast": contrast, "resolution": (w, h)})

    if blur_score < SELFIE_BLUR_THRESHOLD:
        critical_issues.append(t("selfie_too_blurry", lang, score=blur_score))
    if brightness < SELFIE_BRIGHTNESS_MIN:
        critical_issues.append(t("selfie_too_dark", lang, brightness=brightness))
    elif brightness > SELFIE_BRIGHTNESS_MAX:
        critical_issues.append(t("selfie_overexposed", lang, brightness=brightness))
    if contrast < SELFIE_CONTRAST_MIN:
        warnings.append(t("selfie_low_contrast", lang, contrast=contrast))

    if face_box:
        fx, fy, fw, fh = face_box
        face_ratio = (fw * fh) / (w * h)
        debug_info["face_ratio"] = face_ratio

        if face_ratio < SELFIE_FACE_MIN_RATIO:
            critical_issues.append(t("face_too_small", lang, ratio=face_ratio))
        elif face_ratio > SELFIE_FACE_MAX_RATIO:
            critical_issues.append(t("face_too_large", lang, ratio=face_ratio))

        center_offset = abs((fx + fw / 2) - w / 2) / w
        debug_info["center_offset"] = center_offset
        if center_offset > SELFIE_CENTER_TOLERANCE:
            warnings.append(t("face_not_centered", lang))

        vertical_ratio = (fy + fh / 2) / h
        debug_info["vertical_ratio"] = vertical_ratio
        if vertical_ratio > SELFIE_SHOULDER_MIN_Y:
            warnings.append(t("face_position_low", lang))

    bg_issues, bg_score = _check_plain_background(img, face_box, lang)
    if bg_score < 0.50:
        critical_issues.extend(bg_issues)
    elif bg_score < SELFIE_BG_UNIFORMITY:
        warnings.extend(bg_issues)
    debug_info["background_uniformity"] = bg_score

    if DLIB_AVAILABLE and DLIB_MODEL_AVAILABLE and face_box:
        pose_issues, pose_angles = _check_head_pose(img, face_box, lang)
        if pose_angles:
            max_angle = max(pose_angles.get("yaw", 0), pose_angles.get("pitch", 0), pose_angles.get("roll", 0))
            if max_angle > 30:
                critical_issues.extend(pose_issues)
            else:
                warnings.extend(pose_issues)
        debug_info["head_pose"] = pose_angles
    else:
        debug_info["head_pose"] = "disabled"

    _, shoulder_visible = _check_shoulders_visible(img, face_box)
    if not shoulder_visible and face_box:
        fx, fy, fw, fh = face_box
        if fy + fh < h * 0.7:
            warnings.append(t("shoulders_not_visible", lang))
    debug_info["shoulders_visible"] = shoulder_visible

    all_issues = critical_issues + warnings
    is_valid = len(critical_issues) == 0
    return is_valid, all_issues, debug_info


def _check_plain_background(img: np.ndarray, face_box: Optional[Tuple] = None, lang: str = "en") -> Tuple[List[str], float]:
    h, w = img.shape[:2]
    issues = []
    mask = np.ones((h, w), dtype=np.uint8) * 255

    if face_box:
        fx, fy, fw, fh = face_box
        margin_x = int(fw * 0.3)
        margin_y = int(fh * 0.4)
        mask[max(0, fy - margin_y):min(h, fy + fh + margin_y),
             max(0, fx - margin_x):min(w, fx + fw + margin_x)] = 0

    bg_pixels = img[mask == 255]
    if len(bg_pixels) < 1000:
        return ["Unable to analyze background."], 0.0

    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    bg_std = np.std(lab[mask == 255], axis=0).mean()
    uniformity_score = max(0, 1 - (bg_std / 60))

    edges = cv2.Canny(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), 50, 150)
    bg_edges = edges[mask == 255]
    edge_ratio = np.sum(bg_edges > 0) / len(bg_edges) if len(bg_edges) > 0 else 0

    combined_score = (uniformity_score * 0.7) + ((1 - min(1, edge_ratio / 0.3)) * 0.3)

    if combined_score < 0.50:
        issues.append(t("background_cluttered", lang, score=combined_score))
    elif combined_score < SELFIE_BG_UNIFORMITY:
        issues.append(t("background_not_plain", lang, score=combined_score))

    if edge_ratio > SELFIE_BG_EDGE_RATIO:
        issues.append(t("background_too_many_objects", lang, ratio=edge_ratio))

    return issues, combined_score


def _check_head_pose(img: np.ndarray, face_box: Tuple, lang: str = "en") -> Tuple[List[str], Optional[Dict]]:
    issues = []
    angles = None

    if not DLIB_AVAILABLE or not DLIB_MODEL_AVAILABLE:
        return issues, angles

    predictor = get_dlib_predictor()
    if predictor is None:
        return issues, angles

    try:
        x, y, w, h = face_box
        dlib_rect = dlib.rectangle(left=x, top=y, right=x+w, bottom=y+h)
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        landmarks = predictor(gray, dlib_rect)

        image_points = np.array([
            (landmarks.part(30).x, landmarks.part(30).y),
            (landmarks.part(8).x,  landmarks.part(8).y),
            (landmarks.part(36).x, landmarks.part(36).y),
            (landmarks.part(45).x, landmarks.part(45).y),
            (landmarks.part(48).x, landmarks.part(48).y),
            (landmarks.part(54).x, landmarks.part(54).y)
        ], dtype=np.float32)

        size = img.shape
        focal_length = size[1]
        center = (size[1] / 2, size[0] / 2)
        camera_matrix = np.array([
            [focal_length, 0, center[0]],
            [0, focal_length, center[1]],
            [0, 0, 1]
        ], dtype=np.float32)

        success, rotation_vector, translation_vector = cv2.solvePnP(
            FACE_MODEL_POINTS, image_points, camera_matrix, np.zeros((4, 1)),
            flags=cv2.SOLVEPNP_ITERATIVE
        )

        if success:
            rotation_matrix, _ = cv2.Rodrigues(rotation_vector)
            _, _, _, _, _, _, euler_angles = cv2.decomposeProjectionMatrix(
                np.hstack((rotation_matrix, translation_vector))
            )
            yaw   = abs(float(euler_angles[1]))
            pitch = abs(float(euler_angles[0]))
            roll  = abs(float(euler_angles[2]))
            angles = {"yaw": yaw, "pitch": pitch, "roll": roll}

            if yaw > SELFIE_POSE_YAW_MAX:
                severity = t("too_far", lang) if yaw > 30 else t("slightly", lang)
                issues.append(t("head_turned", lang, severity=severity, angle=yaw))
            if pitch > SELFIE_POSE_PITCH_MAX:
                severity = t("too_far", lang) if pitch > 25 else t("slightly", lang)
                issues.append(t("head_tilted_up_down", lang, severity=severity, angle=pitch))
            if roll > SELFIE_POSE_ROLL_MAX:
                severity = t("too_far", lang) if roll > 25 else t("slightly", lang)
                issues.append(t("head_tilted_sideways", lang, severity=severity, angle=roll))
    except Exception as e:
        logger.warning(f"Head pose estimation failed: {e}")

    return issues, angles


def _check_shoulders_visible(img: np.ndarray, face_box: Optional[Tuple] = None) -> Tuple[List[str], bool]:
    h, w = img.shape[:2]
    if not face_box:
        return [], False

    fx, fy, fw, fh = face_box
    sy_start = fy + fh + int(fh * 0.05)
    sy_end   = min(h, fy + fh + int(fh * 2.0))
    sx_margin = int(fw * 0.3)

    if sy_end <= sy_start or sy_start >= h:
        return [], False

    region = img[sy_start:sy_end, max(0, fx-sx_margin):min(w, fx+fw+sx_margin)]
    if region.size == 0:
        return [], False

    gray = cv2.cvtColor(region, cv2.COLOR_BGR2GRAY)
    face_region = img[fy:fy+fh, fx:fx+fw]
    face_brightness = np.mean(cv2.cvtColor(face_region, cv2.COLOR_BGR2GRAY))

    cues = sum([
        np.sum(cv2.Canny(gray, 30, 100) > 0) / gray.size > 0.03,
        np.std(gray) > 15,
        cv2.Laplacian(gray, cv2.CV_64F).var() > 20,
        abs(face_brightness - np.mean(gray)) > 20
    ])
    return [], cues >= 2

# ═══════════════════════════════════════════════════════════════
#  Document & face helpers
# ═══════════════════════════════════════════════════════════════

def detect_document(img: np.ndarray) -> bool:
    gray    = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    edges   = cv2.Canny(cv2.GaussianBlur(gray, (5, 5), 0), 50, 150)
    cnts, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    area_img = img.shape[0] * img.shape[1]
    for cnt in sorted(cnts, key=cv2.contourArea, reverse=True)[:10]:
        if cv2.contourArea(cnt) < area_img * 0.12:
            continue
        approx = cv2.approxPolyDP(cnt, 0.02 * cv2.arcLength(cnt, True), True)
        if len(approx) == 4:
            _, _, w, h = cv2.boundingRect(approx)
            ar = w / h if h else 0
            if 0.45 < ar < 2.2:
                return True
    return False


def detect_faces(img: np.ndarray) -> List[tuple]:
    net = get_dnn_net()
    if net is not None:
        h, w = img.shape[:2]
        blob = cv2.dnn.blobFromImage(cv2.resize(img, (300, 300)), 1.0, (300, 300), (104.0, 177.0, 123.0))
        net.setInput(blob)
        dets  = net.forward()
        boxes = []
        for i in range(dets.shape[2]):
            conf = float(dets[0, 0, i, 2])
            if conf < DNN_CONFIDENCE:
                continue
            box = (dets[0, 0, i, 3:7] * np.array([w, h, w, h])).astype(int)
            boxes.append((box[0], box[1], box[2] - box[0], box[3] - box[1]))
        return boxes
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    casc = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    fs   = casc.detectMultiScale(gray, 1.1, 5, minSize=(30, 30))
    return [tuple(f) for f in fs] if len(fs) > 0 else []


def _face_descriptor(img: np.ndarray, box: tuple) -> Optional[np.ndarray]:
    x, y, w, h = box
    pad = int(min(w, h) * 0.1)
    x1, y1 = max(0, x - pad), max(0, y - pad)
    x2, y2 = min(img.shape[1], x + w + pad), min(img.shape[0], y + h + pad)
    face = img[y1:y2, x1:x2]
    if face.size == 0:
        return None
    face = cv2.resize(face, (64, 64))
    hsv  = cv2.cvtColor(face, cv2.COLOR_BGR2HSV)
    feat = np.concatenate([cv2.calcHist([hsv], [c], None, [64], [0, 256]).flatten() for c in range(3)])
    norm = np.linalg.norm(feat)
    return (feat / norm).astype(np.float32) if norm > 0 else feat.astype(np.float32)


def match_faces(id_img: np.ndarray, selfie_img: np.ndarray) -> tuple:
    id_faces     = detect_faces(id_img)
    selfie_faces = detect_faces(selfie_img)
    if not id_faces:
        return False, 0.0, "No face detected in the ID card."
    if not selfie_faces:
        return False, 0.0, "No face detected in the selfie."
    id_desc     = _face_descriptor(id_img,     max(id_faces,     key=lambda b: b[2] * b[3]))
    selfie_desc = _face_descriptor(selfie_img, max(selfie_faces, key=lambda b: b[2] * b[3]))
    if id_desc is None or selfie_desc is None:
        return False, 0.0, "Feature extraction failed."
    sim   = float(np.dot(id_desc, selfie_desc))
    match = sim >= FACE_MATCH_THRESHOLD
    logger.info(f"Face similarity: {sim:.3f} (threshold {FACE_MATCH_THRESHOLD})")
    return match, sim, f"similarity={sim:.2f}"

# ═══════════════════════════════════════════════════════════════
#  OCR helpers
# ═══════════════════════════════════════════════════════════════

def _preprocess_for_ocr(img: np.ndarray, is_cert_page: bool = False) -> Image.Image:
    pil = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
    w, h = pil.size

    if is_cert_page:
        if w < 1800:
            pil = pil.resize((1800, int(h * 1800 / w)), Image.LANCZOS)
        pil = ImageOps.grayscale(pil)
        cv_gray = np.array(pil)
        clahe   = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        cv_gray = clahe.apply(cv_gray)
        pil = Image.fromarray(cv_gray).filter(ImageFilter.SHARPEN)
        _, binarised = cv2.threshold(np.array(pil), 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        pil = Image.fromarray(binarised)
    else:
        if w < 900:
            pil = pil.resize((900, int(h * 900 / w)), Image.LANCZOS)
        cv_gray = np.array(ImageOps.grayscale(pil))
        clahe   = cv2.createCLAHE(clipLimit=1.5, tileGridSize=(8, 8))
        cv_gray = clahe.apply(cv_gray)
        pil = Image.fromarray(cv_gray).filter(ImageFilter.SHARPEN)

    return pil


def ocr_extract(img: np.ndarray, is_cert_page: bool = False) -> str:
    try:
        pil = _preprocess_for_ocr(img, is_cert_page=is_cert_page)
        config = "--psm 6" if is_cert_page else "--psm 6"
        return pytesseract.image_to_string(pil, lang=OCR_LANG, config=config)
    except Exception as e:
        logger.error(f"OCR error: {e}")
        return ""


def ocr_all_pages(images: List[np.ndarray]) -> str:
    return "\n".join(ocr_extract(img, is_cert_page=True) for img in images)

# ═══════════════════════════════════════════════════════════════
#  String utilities
# ═══════════════════════════════════════════════════════════════

def _levenshtein(a: str, b: str) -> int:
    if len(a) < len(b):
        return _levenshtein(b, a)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a):
        curr = [i + 1]
        for j, cb in enumerate(b):
            curr.append(min(prev[j + 1] + 1, curr[j] + 1, prev[j] + (ca != cb)))
        prev = curr
    return prev[-1]


def _fuzzy_keyword_in_text(keyword: str, text: str, max_dist: int = 2) -> bool:
    if keyword in text:
        return True
    kl = len(keyword)
    for i in range(len(text) - kl + 1):
        if _levenshtein(text[i:i + kl], keyword) <= max_dist:
            return True
    return False


def validate_id_in_ocr(text: str, expected: str) -> bool:
    ct = re.sub(r"[\s\-]", "", text)
    ci = re.sub(r"[\s\-]", "", expected)
    if ci in ct:
        return True
    for i in range(max(0, len(ct) - len(ci) + 1)):
        chunk = ct[i:i + len(ci)]
        if len(chunk) == len(ci) and sum(a != b for a, b in zip(chunk, ci)) <= 2:
            return True
    return False


def validate_certificate_keywords(text: str) -> tuple:
    text_lower = text.lower()
    found   = [kw for kw in CERT_REQUIRED_KEYWORDS if _fuzzy_keyword_in_text(kw, text_lower)]
    missing = [kw for kw in CERT_REQUIRED_KEYWORDS if not _fuzzy_keyword_in_text(kw, text_lower)]
    logger.info(f"Keyword check — found: {found}  missing: {missing}")
    return len(found) >= 2, found, missing


def check_cert_expiry(text: str) -> tuple:
    today = date.today()
    future_dates: List[date] = []
    past_dates:   List[date] = []

    for d_s, m_s, y_s in re.findall(r"\b(\d{1,2})[/\-](\d{1,2})[/\-](20\d{2})\b", text):
        try:
            c = date(int(y_s), int(m_s), int(d_s))
            (future_dates if (c - today).days > 0 else past_dates).append(c)
        except ValueError:
            continue

    for y_s, m_s, d_s in re.findall(r"\b(20\d{2})[/\-](\d{1,2})[/\-](\d{1,2})\b", text):
        try:
            c = date(int(y_s), int(m_s), int(d_s))
            (future_dates if (c - today).days > 0 else past_dates).append(c)
        except ValueError:
            continue

    if future_dates:
        expiry = max(future_dates)
        return True, expiry.strftime("%d/%m/%Y")
    if past_dates:
        return False, max(past_dates).strftime("%d/%m/%Y")
    return True, "unknown"

# ═══════════════════════════════════════════════════════════════
#  NEW v1.5.0 — OCR FIELD EXTRACTION & VALIDATION
# ═══════════════════════════════════════════════════════════════

def extract_ocr_fields(ocr_text: str) -> Dict[str, str]:
    fields: Dict[str, str] = {}
    lines = [ln.strip() for ln in ocr_text.splitlines() if ln.strip()]
    text_lower = ocr_text.lower()

    id_patterns = [
        r"(?:national\s*id\s*no\.?|indangamuntu\s*/\s*national[^:]*:?)[\s\S]{0,30}?(\d[\d\s]{12,20}\d)",
        r"\b(1\s*\d{4}\s*\d\s*\d{7}\s*\d\s*\d{2})\b",
        r"\b(\d{16})\b",
        r"\b(\d[\d\s\-]{14,18}\d)\b",
    ]
    for pat in id_patterns:
        m = re.search(pat, ocr_text, re.IGNORECASE)
        if m:
            candidate = re.sub(r"[\s\-]", "", m.group(1))
            if len(candidate) >= 10:
                fields["id_number"] = candidate
                break

    dob_label_re = re.compile(
        r"(?:itariki\s*yavutseho|date\s*of\s*birth)[\s/]*(.+)", re.IGNORECASE
    )
    dob_inline = dob_label_re.search(ocr_text)
    if dob_inline:
        candidate = dob_inline.group(1).strip().split("\n")[0].strip()
        dm = re.search(r"\b(\d{1,2}[/\-]\d{1,2}[/\-]\d{4})\b", candidate)
        if dm:
            fields["dob"] = dm.group(1).replace("-", "/")

    if "dob" not in fields:
        dates = re.findall(r"\b(\d{1,2}/\d{1,2}/\d{4})\b", ocr_text)
        if dates:
            fields["dob"] = dates[0]

    gender_label_re = re.compile(
        r"(?:igitsina|sex)[^A-Za-z\n]{0,10}([A-Za-z/]+)", re.IGNORECASE
    )
    gm = gender_label_re.search(ocr_text)
    if gm:
        raw_gender = gm.group(1).strip().lower().split("/")[0].strip()
        fields["gender"] = raw_gender

    name_label_re = re.compile(
        r"(?:amazina|names?)[\s/]+(.+)", re.IGNORECASE
    )
    nm = name_label_re.search(ocr_text)
    if nm:
        name_line = nm.group(1).strip().split("\n")[0].strip()
        name_line = re.sub(r"(?:amazina|names?|itariki|date)", "", name_line, flags=re.IGNORECASE).strip()
        if len(name_line) > 2:
            fields["name"] = name_line

    if "name" not in fields:
        for line in lines:
            if re.match(r"^[A-Z][a-zA-Z]+\s+[A-Za-z]+", line) and not re.search(r"\d", line):
                skip = {"republic", "rwanda", "national", "identity", "card",
                        "indangamuntu", "republique", "republika"}
                if not any(s in line.lower() for s in skip):
                    fields["name"] = line
                    break

    logger.info(f"OCR extracted fields (ID): {fields}")
    return fields


def extract_ocr_fields_cert(ocr_text: str) -> Dict[str, str]:
    fields: Dict[str, str] = {}
    lines = [ln.strip() for ln in ocr_text.splitlines() if ln.strip()]

    name_cert_re = re.compile(
        r"ibi\s+ni\s+uguhamya\s+ko\s+(.+)", re.IGNORECASE
    )
    nm = name_cert_re.search(ocr_text)
    if nm:
        raw_name = nm.group(1).strip().split("\n")[0].strip()
        raw_name = re.sub(r"[^A-Za-z\s\-']", "", raw_name).strip()
        if len(raw_name) > 2:
            fields["name"] = raw_name

    id_cert_re = re.compile(
        r"indangamuntu\s*:\s*([\d\s]{10,25})", re.IGNORECASE
    )
    idm = id_cert_re.search(ocr_text)
    if idm:
        candidate = re.sub(r"\s", "", idm.group(1))
        if len(candidate) >= 10:
            fields["id_number"] = candidate
    if "id_number" not in fields:
        m16 = re.search(r"\b(\d{16})\b", ocr_text)
        if m16:
            fields["id_number"] = m16.group(1)

    gender_cert_re = re.compile(
        r"igitsina\s*:\s*([A-Za-z]+)", re.IGNORECASE
    )
    gm = gender_cert_re.search(ocr_text)
    if gm:
        fields["gender"] = gm.group(1).strip().lower()

    dob_cert_re = re.compile(
        r"itariki\s+yavukiyeho\s*:\s*(\d{1,2}[/\-]\d{1,2}[/\-]\d{4})", re.IGNORECASE
    )
    dobm = dob_cert_re.search(ocr_text)
    if dobm:
        fields["dob"] = dobm.group(1).replace("-", "/")
    if "dob" not in fields:
        all_dates = re.findall(r"\b(\d{1,2}/\d{1,2}/\d{4})\b", ocr_text)
        if all_dates:
            birth_candidates = [
                d for d in all_dates
                if int(d.split("/")[2]) < 2010
            ]
            if birth_candidates:
                fields["dob"] = birth_candidates[0]

    expiry_cert_re = re.compile(
        r"gifite\s+agaciro\s+kugeza\s*:\s*(\d{1,2}[/\-]\d{1,2}[/\-]\d{4})", re.IGNORECASE
    )
    exm = expiry_cert_re.search(ocr_text)
    if exm:
        fields["expiry"] = exm.group(1).replace("-", "/")

    issue_cert_re = re.compile(
        r"cyatanzwe\s+kuwa\s*:\s*(\d{1,2}[/\-]\d{1,2}[/\-]\d{4})", re.IGNORECASE
    )
    ism = issue_cert_re.search(ocr_text)
    if ism:
        fields["issued"] = ism.group(1).replace("-", "/")

    logger.info(f"OCR extracted fields (CERT): {fields}")
    return fields


def _normalise_name(name: str) -> List[str]:
    name = re.sub(r"[^a-z\s]", "", name.lower())
    return [t for t in name.split() if len(t) > 1]


def validate_name_in_ocr(ocr_text: str, first_name: str, last_name: str,
                          extracted_name: Optional[str] = None) -> Tuple[bool, str]:
    search_text = (extracted_name or ocr_text).lower()
    search_text = re.sub(r"[^a-z\s]", " ", search_text)

    first_tokens = _normalise_name(first_name)
    last_tokens  = _normalise_name(last_name)

    def _token_found(token: str, text: str) -> bool:
        if token in text:
            return True
        words = text.split()
        return any(_levenshtein(token, w) <= NAME_FUZZY_DIST for w in words)

    first_found = all(_token_found(t, search_text) for t in first_tokens) if first_tokens else False
    last_found  = all(_token_found(t, search_text) for t in last_tokens)  if last_tokens  else False

    if not (first_found and last_found) and extracted_name:
        full_search = re.sub(r"[^a-z\s]", " ", ocr_text.lower())
        if not first_found:
            first_found = all(_token_found(t, full_search) for t in first_tokens) if first_tokens else False
        if not last_found:
            last_found  = all(_token_found(t, full_search) for t in last_tokens)  if last_tokens  else False

    both = first_found and last_found
    msg = (
        f"first={first_name!r}:{'✓' if first_found else '✗'}  "
        f"last={last_name!r}:{'✓' if last_found else '✗'}"
    )
    logger.info(f"Name validation: {msg}")
    return both, msg


def validate_gender_in_ocr(ocr_fields: Dict[str, str], user_gender: str) -> Tuple[bool, str]:
    user_key = user_gender.lower().strip()
    expected_ocr_values = GENDER_MAP.get(user_key, [user_key])

    ocr_gender = ocr_fields.get("gender", "").lower().strip()
    if not ocr_gender:
        return True, "gender not extracted from OCR — skipped"

    matched = any(
        ocr_gender == ev or _levenshtein(ocr_gender, ev) <= 1
        for ev in expected_ocr_values
    )
    msg = f"user={user_gender!r} ocr={ocr_gender!r} expected_any={expected_ocr_values}"
    logger.info(f"Gender validation: {msg} → {'✓' if matched else '✗'}")
    return matched, msg


def validate_dob_in_ocr(ocr_fields: Dict[str, str], user_dob: Optional[str]) -> Tuple[bool, str]:
    if not user_dob:
        return True, "dob not provided by user — skipped"

    ocr_dob_raw = ocr_fields.get("dob", "")
    if not ocr_dob_raw:
        return True, "dob not extracted from OCR — skipped"

    def _normalise_dob(raw: str) -> Optional[str]:
        for fmt in ("%d/%m/%Y", "%Y-%m-%d", "%d-%m-%Y"):
            try:
                return datetime.strptime(raw.strip(), fmt).strftime("%d/%m/%Y")
            except ValueError:
                continue
        return None

    user_normalised = _normalise_dob(user_dob)
    ocr_normalised  = _normalise_dob(ocr_dob_raw)

    if not user_normalised or not ocr_normalised:
        return True, f"dob parse failed user={user_dob!r} ocr={ocr_dob_raw!r} — skipped"

    matched = user_normalised == ocr_normalised
    msg = f"user={user_normalised} ocr={ocr_normalised}"
    logger.info(f"DOB validation: {msg} → {'✓' if matched else '✗'}")
    return matched, msg

# ═══════════════════════════════════════════════════════════════
#  SCORING WEIGHTS (v1.5.0)
# ═══════════════════════════════════════════════════════════════

WEIGHTS_ID = {
    "front_quality":  0.08,
    "back_quality":   0.05,
    "selfie_quality": 0.05,
    "front_doc":      0.08,
    "back_doc":       0.05,
    "face_in_id":     0.08,
    "face_in_selfie": 0.08,
    "face_match":     0.12,
    "ocr_id":         0.18,
    "name_match":     0.13,
    "gender_match":   0.05,
    "dob_match":      0.05,
}

WEIGHTS_CERT = {
    "front_quality":   0.06,
    "selfie_quality":  0.03,
    "face_in_selfie":  0.04,
    "passport_selfie": 0.10,
    "face_match":      0.10,
    "cert_keywords":   0.20,
    "cert_expiry":     0.08,
    "ocr_id":          0.18,
    "name_match":      0.12,
    "gender_match":    0.05,
    "dob_match":       0.04,
}


def compute_score(checks: Dict[str, bool], weights: Dict[str, float]) -> float:
    return round(sum(weights.get(k, 0) * int(v) for k, v in checks.items()), 3)


def critical_checks_pass(checks: Dict[str, bool], doc_type: str) -> bool:
    if doc_type == "cert":
        return (
            checks.get("cert_keywords",  False) and
            checks.get("ocr_id",         False) and
            checks.get("name_match",     False) and
            checks.get("cert_expiry",    True)  and
            checks.get("front_quality",  False) and
            checks.get("face_in_selfie", False)
        )
    return (
        checks.get("face_match",     False) and
        checks.get("ocr_id",         False) and
        checks.get("name_match",     False) and
        checks.get("front_quality",  False) and
        checks.get("face_in_selfie", False)
    )

# ═══════════════════════════════════════════════════════════════
#  MAIN ENDPOINT (with i18n)
# ═══════════════════════════════════════════════════════════════

@app.post("/validate", response_model=KYCResponse)
async def validate_kyc(req: KYCRequest):
    issues:  List[str] = []
    doc_type = req.doc_type or "id"
    is_cert  = doc_type == "cert"
    lang = req.lang or "en"  # Get language preference

    logger.info(
        f"KYC [{doc_type.upper()}] [{lang}] — {req.first_name} {req.last_name} | "
        f"ID: {req.id_number} | DOB: {req.dob} | Gender: {req.gender} | pdf={req.front_is_pdf}"
    )

    weights = WEIGHTS_CERT if is_cert else WEIGHTS_ID
    checks  = {k: False for k in weights}

    # ── Decode images ─────────────────────────────────────────
    cert_pages: List[np.ndarray] = []
    if is_cert:
        if not PDF2IMAGE_AVAILABLE:
            return KYCResponse(status="rejected", score=0.0, issues=[t("pdf_unavailable", lang)], lang=lang)
        cert_pages = pdf_to_images(req.front_image)
        if not cert_pages:
            return KYCResponse(status="rejected", score=0.0, issues=[t("pdf_read_error", lang)], lang=lang)
        front_img = cert_pages[0]
    else:
        front_img = decode_image(req.front_image)
        if front_img is None:
            return KYCResponse(status="rejected", score=0.0, issues=[t("front_read_error", lang)], lang=lang)

    back_img = None
    if not is_cert:
        back_img = decode_image(req.back_image)
        if back_img is None or is_placeholder(req.back_image):
            issues.append(t("back_read_error", lang))

    selfie_img = decode_image(req.selfie)
    if selfie_img is None:
        return KYCResponse(status="rejected", score=0.0, issues=[t("selfie_read_error", lang)], lang=lang)

    # ── Quality checks ────────────────────────────────────────
    fq = check_quality(front_img, "Certificate" if is_cert else "Front ID", is_cert_page=is_cert, lang=lang)
    issues += fq
    checks["front_quality"] = len(fq) == 0

    sq = check_quality(selfie_img, "Selfie", is_cert_page=False, lang=lang)
    issues += sq
    checks["selfie_quality"] = len(sq) == 0

    if not is_cert and back_img is not None:
        bq = check_quality(back_img, "Back ID", is_cert_page=False, lang=lang)
        issues += bq
        checks["back_quality"] = len(bq) == 0

    # ── Document detection (ID mode) ──────────────────────────
    if not is_cert:
        checks["front_doc"] = detect_document(front_img)
        if not checks["front_doc"]:
            issues.append(t("front_not_id", lang))
        if back_img is not None:
            checks["back_doc"] = detect_document(back_img)
            if not checks["back_doc"]:
                issues.append(t("back_not_id", lang))

    # ── Face detection & passport selfie validation ────────────
    selfie_faces = detect_faces(selfie_img)
    checks["face_in_selfie"] = len(selfie_faces) > 0

    if not checks["face_in_selfie"]:
        issues.append(t("no_face_in_selfie", lang))

    selfie_face_box = None
    if checks["face_in_selfie"]:
        selfie_face_box = max(selfie_faces, key=lambda b: b[2] * b[3])
        passport_valid, selfie_issues, selfie_debug = validate_selfie_passport_style(selfie_img, selfie_face_box, lang)
        checks["passport_selfie"] = passport_valid
        issues.extend(selfie_issues)
        logger.info(f"Passport selfie: valid={passport_valid} debug={selfie_debug}")

        if not is_cert:
            id_faces = detect_faces(front_img)
            checks["face_in_id"] = len(id_faces) > 0
            if not checks["face_in_id"]:
                issues.append(t("no_face_in_id", lang))

            if checks["face_in_id"]:
                match, sim, _ = match_faces(front_img, selfie_img)
                checks["face_match"] = match
                if not match:
                    issues.append(t("face_match_failed", lang, sim=int(sim * 100)))
        else:
            cert_faces = detect_faces(front_img)
            if cert_faces:
                match, sim, _ = match_faces(front_img, selfie_img)
                checks["face_match"] = match
                if not match:
                    issues.append(t("cert_face_match_warning", lang, sim=int(sim * 100)))
                logger.info(f"Cert face match: {match} sim={sim:.3f}")
            else:
                checks["face_match"] = True
                logger.info("Cert face match: no face detected in cert — skipped")
    else:
        checks["passport_selfie"] = False
        checks["face_match"] = False

    # ── OCR ───────────────────────────────────────────────────
    if is_cert:
        ocr_text = ocr_all_pages(cert_pages)
    else:
        ocr_text = ocr_extract(front_img)

    logger.info(f"OCR raw [{doc_type}]: {ocr_text[:400].replace(chr(10), ' ')}")

    # ── v1.5.1: Extract structured fields from OCR ────────────
    if is_cert:
        ocr_fields = extract_ocr_fields_cert(ocr_text)
    else:
        ocr_fields = extract_ocr_fields(ocr_text)

    # ── ID Number validation ──────────────────────────────────
    checks["ocr_id"] = validate_id_in_ocr(ocr_text, req.id_number)
    if not checks["ocr_id"]:
        doc_type_name = t("replacementCert", lang) if is_cert else t("nationalId", lang)
        issues.append(t("id_not_found", lang, id=req.id_number, doc_type=doc_type_name))

    # ── v1.5.1: Name validation ───────────────────────────────
    name_valid, name_debug = validate_name_in_ocr(
        ocr_text, req.first_name, req.last_name,
        extracted_name=ocr_fields.get("name")
    )
    checks["name_match"] = name_valid
    if not name_valid:
        doc_type_name = t("replacementCert", lang) if is_cert else t("nationalId", lang)
        issues.append(t("name_mismatch", lang, name=f"{req.first_name} {req.last_name}", doc_type=doc_type_name))

    # ── v1.5.1: Gender validation ─────────────────────────────
    gender_valid, gender_debug = validate_gender_in_ocr(ocr_fields, req.gender)
    checks["gender_match"] = gender_valid
    if not gender_valid and ocr_fields.get("gender"):
        doc_type_name = t("replacementCert", lang) if is_cert else t("nationalId", lang)
        issues.append(t("gender_mismatch", lang, gender=req.gender, doc_type=doc_type_name, ocr_gender=ocr_fields.get("gender")))

    # ── v1.5.1: DOB validation ────────────────────────────────
    if req.dob:
        dob_valid, dob_debug = validate_dob_in_ocr(ocr_fields, req.dob)
        checks["dob_match"] = dob_valid
        if not dob_valid and ocr_fields.get("dob"):
            doc_type_name = t("replacementCert", lang) if is_cert else t("nationalId", lang)
            issues.append(t("dob_mismatch", lang, dob=req.dob, doc_type=doc_type_name, ocr_dob=ocr_fields.get("dob")))
    else:
        checks["dob_match"] = True

    # ── Cert-specific checks ──────────────────────────────────
    if is_cert:
        kw_valid, found_kw, missing_kw = validate_certificate_keywords(ocr_text)
        checks["cert_keywords"] = kw_valid
        if not kw_valid:
            issues.append(t("cert_not_valid", lang, keywords=", ".join(missing_kw)))

        expiry_ok, expiry_str = check_cert_expiry(ocr_text)
        checks["cert_expiry"] = expiry_ok
        if not expiry_ok and expiry_str != "unknown":
            issues.append(t("cert_expired", lang, date=expiry_str))

    # ── Score & final decision ────────────────────────────────
    score    = compute_score(checks, weights)
    critical = critical_checks_pass(checks, doc_type)
    status   = "approved" if (critical and score >= 0.65) else "rejected"

    if status == "approved":
        issues = []

    logger.info(
        f"Result [{doc_type}] [{lang}]: {status} | score={score:.3f} | "
        f"critical={critical} | issues={len(issues)} | checks={checks}"
    )

    return KYCResponse(
        status=status,
        score=score,
        issues=issues,
        ocr_fields=ocr_fields,
        lang=lang,
    )


@app.get("/")
async def root():
    return {
        "service":     "KoraLink KYC API",
        "version":     "1.6.0",
        "dnn_model":   os.path.exists(CAFFEMODEL_PATH),
        "dlib_available": DLIB_AVAILABLE,
        "dlib_model":  os.path.exists(PREDICTOR_PATH) if DLIB_AVAILABLE else False,
        "pdf_support": PDF2IMAGE_AVAILABLE,
        "ocr_lang":    OCR_LANG,
        "status":      "running",
        "modes":       ["id", "cert"],
        "languages":   ["en", "rw"],
        "ocr_field_validation": "v1.5.1",
        "i18n_version": "v1.6.0",
        "validated_fields_id":   ["id_number", "name", "gender", "dob"],
        "validated_fields_cert": ["id_number", "name", "gender", "dob", "expiry", "face_match"],
    }


@app.get("/health")
async def health():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=7860, reload=True)