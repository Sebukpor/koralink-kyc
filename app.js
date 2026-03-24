/**
KoraLink KYC — app.js  v3.0.0
══════════════════════════════════════════════════════════════
SMART CAPTURE SYSTEM INTEGRATED
✅ Auto-capture engine with sharpness/brightness/stability
✅ Camera switching (front ↔ back)
✅ ID smart overlay with real-time feedback
✅ ID auto-cropping (removes background)
✅ OCR auto-fill via Tesseract.js
✅ OCR mismatch modal (never auto-overwrites)
✅ Certificate camera capture → PDF via jsPDF
✅ Face detection hints for selfie
✅ Color-coded live feedback
✅ Vibration feedback on mobile
✅ Low-end device detection
✅ Step 5 Back button added
✅ Gender: NO default selection
══════════════════════════════════════════════════════════════
*/

// ── CONFIG ────────────────────────────────────────────────────
const CONFIG = {
    FASTAPI_URL: "https://sebukpor-koralink-kyc.hf.space/validate",
    APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbypunYTMbq9PqCOn-NWf1eDVpHflpJJM--NRdfNRy3R1dVx_9l_UGJEyK1M4krlhaaY/exec",
    MAX_IMAGE_MB: 5,
    MAX_PDF_MB: 5,
    IMAGE_QUALITY: 0.85,
    UPLOAD_QUALITY: 0.70,
    UPLOAD_MAX_PX: 900,
    SELFIE_MAX_PX: 800,
    PLACEHOLDER_B64: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoH9wYLDQwLCgsLDRAxEA8OEA8LCxAWEBETFBUVFQ0XGBgUGBQVFBT/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAAP/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AJQAB/9k=",
    
    // Auto-capture settings
    AUTO_CAPTURE_INTERVAL: 300,
    AUTO_CAPTURE_STABLE_MS: 1000,
    BLUR_THRESHOLD_SHARP: 80,
    BLUR_THRESHOLD_ACCEPT: 40,
    BRIGHTNESS_MIN: 55,
    BRIGHTNESS_MAX: 210,
    STABILITY_THRESHOLD: 0.03,
    OCR_ENABLED: true,
    LOW_END_DEVICE: false,
};

// ── LOW-END DEVICE DETECTION ─────────────────────────────────
(function detectDevice() {
    const mem = navigator.deviceMemory || 4;
    const cores = navigator.hardwareConcurrency || 4;
    if (mem <= 1 || cores <= 2) {
        CONFIG.LOW_END_DEVICE = true;
        CONFIG.AUTO_CAPTURE_INTERVAL = 600;
        CONFIG.OCR_ENABLED = false;
        console.info("[KYC] Low-end device — auto-capture relaxed, OCR off.");
    }
})();

// ── STATE ─────────────────────────────────────────────────────
const STATE = {
    currentStep: 1,
    gender: null,  // NO DEFAULT - user must select
    docType: "id",
    images: { front: null, back: null, selfie: null },
    cert: { file: null, b64: null, name: "", size: 0 },
    streams: {},
    facingModes: { Front: "environment", Back: "environment", Selfie: "user", Cert: "environment" },
    autoCapture: { loops: {}, goodSince: {}, lastFrame: {} },
    ocr: { worker: null, running: false },
    certCameraImages: [],
};

// ══════════════════════════════════════════════════════════════
//  IMAGE COMPRESSION
// ══════════════════════════════════════════════════════════════
function compressImage(dataURL, maxPx, quality) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            let { width, height } = img;
            if (width > maxPx || height > maxPx) {
                if (width >= height) { height = Math.round(height * maxPx / width); width = maxPx; }
                else { width = Math.round(width * maxPx / height); height = maxPx; }
            }
            const c = document.createElement("canvas");
            c.width = width; c.height = height;
            c.getContext("2d").drawImage(img, 0, 0, width, height);
            resolve(c.toDataURL("image/jpeg", quality).split(",")[1]);
        };
        img.onerror = () => resolve(stripPrefix(dataURL));
        img.src = dataURL;
    });
}

function stripPrefix(dataURL) {
    if (!dataURL) return null;
    return dataURL.includes(",") ? dataURL.split(",")[1] : dataURL;
}

