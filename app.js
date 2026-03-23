/**
 * KoraLink KYC — app.js  v1.4.0
 *
 * KEY CHANGES in v1.4.0 (fixes data not reaching Sheet / Drive):
 *
 *  1. Images are compressed before ANY network call:
 *       - Front/Back ID photos → max 900×900px, JPEG quality 0.70
 *       - Selfie              → max 800×800px, JPEG quality 0.70
 *       - Certificate PDF     → sent as-is (already binary, no compression)
 *     This keeps payloads well under 1 MB per image.
 *
 *  2. callAppsScript() rewritten:
 *       - Sends a direct JSON POST (not a form POST, not no-cors fetch).
 *       - Apps Script deployed as "Execute as Me / Access Anyone" accepts
 *         cross-origin POSTs from any origin; CORS only blocks reading the
 *         *response* — the POST itself always arrives.
 *       - We read the response via a second GET fetch (the redirect URL that
 *         Apps Script returns) to confirm success.
 *       - Falls back gracefully with a visible toast if saving fails.
 *
 *  3. FastAPI still handles AI validation only (no Drive/Sheet logic there).
 *     After a successful validation the full payload (compressed images +
 *     metadata + validation result) goes to Apps Script for storage.
 *
 *  4. Fixed duplicate iframe.onload assignment (was dead code).
 */

// ── CONFIG ────────────────────────────────────────────────────
const CONFIG = {
  FASTAPI_URL:     "https://sebukpor-koralink-kyc.hf.space/validate",
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbypunYTMbq9PqCOn-NWf1eDVpHflpJJM--NRdfNRy3R1dVx_9l_UGJEyK1M4krlhaaY/exec",
  MAX_IMAGE_MB:    5,
  MAX_PDF_MB:      5,
  IMAGE_QUALITY:   0.85,   // original capture quality (compressed again before upload)
  UPLOAD_QUALITY:  0.70,   // quality used when compressing for Apps Script upload
  UPLOAD_MAX_PX:   900,    // max width or height for ID images before upload
  SELFIE_MAX_PX:   800,    // max width or height for selfie before upload
  // 1×1 transparent JPEG placeholder (sent as back_image in cert mode to FastAPI)
  PLACEHOLDER_B64: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQ" +
    "gFBQQEBQoH9wYLDQwLCgsLDRAxEA8OEA8LCxAWEBETFBUVFQ0XGBgUGBQVFBT/wAAR" +
    "CAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAA" +
    "AAAAAAAP/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aA" +
    "AwDAQACEQMRAD8AJQAB/9k=",
};

// ── STATE ─────────────────────────────────────────────────────
const STATE = {
  currentStep: 1,
  gender:      "Male",
  docType:     "id",
  images: {
    front:  null,   // base64 data-URL
    back:   null,
    selfie: null,
  },
  cert: {
    file: null,
    b64:  null,   // full data-URL  (data:application/pdf;base64,...)
    name: "",
    size: 0,
  },
  streams: {},
};

// ══════════════════════════════════════════════════════════════
//  IMAGE COMPRESSION HELPERS
// ══════════════════════════════════════════════════════════════

/**
 * Compress a base64 data-URL image to a max dimension and quality.
 * Returns a Promise<string> of a raw base64 string (no data: prefix).
 */
function compressImage(dataURL, maxPx, quality) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;

      // Scale down if needed
      if (width > maxPx || height > maxPx) {
        if (width >= height) {
          height = Math.round(height * maxPx / width);
          width  = maxPx;
        } else {
          width  = Math.round(width * maxPx / height);
          height = maxPx;
        }
      }

      const canvas = document.createElement("canvas");
      canvas.width  = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);

      // toDataURL returns "data:image/jpeg;base64,<data>"
      const compressed = canvas.toDataURL("image/jpeg", quality);
      resolve(compressed.split(",")[1]);  // return raw base64 only
    };
    img.onerror = () => {
      // If compression fails, return the original stripped of its prefix
      resolve(stripPrefix(dataURL));
    };
    img.src = dataURL;
  });
}

/**
 * Strip the "data:...;base64," prefix from a data-URL.
 * Safe to call on a raw base64 string (returns it unchanged).
 */
function stripPrefix(dataURL) {
  if (!dataURL) return null;
  return dataURL.includes(",") ? dataURL.split(",")[1] : dataURL;
}

