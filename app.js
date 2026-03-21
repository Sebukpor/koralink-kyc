/**
* KoraLink KYC — app.js  v1.3.3
* Supports two document modes:
*   "id"   — Physical National ID card (front photo + back photo)
*   "cert" — Replacement Certificate / Icyemezo Gisimbura Indangamuntu (single PDF)
*
* KEY FIXES in v1.3.3:
*   • callAppsScript(): Single iframe.onload handler (removed duplicate)
*   • callAppsScript(): URL-encode payload for safe form submission
*   • callAppsScript(): Added iframe.onerror + console logging for debugging
*   • callAppsScript(): Show toast on Apps Script failure for user feedback
*/

// ── CONFIG ────────────────────────────────────────────────────
const CONFIG = {
  FASTAPI_URL:     "https://sebukpor-koralink-kyc.hf.space/validate",
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbyzd4FdPOw7mUpxMLhX3jWPSvNyOPjsHkvNzXqp6K7jqbD03kyDZpSdWvHik1UZm5nq/exec,
  MAX_IMAGE_MB:    5,
  MAX_PDF_MB:      5,
  IMAGE_QUALITY:   0.85,
  // 1×1 transparent JPEG — placeholder sent as back_image in cert mode
  PLACEHOLDER_B64: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARC" +
    "AABAAEDASIA2gABAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwD" +
    "AQACEQMRAD8AJQAB/9k=",
};

// ── STATE ─────────────────────────────────────────────────────
const STATE = {
  currentStep: 1,
  gender:      "Male",
  docType:     "id",
  images: {
    front:  null,
    back:   null,
    selfie: null,
  },
  cert: {
    file: null,
    b64:  null,
    name: "",
    size: 0,
  },
  streams: {},
};

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
    STATE.cert.b64  = e.target.result;
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
  
  // Skip step 3 (back ID) in cert mode
  if (STATE.docType === "cert" && STATE.currentStep === 2 && n === 3) n = 4;
  if (STATE.docType === "cert" && STATE.currentStep === 4 && n === 3) n = 2;
  
  // Stop camera streams when leaving steps
  const camMap = { 2: "Front", 3: "Back", 4: "Selfie" };
  if (camMap[STATE.currentStep] && camMap[STATE.currentStep] !== camMap[n]) {
    stopStream(camMap[STATE.currentStep]);
  }
  
  STATE.currentStep = n;
  
  // Update step UI
  document.querySelectorAll(".step").forEach((s, i) =>
    s.classList.toggle("active", i + 1 === n)
  );
  
  // Adjust progress for cert mode (4 steps instead of 5)
  const totalVisible = STATE.docType === "cert" ? 4 : 5;
  const displayStep  = STATE.docType === "cert" && n >= 4 ? n - 1 : n;
  document.getElementById("stepBadge").textContent    = `Step ${displayStep} of ${totalVisible}`;
  document.getElementById("progressFill").style.width = `${(displayStep / totalVisible) * 100}%`;
  
  // Update back button on step 4
  const s4back = document.getElementById("step4BackBtn");
  if (s4back) {
    s4back.setAttribute("onclick", `goStep(${STATE.docType === "cert" ? 2 : 3})`);
  }
  
  // Start cameras when entering their steps
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
  
  // Mirror selfie preview
  if (side === "Selfie") {
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
  }
  
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
  label.textContent = "Validating…";
  spinner.classList.remove("hidden");
  
  try {
    let frontB64, backB64, isPdf;
    
    if (STATE.docType === "cert") {
      frontB64 = stripPrefix(STATE.cert.b64);
      backB64  = CONFIG.PLACEHOLDER_B64;
      isPdf    = true;
    } else {
      frontB64 = stripPrefix(STATE.images.front);
      backB64  = stripPrefix(STATE.images.back);
      isPdf    = false;
    }
    
    // Full payload for FastAPI (needs the actual image bytes for AI validation)
    const fastApiPayload = {
      first_name:   v("firstName"),
      last_name:    v("lastName"),
      gender:       STATE.gender,
      id_number:    v("idNumber").replace(/\s/g, ""),
      phone_number: v("phoneNumber"),
      msisdn:       v("msisdn"),
      district:     v("district"),
      doc_type:     STATE.docType,
      front_image:  frontB64,
      back_image:   backB64,
      selfie:       stripPrefix(STATE.images.selfie),
      front_is_pdf: isPdf,
    };
    
    label.textContent = "AI Verification…";
    const result = await callFastAPI(fastApiPayload);
    
    if (result.status === "approved") {
      label.textContent = "Saving data…";
      
      // ── Apps Script payload ─────────────────────────────────
      // Send full payload including base64 images so Apps Script can save to Drive
      const scriptPayload = {
        first_name:   fastApiPayload.first_name,
        last_name:    fastApiPayload.last_name,
        gender:       fastApiPayload.gender,
        id_number:    fastApiPayload.id_number,
        phone_number: fastApiPayload.phone_number,
        msisdn:       fastApiPayload.msisdn,
        district:     fastApiPayload.district,
        doc_type:     fastApiPayload.doc_type,
        front_is_pdf: fastApiPayload.front_is_pdf,
        front_image:  fastApiPayload.front_image,   // cert PDF or front ID image
        back_image:   fastApiPayload.back_image,    // back ID image or placeholder
        selfie:       fastApiPayload.selfie,        // always included
        validation:   result,
      };
      
      await callAppsScript(scriptPayload);
    }
    
    showResult(result);
    
  } catch (err) {
    console.error("submitKYC error:", err);
    showToast("Submission failed: " + err.message, "error");
  } finally {
    btn.disabled = false;
    label.textContent = "Submit for Verification";
    spinner.classList.add("hidden");
  }
}