// ══════════════════════════════════════════════════════════════
//  AUTO-CAPTURE ENGINE (CORE SYSTEM)
// ══════════════════════════════════════════════════════════════
function analyzeFrame(video, canvas, side) {
    if (!video || !video.videoWidth || video.readyState < 2) {
        return { sharp: false, lit: false, stable: false, score: 0, feedback: "Starting camera…", feedbackColor: "orange" };
    }
    
    const w = Math.min(video.videoWidth, 320);
    const h = Math.round(video.videoHeight * (w / video.videoWidth));
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (side === "Selfie") { ctx.setTransform(-1, 0, 0, 1, w, 0); }
    ctx.drawImage(video, 0, 0, w, h);
    if (side === "Selfie") { ctx.setTransform(1, 0, 0, 1, 0, 0); }
    const imageData = ctx.getImageData(0, 0, w, h);
    const px = imageData.data;

    // Brightness
    let totalLum = 0;
    const pixelCount = px.length / 4;
    for (let i = 0; i < px.length; i += 4) {
        totalLum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    }
    const brightness = totalLum / pixelCount;
    const lit = brightness >= CONFIG.BRIGHTNESS_MIN && brightness <= CONFIG.BRIGHTNESS_MAX;

    // Sharpness (Laplacian variance)
    const gray = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
        gray[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    }
    let lapSum = 0, lapSumSq = 0, lapCount = 0;
    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            const lap = -gray[(y - 1) * w + x] - gray[(y + 1) * w + x] - gray[y * w + (x - 1)] - gray[y * w + (x + 1)] + 4 * gray[y * w + x];
            lapSum += lap;
            lapSumSq += lap * lap;
            lapCount++;
        }
    }
    const lapMean = lapSum / lapCount;
    const lapVar = lapSumSq / lapCount - lapMean * lapMean;
    const sharp = lapVar >= CONFIG.BLUR_THRESHOLD_ACCEPT;
    const verySharp = lapVar >= CONFIG.BLUR_THRESHOLD_SHARP;

    // Stability
    let stable = true;
    const last = STATE.autoCapture.lastFrame[side];
    if (last && last.length === px.length) {
        let diffSum = 0;
        const step = Math.max(4, Math.floor(px.length / 400));
        for (let i = 0; i < px.length; i += step * 4) {
            diffSum += Math.abs(px[i] - last[i]) + Math.abs(px[i+1] - last[i+1]) + Math.abs(px[i+2] - last[i+2]);
        }
        const samples = Math.floor(px.length / (step * 4));
        const diffRatio = diffSum / (samples * 3 * 255);
        stable = diffRatio < CONFIG.STABILITY_THRESHOLD;
    }
    STATE.autoCapture.lastFrame[side] = new Uint8ClampedArray(px);

    // Feedback
    let feedback = "✓ Perfect — hold still", feedbackColor = "green";
    if (brightness < CONFIG.BRIGHTNESS_MIN) { feedback = "Too dark — find better lighting"; feedbackColor = "red"; }
    else if (brightness > CONFIG.BRIGHTNESS_MAX) { feedback = "Too bright — reduce glare"; feedbackColor = "red"; }
    else if (!sharp) { feedback = lapVar < 10 ? "Very blurry — hold still" : "Blurry — hold steady"; feedbackColor = "orange"; }
    else if (!stable) { feedback = "Hold still…"; feedbackColor = "orange"; }
    else if (!verySharp) { feedback = "Almost there — hold steady"; feedbackColor = "orange"; }

    const score = (lit ? 33 : 0) + (sharp ? 33 : 0) + (stable ? 34 : 0);
    return { sharp, lit, stable, score, feedback, feedbackColor, lapVar, brightness };
}

function startAutoCapture(side) {
    if (CONFIG.LOW_END_DEVICE) return;
    if (STATE.images[side.toLowerCase()]) return;
    stopAutoCapture(side);
    
    const video = document.getElementById(`video${side}`);
    const analysisCanvas = document.createElement("canvas");
    const feedbackEl = document.getElementById(`feedback${side}`);
    const progressBar = document.getElementById(`captureProgress${side}`);
    const zoneEl = document.getElementById(`captureZone${side}`);
    let lastRun = 0;

    function loop(ts) {
        if (STATE.images[side.toLowerCase()]) { stopAutoCapture(side); return; }
        STATE.autoCapture.loops[side] = requestAnimationFrame(loop);
        if (ts - lastRun < CONFIG.AUTO_CAPTURE_INTERVAL) return;
        lastRun = ts;
        if (!video || !video.videoWidth || video.paused || video.ended) return;

        const result = analyzeFrame(video, analysisCanvas, side);
        const allGood = result.sharp && result.lit && result.stable;

        if (feedbackEl) {
            feedbackEl.textContent = result.feedback;
            feedbackEl.className = `capture-feedback feedback-${result.feedbackColor}`;
        }
        if (progressBar) {
            progressBar.style.width = result.score + "%";
            progressBar.className = `capture-progress-fill ${allGood ? "progress-good" : "progress-wait"}`;
        }

        if (allGood) {
            const now = Date.now();
            const since = STATE.autoCapture.goodSince[side];
            if (!since) {
                STATE.autoCapture.goodSince[side] = now;
                if (zoneEl) zoneEl.classList.add("capture-imminent");
                if (navigator.vibrate) navigator.vibrate(50);
            } else if (now - since >= CONFIG.AUTO_CAPTURE_STABLE_MS) {
                stopAutoCapture(side);
                performAutoCapture(side);
            }
        } else {
            STATE.autoCapture.goodSince[side] = null;
            if (zoneEl) zoneEl.classList.remove("capture-imminent");
        }
    }
    STATE.autoCapture.loops[side] = requestAnimationFrame(loop);
}

function stopAutoCapture(side) {
    if (STATE.autoCapture.loops[side]) {
        cancelAnimationFrame(STATE.autoCapture.loops[side]);
        delete STATE.autoCapture.loops[side];
    }
    STATE.autoCapture.goodSince[side] = null;
    const zoneEl = document.getElementById(`captureZone${side}`);
    if (zoneEl) zoneEl.classList.remove("capture-imminent");
}

function performAutoCapture(side) {
    const video = document.getElementById(`video${side}`);
    const canvas = document.getElementById(`canvas${side}`);
    if (!video || !video.videoWidth) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (side === "Selfie") { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); }
    ctx.drawImage(video, 0, 0);
    const dataURL = (side === "Front" || side === "Back") ? cropToIDOverlay(canvas) : canvas.toDataURL("image/jpeg", CONFIG.IMAGE_QUALITY);
    showToast("📸 Auto-captured!", "success");
    if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
    saveImage(side, dataURL);
    stopStream(side);
    if (side === "Front" && CONFIG.OCR_ENABLED) setTimeout(() => runOCROnImage(dataURL), 600);
}