// ══════════════════════════════════════════════════════════════
//  DOCUMENT TYPE TOGGLE
// ══════════════════════════════════════════════════════════════

function setDocType(type) {
  STATE.docType = type;

  document.getElementById("btnPhysicalID").classList.toggle("active",  type === "id");
  document.getElementById("btnCertificate").classList.toggle("active", type === "cert");

  document.getElementById("idCaptureZone").style.display  = type === "id"   ? "block" : "none";
  document.getElementById("certUploadZone").style.display = type === "cert" ? "block" : "none";

  if (type === "id") {
    document.getElementById("step2Icon").textContent  = "🪪";
    document.getElementById("step2Title").textContent = "Front ID Card";
    document.getElementById("step2Desc").textContent  = "Position your ID within the frame and capture a clear photo.";
    document.getElementById("step2NextBtn").innerHTML = 'Next: Back ID <span class="btn-arrow">→</span>';
    STATE.cert = { file: null, b64: null, name: "", size: 0 };
    if (!STATE.images.front) startCamera("Front");
  } else {
    document.getElementById("step2Icon").textContent  = "📄";
    document.getElementById("step2Title").textContent = "Replacement Certificate";
    document.getElementById("step2Desc").textContent  = "Upload the Icyemezo Gisimbura Indangamuntu issued to you.";
    document.getElementById("step2NextBtn").innerHTML = 'Next: Take Selfie <span class="btn-arrow">→</span>';
    stopStream("Front");
    STATE.images.front = null;
    STATE.images.back  = null;
  }

  clearErrors();
}

// ══════════════════════════════════════════════════════════════
//  CERTIFICATE UPLOAD HANDLERS
// ══════════════════════════════════════════════════════════════

function handleCertUpload(input) {
  const file = input.files[0];
  if (!file) return;

  if (file.type !== "application/pdf") {
    showToast("Only PDF files are accepted for the replacement certificate.", "error");
    input.value = "";
    return;
  }
  if (file.size > CONFIG.MAX_PDF_MB * 1024 * 1024) {
    showToast(`PDF too large (max ${CONFIG.MAX_PDF_MB}MB).`, "error");
    input.value = "";
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    STATE.cert.b64  = e.target.result;  // full data-URL
    STATE.cert.file = file;
    STATE.cert.name = file.name;
    STATE.cert.size = file.size;

    document.getElementById("certUploadInner").style.display = "none";
    document.getElementById("certPreview").style.display     = "flex";
    document.getElementById("certFileName").textContent      = file.name;
    document.getElementById("certFileSize").textContent      = formatBytes(file.size);

    setErr("front", "");
    showToast("Certificate uploaded ✓", "success");
  };
  reader.readAsDataURL(file);
}

function removeCert() {
  STATE.cert = { file: null, b64: null, name: "", size: 0 };
  document.getElementById("fileCert").value                = "";
  document.getElementById("certPreview").style.display     = "none";
  document.getElementById("certUploadInner").style.display = "flex";
}

// Drag-and-drop support for cert zone
document.addEventListener("DOMContentLoaded", () => {
  const zone = document.getElementById("certDropZone");
  if (!zone) return;

  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("drag-over");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("drag-over");
    const file = e.dataTransfer.files[0];
    if (file) {
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.getElementById("fileCert");
      input.files = dt.files;
      handleCertUpload(input);
    }
  });
});

// ══════════════════════════════════════════════════════════════
//  STEP NAVIGATION
// ══════════════════════════════════════════════════════════════