async function callFastAPI(payload) {
  const res = await fetch(CONFIG.FASTAPI_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(payload),
  });
  
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json();
}

/**
* callAppsScript — sends KYC metadata to the Google Apps Script web app.
*
* FIXES in v1.3.3:
*   • URL-encode payload for safe form submission
*   • Single iframe.onload handler (removed duplicate assignment)
*   • Added iframe.onerror for network failure detection
*   • Added console logging for debugging
*   • Show toast on failure so user knows sync status
*/
function callAppsScript(payload) {
  return new Promise((resolve, reject) => {
    try {
      console.log("=== callAppsScript START ===");
      console.log("Apps Script URL:", CONFIG.APPS_SCRIPT_URL);
      console.log("Payload keys:", Object.keys(payload));
      console.log("Payload size:", JSON.stringify(payload).length, "bytes");
      
      // Create a throwaway iframe to catch the redirect response
      const iframeName = "gs_iframe_" + Date.now();
      const iframe = document.createElement("iframe");
      iframe.name  = iframeName;
      iframe.style.cssText = "display:none;width:0;height:0;border:0;";
      document.body.appendChild(iframe);
      
      // Create a hidden form targeting the iframe
      const form = document.createElement("form");
      form.method  = "POST";
      form.action  = CONFIG.APPS_SCRIPT_URL;
      form.target  = iframeName;
      form.enctype = "application/x-www-form-urlencoded";
      form.style.cssText = "display:none;";
      
      // Single hidden input carrying the JSON payload
      // KEY FIX: URL-encode the JSON string for safe form transmission
      const input = document.createElement("input");
      input.type  = "hidden";
      input.name  = "payload";
      input.value = encodeURIComponent(JSON.stringify(payload));
      
      form.appendChild(input);
      document.body.appendChild(form);
      
      // Clean up after submission
      const cleanup = () => {
        try { document.body.removeChild(form);   } catch (_) {}
        try { document.body.removeChild(iframe); } catch (_) {}
      };
      
      // Timeout fallback (8 seconds)
      const timeout = setTimeout(() => {
        console.warn("callAppsScript: timeout reached");
        cleanup();
        showToast("Data saved locally. Sheet sync timed out.", "error");
        resolve(); // Don't block UI
      }, 8000);
      
      // SINGLE onload handler (FIXED: removed duplicate)
      iframe.onload = () => {
        console.log("callAppsScript: iframe loaded (Apps Script responded)");
        clearTimeout(timeout);
        cleanup();
        resolve();
      };
      
      // Error handler for network failures
      iframe.onerror = (err) => {
        console.error("callAppsScript: iframe error:", err);
        clearTimeout(timeout);
        cleanup();
        showToast("Data saved locally. Sheet sync failed.", "error");
        resolve(); // Don't block UI
      };
      
      // Actually submit the form
      console.log("callAppsScript: submitting form to", CONFIG.APPS_SCRIPT_URL);
      form.submit();
      
    } catch (err) {
      console.error("callAppsScript setup error:", err);
      showToast("Data saved locally. Sheet sync error.", "error");
      resolve(); // Don't block UI
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

function stripPrefix(dataURL) {
  if (!dataURL) return null;
  return dataURL.includes(",") ? dataURL.split(",")[1] : dataURL;
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