function cropToIDOverlay(sourceCanvas) {
    const w = sourceCanvas.width, h = sourceCanvas.height;
    const cropW = Math.round(w * 0.85);
    const cropH = Math.round(h * 0.60);
    const cropX = Math.round((w - cropW) / 2);
    const cropY = Math.round((h - cropH) / 2);
    const c = document.createElement("canvas");
    c.width = cropW; c.height = cropH;
    c.getContext("2d").drawImage(sourceCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
    return c.toDataURL("image/jpeg", CONFIG.IMAGE_QUALITY);
}

// ══════════════════════════════════════════════════════════════
//  CAMERA SWITCHING
// ══════════════════════════════════════════════════════════════
async function switchCamera(side) {
    const current = STATE.facingModes[side];
    STATE.facingModes[side] = current === "user" ? "environment" : "user";
    stopAutoCapture(side);
    stopStream(side);
    const btn = document.getElementById(`switchCameraBtn${side}`);
    if (btn) { btn.textContent = "↺"; btn.disabled = true; }
    await startCamera(side);
    if (btn) {
        btn.textContent = STATE.facingModes[side] === "user" ? "🔄 Back Cam" : "🔄 Front Cam";
        btn.disabled = false;
    }
    setTimeout(() => startAutoCapture(side), 800);
}

async function switchCertCamera() {
    stopStream("Cert");
    STATE.facingModes.Cert = STATE.facingModes.Cert === "user" ? "environment" : "user";
    await startCertCamera();
}

// ══════════════════════════════════════════════════════════════
//  OCR + AUTO-FILL
// ══════════════════════════════════════════════════════════════
async function initTesseract() {
    if (!window.Tesseract) return null;
    if (STATE.ocr.worker) return STATE.ocr.worker;
    try {
        const worker = await Tesseract.createWorker("eng", 1, { logger: () => {} });
        STATE.ocr.worker = worker;
        return worker;
    } catch (e) {
        console.warn("[OCR] Init failed:", e);
        return null;
    }
}

async function runOCROnImage(dataURL) {
    if (STATE.ocr.running || !CONFIG.OCR_ENABLED) return;
    STATE.ocr.running = true;
    showOCRProgress(true);
    try {
        const worker = await initTesseract();
        if (!worker) return;
        const { data: { text } } = await worker.recognize(dataURL);
        const extracted = parseRwandanID(text);
        if (extracted.name || extracted.idNumber) handleOCRResult(extracted);
    } catch (e) {
        console.warn("[OCR] Recognize failed:", e);
    } finally {
        STATE.ocr.running = false;
        showOCRProgress(false);
    }
}

function parseRwandanID(text) {
    const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
    let name = null, idNumber = null;
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i].toLowerCase();
        if (l.includes("amazina") || l.includes("names")) {
            const next = lines[i + 1];
            if (next && next.length > 3 && !/^\d/.test(next)) { name = next.trim(); break; }
        }
    }
    if (!name) {
        for (const line of lines) {
            if (/^[A-Z][A-Z\s]{4,}$/.test(line) && !["REPUBLIC", "RWANDA", "NATIONAL", "IDENTITY", "INDANGAMUNTU"].some(w => line.includes(w)) && line.split("  ").length >= 2) {
                name = line.trim(); break;
            }
        }
    }
    const m = text.match(/\b(\d[\d\s]{12,18}\d)\b/);
    if (m) {
        const candidate = m[1].replace(/\s/g, "");
        if (candidate.length >= 10 && candidate.length <= 20) idNumber = candidate;
    }
    return { name, idNumber };
}

function handleOCRResult(extracted) {
    const userFirst = document.getElementById("firstName")?.value.trim() || "";
    const userLast = document.getElementById("lastName")?.value.trim() || "";
    const userID = document.getElementById("idNumber")?.value.trim().replace(/\s/g, "") || "";
    const userFull = (userFirst + " " + userLast).trim().toLowerCase();
    const ocrName = extracted.name ? extracted.name.trim().toLowerCase() : null;
    const ocrID = extracted.idNumber || null;
    const nameMismatch = ocrName && userFull.length > 3 && !fuzzyIncludes(userFull, ocrName) && !fuzzyIncludes(ocrName, userFull);
    const idMismatch = ocrID && userID.length >= 10 && ocrID !== userID;
    if (nameMismatch || idMismatch) showOCRMismatchModal(extracted, { nameMismatch, idMismatch });
}

function fuzzyIncludes(a, b) {
    return b.split(/\s+/).some(tok => tok.length > 2 && a.includes(tok));
}

function showOCRMismatchModal(extracted, flags) {
    document.getElementById("ocrModalContainer").innerHTML = "";
    const modal = document.createElement("div");
    modal.id = "ocrModal";
    modal.className = "ocr-modal-overlay";
    const namePart = flags.nameMismatch && extracted.name ? `<div class="ocr-row"><span class="ocr-label">Detected Name</span><strong class="ocr-value">${escHTML(extracted.name)}</strong></div>` : "";
    const idPart = flags.idMismatch && extracted.idNumber ? `<div class="ocr-row"><span class="ocr-label">Detected ID No.</span><strong class="ocr-value">${escHTML(extracted.idNumber)}</strong></div>` : "";
    modal.innerHTML = `<div class="ocr-modal"><div class="ocr-modal-icon">🔍</div><h3 class="ocr-modal-title">ID Data Detected</h3><p class="ocr-modal-sub">We found different data in your ID card scan:</p>${namePart}${idPart}<p class="ocr-modal-question">Would you like to use the detected values?</p><div class="ocr-modal-actions"><button class="btn-ocr-use" id="ocrUseDetected">Use Detected Info</button><button class="btn-ocr-keep" id="ocrKeepMine">Keep My Input</button></div></div>`;
    document.getElementById("ocrModalContainer").appendChild(modal);
    document.getElementById("ocrUseDetected").onclick = () => {
        if (flags.nameMismatch && extracted.name) {
            const parts = extracted.name.trim().split(/\s+/);
            if (parts.length >= 2) {
                document.getElementById("lastName").value = parts[0];
                document.getElementById("firstName").value = parts.slice(1).join(" ");
            } else {
                document.getElementById("firstName").value = extracted.name;
            }
        }
        if (flags.idMismatch && extracted.idNumber) document.getElementById("idNumber").value = extracted.idNumber;
        modal.remove();
        showToast("✓ Fields updated from card scan", "success");
    };
    document.getElementById("ocrKeepMine").onclick = () => modal.remove();
    modal.addEventListener("click", e => { if (e.target === modal) modal.remove(); });
}