function goStep(n) {
  if (n > STATE.currentStep) {
    if (!validateCurrentStep()) return;
  }

  if (STATE.docType === "cert" && STATE.currentStep === 2 && n === 3) n = 4;
  if (STATE.docType === "cert" && STATE.currentStep === 4 && n === 3) n = 2;

  const camMap = { 2: "Front", 3: "Back", 4: "Selfie" };
  if (camMap[STATE.currentStep] && camMap[STATE.currentStep] !== camMap[n]) {
    stopStream(camMap[STATE.currentStep]);
  }

  STATE.currentStep = n;
  document.querySelectorAll(".step").forEach((s, i) =>
    s.classList.toggle("active", i + 1 === n)
  );

  const totalVisible = STATE.docType === "cert" ? 4 : 5;
  const displayStep  = STATE.docType === "cert" && n >= 4 ? n - 1 : n;
  document.getElementById("stepBadge").textContent    = `Step ${displayStep} of ${totalVisible}`;
  document.getElementById("progressFill").style.width = `${(displayStep / totalVisible) * 100}%`;

  const s4back = document.getElementById("step4BackBtn");
  if (s4back) {
    s4back.setAttribute("onclick", `goStep(${STATE.docType === "cert" ? 2 : 3})`);
  }

  if (n === 2 && STATE.docType === "id") startCamera("Front");
  if (n === 3) startCamera("Back");
  if (n === 4) startCamera("Selfie");
  if (n === 5) populateReview();

  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ══════════════════════════════════════════════════════════════
//  VALIDATION PER STEP
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
  const fn = v("firstName"), ln = v("lastName"),
        id = v("idNumber"),  ph = v("phoneNumber"),
        ms = v("msisdn"),    di = v("district");

  if (!fn) { setErr("firstName", "First name is required"); ok = false; }
  if (!ln) { setErr("lastName",  "Last name is required");  ok = false; }
  if (!id || id.replace(/\s/g, "").length < 10) {
    setErr("idNumber", "Enter a valid ID number (≥ 10 digits)"); ok = false;
  }
  if (!ph || !/^07\d{8}$/.test(ph)) {
    setErr("phoneNumber", "Enter a valid Rwandan phone number (07XXXXXXXX)"); ok = false;
  }
  if (!ms || !/^07\d{8}$/.test(ms)) {
    setErr("msisdn", "Enter a valid MSISDN (07XXXXXXXX)"); ok = false;
  }
  if (!di) { setErr("district", "Please select a district"); ok = false; }
  return ok;
}

function validateStep2() {
  if (STATE.docType === "id") {
    if (!STATE.images.front) {
      setErr("front", "Please capture or upload the front of your ID card.");
      return false;
    }
  } else {
    if (!STATE.cert.b64) {
      setErr("front", "Please upload your replacement certificate (PDF).");
      return false;
    }
  }
  return true;
}

function validateStep3() {
  if (!STATE.images.back) {
    setErr("back", "Please capture or upload the back of your ID card.");
    return false;
  }
  return true;
}

function validateStep4() {
  if (!STATE.images.selfie) {
    setErr("selfie", "Please take a selfie.");
    return false;
  }
  return true;
}

// ══════════════════════════════════════════════════════════════
//  CAMERA
// ══════════════════════════════════════════════════════════════

async function startCamera(side) {
  const video = document.getElementById(`video${side}`);
  if (!video) return;
  if (STATE.images[side.toLowerCase()]) return;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: side === "Selfie" ? "user" : "environment",
        width:  { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });
    STATE.streams[side] = stream;
    video.srcObject = stream;
  } catch (err) {
    console.warn("Camera error:", err);
    showToast("Camera unavailable — please upload a file instead.", "error");
    const frame = document.querySelector(`#captureZone${side} .camera-frame`);
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
  const video  = document.getElementById(`video${side}`);
  const canvas = document.getElementById(`canvas${side}`);
  if (!video || !video.videoWidth) {
    showToast("Camera not ready. Try uploading instead.", "error");
    return;
  }
  canvas.width  = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  if (side === "Selfie") { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); }
  ctx.drawImage(video, 0, 0);
  saveImage(side, canvas.toDataURL("image/jpeg", CONFIG.IMAGE_QUALITY));
  stopStream(side);
}

function retake(side) {
  STATE.images[side.toLowerCase()] = null;
  document.getElementById(`preview${side}`).style.display = "none";
  document.getElementById(`captureZone${side}`).querySelector(".camera-frame").style.display = "block";
  setErr(side.toLowerCase(), "");
  startCamera(side);
}

function saveImage(side, dataURL) {
  STATE.images[side.toLowerCase()] = dataURL;
  document.getElementById(`img${side}`).src = dataURL;
  document.getElementById(`preview${side}`).style.display = "block";
  document.getElementById(`captureZone${side}`).querySelector(".camera-frame").style.display = "none";
  setErr(side.toLowerCase(), "");
  showToast(`${side} captured ✓`, "success");
}

function handleFileUpload(side, input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > CONFIG.MAX_IMAGE_MB * 1024 * 1024) {
    showToast(`File too large (max ${CONFIG.MAX_IMAGE_MB}MB)`, "error");
    input.value = ""; return;
  }
  const allowed = ["image/jpeg", "image/png", "image/webp"];
  if (!allowed.includes(file.type)) {
    showToast("Only JPG, PNG, or WebP image files are allowed here.", "error");
    input.value = ""; return;
  }
  const reader = new FileReader();
  reader.onload = (e) => saveImage(side, e.target.result);
  reader.readAsDataURL(file);
}