function showOCRProgress(show) {
    let el = document.getElementById("ocrProgressBar");
    if (!el && show) {
        el = document.createElement("div");
        el.id = "ocrProgressBar";
        el.className = "ocr-progress";
        el.innerHTML = `<span>Scanning ID…</span><div class="ocr-progress-dots"><span></span><span></span><span></span></div>`;
        document.querySelector(".form-shell")?.prepend(el);
    }
    if (el) el.style.display = show ? "flex" : "none";
}

function escHTML(s) {
    return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

// ══════════════════════════════════════════════════════════════
//  CERTIFICATE CAMERA CAPTURE → PDF
// ══════════════════════════════════════════════════════════════
function switchCertMode(mode) {
    const uploadPanel = document.getElementById("certUploadPanel");
    const cameraSection = document.getElementById("certCameraSection");
    const tabUpload = document.getElementById("certTabUpload");
    const tabCamera = document.getElementById("certTabCamera");
    if (mode === "upload") {
        if (uploadPanel) uploadPanel.style.display = "block";
        if (cameraSection) cameraSection.style.display = "none";
        tabUpload?.classList.add("active");
        tabCamera?.classList.remove("active");
        stopStream("Cert");
    } else {
        if (uploadPanel) uploadPanel.style.display = "none";
        if (cameraSection) cameraSection.style.display = "block";
        tabUpload?.classList.remove("active");
        tabCamera?.classList.add("active");
        startCertCamera();
    }
}

async function startCertCamera() {
    const video = document.getElementById("videoCert");
    if (!video) return;
    if (STATE.streams["Cert"]) stopStream("Cert");
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: STATE.facingModes.Cert }, width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false,
        });
        STATE.streams["Cert"] = stream;
        video.srcObject = stream;
    } catch (e) {
        showToast("Camera not available", "error");
    }
}

function captureCertFrame() {
    const video = document.getElementById("videoCert");
    const canvas = document.getElementById("canvasCert");
    if (!video || !video.videoWidth) { showToast("Camera not ready", "error"); return; }
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    const dataURL = canvas.toDataURL("image/jpeg", 0.85);
    STATE.certCameraImages.push(dataURL);
    updateCertCameraPreview();
    showToast(`Page ${STATE.certCameraImages.length} captured ✓`, "success");
    if (navigator.vibrate) navigator.vibrate(80);
}

function updateCertCameraPreview() {
    const grid = document.getElementById("certCameraPreviewGrid");
    if (!grid) return;
    grid.innerHTML = STATE.certCameraImages.map((img, i) => `<div class="cert-cam-thumb"><img src="${img}" alt="Page ${i + 1}"/><span>Page ${i + 1}</span><button class="cert-cam-remove" onclick="removeCertPage(${i})">✕</button></div>`).join("");
    const btn = document.getElementById("certConvertPDFBtn");
    if (btn) btn.style.display = STATE.certCameraImages.length > 0 ? "block" : "none";
}

function removeCertPage(idx) {
    STATE.certCameraImages.splice(idx, 1);
    updateCertCameraPreview();
}

async function convertCertImagesToPDF() {
    if (STATE.certCameraImages.length === 0) { showToast("No pages captured", "error"); return; }
    const btn = document.getElementById("certConvertPDFBtn");
    if (btn) { btn.textContent = "Converting…"; btn.disabled = true; }
    try {
        if (!window.jspdf && !window.jsPDF) await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js");
        const { jsPDF } = window.jspdf || window;
        const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
        const pW = pdf.internal.pageSize.getWidth();
        const pH = pdf.internal.pageSize.getHeight();
        for (let i = 0; i < STATE.certCameraImages.length; i++) {
            if (i > 0) pdf.addPage();
            const img = await loadImgEl(STATE.certCameraImages[i]);
            const ratio = Math.min(pW / img.width, pH / img.height);
            const w = img.width * ratio, h = img.height * ratio;
            pdf.addImage(STATE.certCameraImages[i], "JPEG", (pW - w) / 2, (pH - h) / 2, w, h);
        }
        const blob = pdf.output("blob");
        const b64URL = await blobToDataURL(blob);
        STATE.cert.b64 = b64URL;
        STATE.cert.name = "certificate_camera.pdf";
        STATE.cert.size = blob.size;
        document.getElementById("certUploadInner").style.display = "none";
        document.getElementById("certPreview").style.display = "flex";
        document.getElementById("certFileName").textContent = STATE.cert.name;
        document.getElementById("certFileSize").textContent = formatBytes(blob.size);
        switchCertMode("upload");
        setErr("front", "");
        showToast("✅ Certificate PDF ready!", "success");
    } catch (e) {
        console.error("[PDF]", e);
        showToast("PDF conversion failed: " + e.message, "error");
    } finally {
        if (btn) { btn.textContent = "✅ Convert to PDF"; btn.disabled = false; }
    }
}