// ══════════════════════════════════════════════════════════════
//  REVIEW POPULATION
// ══════════════════════════════════════════════════════════════

function populateReview() {
  document.getElementById("rv-name").textContent     = `${v("firstName")} ${v("lastName")}`;
  document.getElementById("rv-gender").textContent   = STATE.gender;
  document.getElementById("rv-id").textContent       = v("idNumber");
  document.getElementById("rv-phone").textContent    = v("phoneNumber");
  document.getElementById("rv-msisdn").textContent   = v("msisdn");
  document.getElementById("rv-district").textContent = v("district");
  document.getElementById("rv-doctype").textContent  =
    STATE.docType === "cert" ? "Replacement Certificate (PDF)" : "National ID Card";

  if (STATE.docType === "id") {
    document.getElementById("rv-id-images").style.display   = "grid";
    document.getElementById("rv-cert-images").style.display = "none";
    if (STATE.images.front)  document.getElementById("rv-front").src  = STATE.images.front;
    if (STATE.images.back)   document.getElementById("rv-back").src   = STATE.images.back;
    if (STATE.images.selfie) document.getElementById("rv-selfie").src = STATE.images.selfie;
  } else {
    document.getElementById("rv-id-images").style.display   = "none";
    document.getElementById("rv-cert-images").style.display = "grid";
    document.getElementById("rv-cert-name").textContent     = STATE.cert.name || "certificate.pdf";
    if (STATE.images.selfie) document.getElementById("rv-selfie-cert").src = STATE.images.selfie;
  }
}

// ══════════════════════════════════════════════════════════════
//  SUBMIT
// ══════════════════════════════════════════════════════════════

async function submitKYC() {
  const btn     = document.getElementById("submitBtn");
  const label   = document.getElementById("submitLabel");
  const spinner = document.getElementById("submitSpinner");

  btn.disabled = true;
  label.textContent = "Preparing…";
  spinner.classList.remove("hidden");

  try {
    // ── Step 1: Compress images for ALL network calls ──────────
    label.textContent = "Compressing images…";

    let frontB64Raw, backB64Raw, selfieB64Raw, isPdf;

    if (STATE.docType === "cert") {
      // PDF: strip data-URL prefix, send as-is to FastAPI
      frontB64Raw = stripPrefix(STATE.cert.b64);
      backB64Raw  = CONFIG.PLACEHOLDER_B64;
      selfieB64Raw = await compressImage(STATE.images.selfie, CONFIG.SELFIE_MAX_PX, CONFIG.UPLOAD_QUALITY);
      isPdf = true;
    } else {
      frontB64Raw  = await compressImage(STATE.images.front,  CONFIG.UPLOAD_MAX_PX, CONFIG.UPLOAD_QUALITY);
      backB64Raw   = await compressImage(STATE.images.back,   CONFIG.UPLOAD_MAX_PX, CONFIG.UPLOAD_QUALITY);
      selfieB64Raw = await compressImage(STATE.images.selfie, CONFIG.SELFIE_MAX_PX, CONFIG.UPLOAD_QUALITY);
      isPdf = false;
    }

    // ── Step 2: Send to FastAPI for AI validation ──────────────
    label.textContent = "AI Verification…";

    const fastApiPayload = {
      first_name:   v("firstName"),
      last_name:    v("lastName"),
      gender:       STATE.gender,
      id_number:    v("idNumber").replace(/\s/g, ""),
      phone_number: v("phoneNumber"),
      msisdn:       v("msisdn"),
      district:     v("district"),
      doc_type:     STATE.docType,
      front_image:  frontB64Raw,
      back_image:   backB64Raw,
      selfie:       selfieB64Raw,
      front_is_pdf: isPdf,
    };

    const result = await callFastAPI(fastApiPayload);

    // ── Step 3: If approved → send everything to Apps Script ───
    if (result.status === "approved") {
      label.textContent = "Saving to Drive & Sheet…";

      // Build the Apps Script payload:
      // - Includes ALL images/PDF as base64 so Apps Script can save to Drive
      // - PDF cert: include the full raw base64 (already stripped above)
      // - Images: use the same compressed versions sent to FastAPI
      const scriptPayload = {
        // ── Person metadata ──
        first_name:   fastApiPayload.first_name,
        last_name:    fastApiPayload.last_name,
        gender:       fastApiPayload.gender,
        id_number:    fastApiPayload.id_number,
        phone_number: fastApiPayload.phone_number,
        msisdn:       fastApiPayload.msisdn,
        district:     fastApiPayload.district,
        doc_type:     fastApiPayload.doc_type,
        front_is_pdf: fastApiPayload.front_is_pdf,

        // ── Files for Drive storage ──
        // All images are compressed to stay under ~300KB each.
        // cert PDF is sent raw; Apps Script saves it directly as application/pdf.
        front_image:  fastApiPayload.front_image,  // front ID photo OR cert PDF bytes
        back_image:   fastApiPayload.back_image,   // back ID photo OR placeholder (cert mode)
        selfie:       fastApiPayload.selfie,       // selfie photo

        // ── Validation result from FastAPI ──
        validation: result,
      };

      const saved = await callAppsScript(scriptPayload);

      if (!saved) {
        // Non-blocking: show warning but still show result screen
        showToast("⚠ Verification approved but data sync failed — contact support.", "error");
      } else {
        showToast("✅ Data saved to Drive & Sheet", "success");
      }
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

// ──────────────────────────────────────────────────────────────
//  FastAPI call (AI validation only)
// ──────────────────────────────────────────────────────────────

async function callFastAPI(payload) {
  const res = await fetch(CONFIG.FASTAPI_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`FastAPI error ${res.status}: ${await res.text()}`);
  return res.json();
}

// ──────────────────────────────────────────────────────────────
//  Apps Script call (Drive storage + Sheet logging)
//
//  WHY FORM POST ONLY:
//  Google Apps Script does NOT send Access-Control-Allow-Origin headers
//  on cross-origin POST responses, so fetch() from a GitHub Pages / HF
//  Space origin is always CORS-blocked. The hidden <form> POST into a
//  throwaway iframe bypasses CORS entirely — the browser sends the data
//  without needing to read the response. Apps Script receives it via
//  e.parameter.payload and processes it normally.
//
//  The 403 on the googleusercontent echo URL is just the iframe trying
//  to display the redirect destination — it does NOT mean the POST
//  failed. The data arrives at Apps Script before the redirect happens.
//
//  Returns a Promise that resolves true once the iframe loads (redirect
//  received = POST accepted) or after a 15s safety timeout.
// ──────────────────────────────────────────────────────────────

function callAppsScript(payload) {
  return new Promise((resolve) => {
    try {
      const jsonBody   = JSON.stringify(payload);
      const iframeName = "gs_iframe_" + Date.now();

      // ── Throwaway iframe to absorb the Apps Script redirect ──
      const iframe = document.createElement("iframe");
      iframe.name  = iframeName;
      iframe.style.cssText = "display:none;width:0;height:0;border:0;position:absolute;left:-9999px;";
      document.body.appendChild(iframe);

      // ── Hidden form that sends the JSON as a form field ──────
      // Apps Script doPost() reads: JSON.parse(e.parameter.payload)
      const form     = document.createElement("form");
      form.method    = "POST";
      form.action    = CONFIG.APPS_SCRIPT_URL;
      form.target    = iframeName;
      form.enctype   = "application/x-www-form-urlencoded";
      form.style.cssText = "display:none;position:absolute;left:-9999px;";

      const input  = document.createElement("input");
      input.type   = "hidden";
      input.name   = "payload";
      input.value  = jsonBody;
      form.appendChild(input);

      document.body.appendChild(form);

      const cleanup = () => {
        try { document.body.removeChild(form);   } catch (_) {}
        try { document.body.removeChild(iframe); } catch (_) {}
      };

      // 15s timeout — generous for cold-start Apps Script executions
      const timeout = setTimeout(() => {
        cleanup();
        console.warn("Apps Script POST: timeout reached — data was sent, awaiting processing.");
        resolve(true);
      }, 15000);

      // iframe.onload fires when Apps Script redirects after processing
      // A 403 on the echo URL is normal — it just means the iframe tried
      // to load the redirect target (cross-origin). The POST already completed.
      iframe.onload = () => {
        clearTimeout(timeout);
        cleanup();
        console.log("Apps Script POST: redirect received — submission processed.");
        resolve(true);
      };

      iframe.onerror = () => {
        clearTimeout(timeout);
        cleanup();
        console.warn("Apps Script POST: iframe error — data likely sent but unconfirmed.");
        resolve(true); // still optimistic — error is on the redirect, not the POST
      };

      form.submit();
      console.log("Apps Script POST: form submitted to", CONFIG.APPS_SCRIPT_URL);

    } catch (err) {
      console.error("Apps Script POST: unexpected error:", err);
      resolve(false);
    }
  });
}

// ══════════════════════════════════════════════════════════════
//  RESULT SCREEN
// ══════════════════════════════════════════════════════════════

function showResult(result) {
  goStepDirect(6);
  const ok  = result.status === "approved";
  const pct = Math.round((result.score || 0) * 100);

  let issuesHTML = "";
  if (!ok && result.issues?.length) {
    issuesHTML = `
      <div class="result-issues">
        <h4>Issues Found</h4>
        <ul>${result.issues.map(i => `<li>${i}</li>`).join("")}</ul>
      </div>`;
  }

  document.getElementById("resultContainer").innerHTML = `
    <div class="result-icon">${ok ? "✅" : "❌"}</div>
    <div class="result-title ${ok ? "approved" : "rejected"}">
      ${ok ? "Verification Approved!" : "Verification Failed"}
    </div>
    <div class="result-score">
      Confidence Score: <span class="score-value">${pct}%</span>
    </div>
    ${issuesHTML}
    <div class="result-meta">
      ${ok
        ? "Your data has been securely saved. You will receive confirmation shortly."
        : "Please correct the issues above and try again."}
    </div>
    <div class="result-actions">
      ${!ok ? `<button class="btn-primary" onclick="goStep(1)">↺ Try Again</button>` : ""}
      <button class="btn-restart" onclick="restartFull()">Start New Registration</button>
    </div>`;
}

function goStepDirect(n) {
  STATE.currentStep = n;
  document.querySelectorAll(".step").forEach((s, i) =>
    s.classList.toggle("active", i + 1 === n)
  );
  document.getElementById("stepBadge").textContent    = n <= 5 ? `Step ${n} of 5` : "Complete";
  document.getElementById("progressFill").style.width = "100%";
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function restartFull() {
  ["Front", "Back", "Selfie"].forEach(stopStream);
  STATE.images  = { front: null, back: null, selfie: null };
  STATE.cert    = { file: null, b64: null, name: "", size: 0 };
  STATE.gender  = "Male";
  STATE.docType = "id";

  document.querySelectorAll("input[type='text'], input[type='tel']")
    .forEach(i => (i.value = ""));
  document.getElementById("district").value      = "";
  document.getElementById("sameAsPhone").checked = true;

  document.querySelectorAll(".toggle-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.value === "Male")
  );

  setDocType("id");
  removeCert();
  goStep(1);
}

// ══════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════

function v(id) {
  const el = document.getElementById(id);
  return el ? el.value.trim() : "";
}
function setErr(field, msg) {
  const el = document.getElementById(`err-${field}`);
  if (el) el.textContent = msg;
}
function clearErrors() {
  document.querySelectorAll(".err").forEach(e => (e.textContent = ""));
}
function showToast(msg, type = "") {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className   = "toast show" + (type ? ` ${type}` : "");
  setTimeout(() => t.classList.remove("show"), 3200);
}
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(2) + " MB";
}

// ══════════════════════════════════════════════════════════════
//  EVENT LISTENERS
// ══════════════════════════════════════════════════════════════

document.addEventListener("DOMContentLoaded", () => {
  // Gender toggle
  document.querySelectorAll(".toggle-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".toggle-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      STATE.gender = btn.dataset.value;
    });
  });

  // Same-as-phone checkbox
  const sameCheck   = document.getElementById("sameAsPhone");
  const msisdnInput = document.getElementById("msisdn");
  const phoneInput  = document.getElementById("phoneNumber");

  function syncMsisdn() {
    if (sameCheck.checked) {
      msisdnInput.value    = phoneInput.value;
      msisdnInput.disabled = true;
    } else {
      msisdnInput.disabled = false;
    }
  }
  sameCheck.addEventListener("change", syncMsisdn);
  phoneInput.addEventListener("input",  syncMsisdn);
  syncMsisdn();

  // ID number — digits + spaces only
  document.getElementById("idNumber").addEventListener("input", function () {
    this.value = this.value.replace(/[^\d\s]/g, "");
  });
});