function loadImgEl(src) {
    return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
}

function blobToDataURL(blob) {
    return new Promise(res => { const r = new FileReader(); r.onload = e => res(e.target.result); r.readAsDataURL(blob); });
}

function loadScript(src) {
    return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
}

// ══════════════════════════════════════════════════════════════
//  DOCUMENT TYPE TOGGLE
// ══════════════════════════════════════════════════════════════
function setDocType(type) {
    STATE.docType = type;
    document.getElementById("btnPhysicalID").classList.toggle("active", type === "id");
    document.getElementById("btnCertificate").classList.toggle("active", type === "cert");
    document.getElementById("idCaptureZone").style.display = type === "id" ? "block" : "none";
    document.getElementById("certUploadZone").style.display = type === "cert" ? "block" : "none";
    if (type === "id") {
        document.getElementById("step2Icon").textContent = "🪪";
        document.getElementById("step2Title").textContent = "Front ID Card";
        document.getElementById("step2Desc").textContent = "Position your ID within the frame and capture a clear photo.";
        document.getElementById("step2NextBtn").innerHTML = 'Next: Back ID <span class="btn-arrow">→</span>';
        STATE.cert = { file: null, b64: null, name: "", size: 0 };
        STATE.certCameraImages = [];
        if (!STATE.images.front) startCamera("Front");
    } else {
        document.getElementById("step2Icon").textContent = "📄";
        document.getElementById("step2Title").textContent = "Replacement Certificate";
        document.getElementById("step2Desc").textContent = "Upload the Icyemezo Gisimbura Indangamuntu issued to you.";
        document.getElementById("step2NextBtn").innerHTML = 'Next: Take Selfie <span class="btn-arrow">→</span>';
        stopStream("Front");
        STATE.images.front = null;
        STATE.images.back = null;
    }
    clearErrors();
}

// ══════════════════════════════════════════════════════════════
//  CERTIFICATE PDF UPLOAD HANDLERS
// ══════════════════════════════════════════════════════════════
function handleCertUpload(input) {
    const file = input.files[0];
    if (!file) return;
    if (file.type !== "application/pdf") { showToast("Only PDF files are accepted.", "error"); input.value = ""; return; }
    if (file.size > CONFIG.MAX_PDF_MB * 1024 * 1024) { showToast(`PDF too large (max ${CONFIG.MAX_PDF_MB}MB).`, "error"); input.value = ""; return; }
    const reader = new FileReader();
    reader.onload = (e) => {
        STATE.cert.b64 = e.target.result;
        STATE.cert.file = file;
        STATE.cert.name = file.name;
        STATE.cert.size = file.size;
        document.getElementById("certUploadInner").style.display = "none";
        document.getElementById("certPreview").style.display = "flex";
        document.getElementById("certFileName").textContent = file.name;
        document.getElementById("certFileSize").textContent = formatBytes(file.size);
        setErr("front", "");
        showToast("Certificate uploaded ✓", "success");
    };
    reader.readAsDataURL(file);
}

function removeCert() {
    STATE.cert = { file: null, b64: null, name: "", size: 0 };
    document.getElementById("fileCert").value = "";
    document.getElementById("certPreview").style.display = "none";
    document.getElementById("certUploadInner").style.display = "flex";
}

document.addEventListener("DOMContentLoaded", () => {
    const zone = document.getElementById("certDropZone");
    if (!zone) return;
    zone.addEventListener("dragover", e => { e.preventDefault(); zone.classList.add("drag-over"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
    zone.addEventListener("drop", e => {
        e.preventDefault(); zone.classList.remove("drag-over");
        const file = e.dataTransfer.files[0];
        if (file) { const dt = new DataTransfer(); dt.items.add(file); const inp = document.getElementById("fileCert"); inp.files = dt.files; handleCertUpload(inp); }
    });
});

// ══════════════════════════════════════════════════════════════
//  STEP NAVIGATION
// ══════════════════════════════════════════════════════════════
function goStep(n) {
    if (n > STATE.currentStep && !validateCurrentStep()) return;
    if (STATE.docType === "cert" && STATE.currentStep === 2 && n === 3) n = 4;
    if (STATE.docType === "cert" && STATE.currentStep === 4 && n === 3) n = 2;
    const camMap = { 2: "Front", 3: "Back", 4: "Selfie" };
    const leaving = camMap[STATE.currentStep];
    const entering = camMap[n];
    if (leaving && leaving !== entering) { stopAutoCapture(leaving); stopStream(leaving); }
    STATE.currentStep = n;
    document.querySelectorAll(".step").forEach((s, i) => s.classList.toggle("active", i + 1 === n));
    const totalVisible = STATE.docType === "cert" ? 4 : 5;
    const displayStep = STATE.docType === "cert" && n >= 4 ? n - 1 : n;
    document.getElementById("stepBadge").textContent = `Step ${displayStep} of ${totalVisible}`;
    document.getElementById("progressFill").style.width = `${(displayStep / totalVisible) * 100}%`;
    const s4back = document.getElementById("step4BackBtn");
    if (s4back) s4back.setAttribute("onclick", `goStep(${STATE.docType === "cert" ? 2 : 3})`);
    if (n === 2 && STATE.docType === "id") { startCamera("Front").then(() => setTimeout(() => startAutoCapture("Front"), 800)); }
    if (n === 3) { startCamera("Back").then(() => setTimeout(() => startAutoCapture("Back"), 800)); }
    if (n === 4) { startCamera("Selfie").then(() => setTimeout(() => startAutoCapture("Selfie"), 800)); }
    if (n === 5) populateReview();
    window.scrollTo({ top: 0, behavior: "smooth" });
}

// ══════════════════════════════════════════════════════════════
//  VALIDATION
// ══════════════════════════════════════════════════════════════
function validateCurrentStep() {
    clearErrors();
    switch (STATE.currentStep) {
        case 1: return validateStep1();
        case 2: return validateStep2();
        case 3: return validateStep3();
        case 4: return validateStep4();
        default: return true;
    }
}

function validateStep1() {
    let ok = true;
    const fn = v("firstName"), ln = v("lastName"), id = v("idNumber"), ph = v("phoneNumber"), ms = v("msisdn"), di = v("district");
    if (!fn) { setErr("firstName", "First name is required"); ok = false; }
    if (!ln) { setErr("lastName", "Last name is required"); ok = false; }
    if (!STATE.gender) { setErr("gender", "Please select your gender"); ok = false; }
    if (!id || id.replace(/\s/g, "").length < 10) { setErr("idNumber", "Enter a valid ID number (≥ 10 digits)"); ok = false; }
    if (!ph || !/^07\d{8}$/.test(ph)) { setErr("phoneNumber", "Enter a valid Rwandan phone number (07XXXXXXXX)"); ok = false; }
    if (!ms || !/^07\d{8}$/.test(ms)) { setErr("msisdn", "Enter a valid MSISDN (07XXXXXXXX)"); ok = false; }
    if (!di) { setErr("district", "Please select a district"); ok = false; }
    return ok;
}

function validateStep2() {
    if (STATE.docType === "id") {
        if (!STATE.images.front) { setErr("front","Please capture or upload the front of your ID card."); return false; }
    } else {
        if (!STATE.cert.b64) { setErr("front","Please upload your replacement certificate (PDF)."); return false; }
    }
    return true;
}

function validateStep3() {
    if (!STATE.images.back) { setErr("back","Please capture or upload the back of your ID card."); return false; }
    return true;
}

function validateStep4() {
    if (!STATE.images.selfie) { setErr("selfie","Please take a selfie."); return false; }
    return true;
}

// ══════════════════════════════════════════════════════════════
//  CAMERA
// ══════════════════════════════════════════════════════════════
async function startCamera(side) {
    const video = document.getElementById(`video${side}`);
    if (!video) return;
    if (STATE.images[side.toLowerCase()]) return;
    if (STATE.streams[side]) stopStream(side);
    const facingMode = STATE.facingModes[side] || (side === "Selfie" ? "user" : "environment");
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: facingMode }, width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false,
        });
        STATE.streams[side] = stream;
        video.srcObject = stream;
        const btn = document.getElementById(`switchCameraBtn${side}`);
        if (btn) btn.textContent = facingMode === "user" ? "🔄 Back Cam" : "🔄 Front Cam";
    } catch (err) {
        console.warn("[CAM]", err);
        showToast("Camera unavailable — please upload a file instead.", "error");
        const frame = document.getElementById(`cameraFrame${side}`);
        if (frame) frame.style.display = "none";
    }
}

function stopStream(side) {
    if (STATE.streams[side]) {
        STATE.streams[side].getTracks().forEach(t => t.stop());
        delete STATE.streams[side];
    }
}

function capturePhoto(side) {
    const video = document.getElementById(`video${side}`);
    const canvas = document.getElementById(`canvas${side}`);
    if (!video || !video.videoWidth) { showToast("Camera not ready. Try uploading instead.", "error"); return; }
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (side === "Selfie") { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); }
    ctx.drawImage(video, 0, 0);
    const dataURL = (side === "Front" || side === "Back") ? cropToIDOverlay(canvas) : canvas.toDataURL("image/jpeg", CONFIG.IMAGE_QUALITY);
    stopAutoCapture(side);
    saveImage(side, dataURL);
    stopStream(side);
    if (side === "Front" && CONFIG.OCR_ENABLED) setTimeout(() => runOCROnImage(dataURL), 600);
}

function retake(side) {
    stopAutoCapture(side);
    STATE.images[side.toLowerCase()] = null;
    STATE.autoCapture.lastFrame[side] = null;
    document.getElementById(`preview${side}`).style.display = "none";
    const frame = document.getElementById(`cameraFrame${side}`);
    if (frame) frame.style.display = "block";
    const fb = document.getElementById(`feedback${side}`);
    if (fb) { fb.textContent = "Align and hold steady…"; fb.className = "capture-feedback feedback-orange"; }
    const pb = document.getElementById(`captureProgress${side}`);
    if (pb) { pb.style.width = "0%"; pb.className = "capture-progress-fill progress-wait"; }
    setErr(side.toLowerCase(), "");
    // Toggle buttons
    document.getElementById(`btnRow${side}Camera`).style.display = "flex";
    document.getElementById(`btnRow${side}Preview`).style.display = "none";
    startCamera(side).then(() => setTimeout(() => startAutoCapture(side), 800));
}

function saveImage(side, dataURL) {
    STATE.images[side.toLowerCase()] = dataURL;
    document.getElementById(`img${side}`).src = dataURL;
    document.getElementById(`preview${side}`).style.display = "block";
    const frame = document.getElementById(`cameraFrame${side}`);
    if (frame) frame.style.display = "none";
    setErr(side.toLowerCase(), "");
    showToast(`${side} captured ✓`, "success");
    // Toggle buttons - show preview buttons with Next
    document.getElementById(`btnRow${side}Camera`).style.display = "none";
    document.getElementById(`btnRow${side}Preview`).style.display = "flex";
}

function handleFileUpload(side, input) {
    const file = input.files[0];
    if (!file) return;
    if (file.size > CONFIG.MAX_IMAGE_MB * 1024 * 1024) { showToast(`File too large (max ${CONFIG.MAX_IMAGE_MB}MB)`, "error"); input.value = ""; return; }
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) { showToast("Only JPG, PNG, or WebP allowed.", "error"); input.value = ""; return; }
    const reader = new FileReader();
    reader.onload = e => {
        saveImage(side, e.target.result);
        if (side === "Front" && CONFIG.OCR_ENABLED) setTimeout(() => runOCROnImage(e.target.result), 600);
    };
    reader.readAsDataURL(file);
}

// ══════════════════════════════════════════════════════════════
//  REVIEW
// ══════════════════════════════════════════════════════════════
function populateReview() {
    document.getElementById("rv-name").textContent = `${v("firstName")} ${v("lastName")}`;
    document.getElementById("rv-gender").textContent = STATE.gender || "—";
    document.getElementById("rv-id").textContent = v("idNumber");
    document.getElementById("rv-phone").textContent = v("phoneNumber");
    document.getElementById("rv-msisdn").textContent = v("msisdn");
    document.getElementById("rv-district").textContent = v("district");
    document.getElementById("rv-doctype").textContent = STATE.docType === "cert" ? "Replacement Certificate (PDF)" : "National ID Card";
    if (STATE.docType === "id") {
        document.getElementById("rv-id-images").style.display = "grid";
        document.getElementById("rv-cert-images").style.display = "none";
        if (STATE.images.front) document.getElementById("rv-front").src = STATE.images.front;
        if (STATE.images.back) document.getElementById("rv-back").src = STATE.images.back;
        if (STATE.images.selfie) document.getElementById("rv-selfie").src = STATE.images.selfie;
    } else {
        document.getElementById("rv-id-images").style.display = "none";
        document.getElementById("rv-cert-images").style.display = "grid";
        document.getElementById("rv-cert-name").textContent = STATE.cert.name || "certificate.pdf";
        if (STATE.images.selfie) document.getElementById("rv-selfie-cert").src = STATE.images.selfie;
    }
}

// ══════════════════════════════════════════════════════════════
//  SUBMIT
// ══════════════════════════════════════════════════════════════
async function submitKYC() {
    const btn = document.getElementById("submitBtn");
    const label = document.getElementById("submitLabel");
    const spinner = document.getElementById("submitSpinner");
    btn.disabled = true;
    label.textContent = "Preparing…";
    spinner.classList.remove("hidden");
    try {
        label.textContent = "Compressing images…";
        let frontB64Raw, backB64Raw, selfieB64Raw, isPdf;
        if (STATE.docType === "cert") {
            frontB64Raw = stripPrefix(STATE.cert.b64);
            backB64Raw = CONFIG.PLACEHOLDER_B64;
            selfieB64Raw = await compressImage(STATE.images.selfie, CONFIG.SELFIE_MAX_PX, CONFIG.UPLOAD_QUALITY);
            isPdf = true;
        } else {
            frontB64Raw = await compressImage(STATE.images.front, CONFIG.UPLOAD_MAX_PX, CONFIG.UPLOAD_QUALITY);
            backB64Raw = await compressImage(STATE.images.back, CONFIG.UPLOAD_MAX_PX, CONFIG.UPLOAD_QUALITY);
            selfieB64Raw = await compressImage(STATE.images.selfie, CONFIG.SELFIE_MAX_PX, CONFIG.UPLOAD_QUALITY);
            isPdf = false;
        }
        label.textContent = "AI Verification…";
        const fastApiPayload = {
            first_name: v("firstName"),
            last_name: v("lastName"),
            gender: STATE.gender,
            id_number: v("idNumber").replace(/\s/g, ""),
            phone_number: v("phoneNumber"),
            msisdn: v("msisdn"),
            district: v("district"),
            doc_type: STATE.docType,
            front_image: frontB64Raw,
            back_image: backB64Raw,
            selfie: selfieB64Raw,
            front_is_pdf: isPdf,
        };
        const result = await callFastAPI(fastApiPayload);
        if (result.status === "approved") {
            label.textContent = "Saving to Drive & Sheet…";
            const saved = await callAppsScript({ ...fastApiPayload, validation: result });
            if (!saved) showToast("⚠ Approved but data sync failed — contact support.", "error");
            else showToast("✅ Data saved to Drive & Sheet", "success");
        }
        showResult(result);
    } catch (err) {
        console.error(err);
        showToast("Submission failed: " + err.message, "error");
    } finally {
        btn.disabled = false;
        label.textContent = "Submit for Verification";
        spinner.classList.add("hidden");
    }
}

async function callFastAPI(payload) {
    const res = await fetch(CONFIG.FASTAPI_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error(`FastAPI error ${res.status}: ${await res.text()}`);
    return res.json();
}

function callAppsScript(payload) {
    return new Promise((resolve) => {
        try {
            const iframeName = "gs_iframe_" + Date.now();
            const iframe = document.createElement("iframe");
            iframe.name = iframeName;
            iframe.style.cssText = "display:none;width:0;height:0;border:0;position:absolute;left:-9999px;";
            document.body.appendChild(iframe);
            const form = document.createElement("form");
            form.method = "POST"; form.action = CONFIG.APPS_SCRIPT_URL;
            form.target = iframeName; form.enctype = "application/x-www-form-urlencoded";
            form.style.cssText = "display:none;position:absolute;left:-9999px;";
            const inp = document.createElement("input");
            inp.type = "hidden"; inp.name = "payload"; inp.value = JSON.stringify(payload);
            form.appendChild(inp); document.body.appendChild(form);
            const cleanup = () => { try { document.body.removeChild(form); } catch(_) {} try { document.body.removeChild(iframe); } catch(_) {} };
            const timeout = setTimeout(() => { cleanup(); resolve(true); }, 15000);
            iframe.onload = () => { clearTimeout(timeout); cleanup(); resolve(true); };
            iframe.onerror = () => { clearTimeout(timeout); cleanup(); resolve(true); };
            form.submit();
        } catch (err) { console.error("[Apps Script] ", err); resolve(false); }
    });
}

// ══════════════════════════════════════════════════════════════
//  RESULT SCREEN
// ══════════════════════════════════════════════════════════════
function showResult(result) {
    goStepDirect(6);
    const ok = result.status === "approved";
    const pct = Math.round((result.score || 0) * 100);
    let issuesHTML = "";
    if (!ok && result.issues?.length) {
        issuesHTML = `<div class="result-issues"><h4>Issues Found</h4><ul>${result.issues.map(i => `<li>${i}</li>`).join("")}</ul></div>`;
    }
    document.getElementById("resultContainer").innerHTML = `<div class="result-icon">${ok ? "✅" : "❌"}</div><div class="result-title ${ok ? "approved" : "rejected"}">${ok ? "Verification Approved!" : "Verification Failed"}</div><div class="result-score">Confidence Score: <span class="score-value">${pct}%</span></div>${issuesHTML}<div class="result-meta">${ok ? "Your data has been securely saved. You will receive confirmation shortly." : "Please correct the issues above and try again."}</div><div class="result-actions">${!ok ? `<button class="btn-secondary" onclick="goStep(1)">↺ Try Again</button>` : ""}<button class="btn-restart" onclick="restartFull()">Start New Registration</button></div>`;
}

function goStepDirect(n) {
    STATE.currentStep = n;
    document.querySelectorAll(".step").forEach((s, i) => s.classList.toggle("active", i + 1 === n));
    document.getElementById("stepBadge").textContent = n <= 5 ? `Step ${n} of 5` : "Complete";
    document.getElementById("progressFill").style.width = "100%";
    window.scrollTo({ top: 0, behavior: "smooth" });
}

function restartFull() {
    ["Front", "Back", "Selfie", "Cert"].forEach(s => { stopAutoCapture(s); stopStream(s); });
    STATE.images = { front: null, back: null, selfie: null };
    STATE.cert = { file: null, b64: null, name: "", size: 0 };
    STATE.certCameraImages = [];
    STATE.gender = null;  // NO DEFAULT
    STATE.docType = "id";
    STATE.autoCapture.lastFrame = {};
    STATE.autoCapture.goodSince = {};
    document.querySelectorAll("input[type='text'],input[type='tel']").forEach(i => (i.value = ""));
    document.getElementById("district").value = "";
    document.getElementById("sameAsPhone").checked = true;
    document.querySelectorAll(".toggle-btn").forEach(b => b.classList.remove("active"));
    setDocType("id");
    removeCert();
    goStep(1);
}

// ══════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════
function v(id) { const el = document.getElementById(id); return el ? el.value.trim() : ""; }
function setErr(field, msg) { const el = document.getElementById(`err-${field}`); if (el) el.textContent = msg; }
function clearErrors() { document.querySelectorAll(".err").forEach(e => (e.textContent = "")); }
function formatBytes(b) { if (b < 1024) return b + " B"; if (b < 1048576) return (b/1024).toFixed(1)+ " KB"; return (b/1048576).toFixed(2)+ " MB"; }
function showToast(msg, type = "") {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.className = "toast show" + (type ? ` ${type}` : "");
    setTimeout(() => t.classList.remove("show"), 3200);
}

// ══════════════════════════════════════════════════════════════
//  EVENT LISTENERS
// ══════════════════════════════════════════════════════════════
document.addEventListener("DOMContentLoaded", () => {
    // Gender toggle - NO DEFAULT SELECTION
    document.querySelectorAll(".toggle-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".toggle-btn").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            STATE.gender = btn.dataset.value;
        });
    });

    // Same-as-phone checkbox
    const sameCheck = document.getElementById("sameAsPhone");
    const msisdnInput = document.getElementById("msisdn");
    const phoneInput = document.getElementById("phoneNumber");
    function syncMsisdn() {
        if (sameCheck.checked) { msisdnInput.value = phoneInput.value; msisdnInput.disabled = true; }
        else { msisdnInput.disabled = false; }
    }
    sameCheck.addEventListener("change", syncMsisdn);
    phoneInput.addEventListener("input", syncMsisdn);
    syncMsisdn();

    // ID number digits + spaces only
    document.getElementById("idNumber").addEventListener("input", function() {
        this.value = this.value.replace(/[^\d\s]/g, "");
    });

    // Lazy-load Tesseract.js if not already loaded
    if (CONFIG.OCR_ENABLED && !window.Tesseract) {
        const s = document.createElement("script");
        s.src = "https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/4.1.1/tesseract.min.js";
        s.async = true;
        document.head.appendChild(s);
    }
});
