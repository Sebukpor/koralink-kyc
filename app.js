/**
 * KoraLink KYC — app.js
 * Handles: multi-step navigation, camera, capture, validation,
 *          API calls to FastAPI backend + Apps Script.
 */

// ── CONFIG ─────────────────────────────────────────────────
const CONFIG = {
  // Replace with your deployed Hugging Face Spaces URL
  FASTAPI_URL: "https://sebukpor-koralink-kyc.hf.space/validate",
  // Replace with your deployed Apps Script Web App URL
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycby1mcFFZabsURlgnO7KMNqJluSfriT-4xjqM95FqCjfyoXtrYYa9ynqmZFsKY9X2Edx/exec",
  MAX_IMAGE_SIZE_MB: 5,
  IMAGE_QUALITY: 0.85,
};

// ── STATE ───────────────────────────────────────────────────
const STATE = {
  currentStep: 1,
  gender: "Male",
  images: {
    front: null,    // base64 string (data URL)
    back: null,
    selfie: null,
  },
  streams: {},      // active MediaStream objects keyed by 'Front'|'Back'|'Selfie'
};

// ══════════════════════════════════════════════════════════════
//  STEP NAVIGATION
// ══════════════════════════════════════════════════════════════

function goStep(n) {
  if (n > STATE.currentStep) {
    if (!validateCurrentStep()) return;
  }

  // Stop camera streams not needed in next step
  const camSteps = { 2: "Front", 3: "Back", 4: "Selfie" };
  if (camSteps[STATE.currentStep] && camSteps[STATE.currentStep] !== camSteps[n]) {
    stopStream(camSteps[STATE.currentStep]);
  }

  STATE.currentStep = n;
  document.querySelectorAll(".step").forEach((s, i) => {
    s.classList.toggle("active", i + 1 === n);
  });

  document.getElementById("stepBadge").textContent = `Step ${n} of 5`;
  document.getElementById("progressFill").style.width = `${(n / 5) * 100}%`;

  // Auto-start camera for capture steps
  if (n === 2) startCamera("Front");
  if (n === 3) startCamera("Back");
  if (n === 4) startCamera("Selfie");
  if (n === 5) populateReview();

  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ══════════════════════════════════════════════════════════════
//  VALIDATION (per step)
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
  const fn = v("firstName"), ln = v("lastName"), id = v("idNumber"),
        ph = v("phoneNumber"), ms = v("msisdn"), di = v("district");

  if (!fn) { setErr("firstName", "First name is required"); ok = false; }
  if (!ln) { setErr("lastName", "Last name is required"); ok = false; }
  if (!id || id.replace(/\s/g,"").length < 10) {
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
  if (!STATE.images.front) {
    setErr("front", "Please capture or upload the front of your ID");
    return false;
  }
  return true;
}

function validateStep3() {
  if (!STATE.images.back) {
    setErr("back", "Please capture or upload the back of your ID");
    return false;
  }
  return true;
}

function validateStep4() {
  if (!STATE.images.selfie) {
    setErr("selfie", "Please take a selfie");
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

  // If image already captured, don't restart camera
  if (STATE.images[side.toLowerCase()]) return;

  try {
    const facingMode = side === "Selfie" ? "user" : "environment";
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    STATE.streams[side] = stream;
    video.srcObject = stream;
  } catch (err) {
    console.warn("Camera error:", err);
    showToast("Camera unavailable — please upload a file instead", "error");
    // Hide camera frame, show only upload
    const frame = document.querySelector(`#captureZone${side} .camera-frame`);
    if (frame) frame.style.display = "none";
  }
}

function stopStream(side) {
  if (STATE.streams[side]) {
    STATE.streams[side].getTracks().forEach((t) => t.stop());
    delete STATE.streams[side];
  }
}

function capturePhoto(side) {
  const video = document.getElementById(`video${side}`);
  const canvas = document.getElementById(`canvas${side}`);

  if (!video || !video.videoWidth) {
    showToast("Camera not ready. Try uploading instead.", "error");
    return;
  }

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");

  // Mirror selfie so it looks natural
  if (side === "Selfie") {
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, 0, 0);

  const dataURL = canvas.toDataURL("image/jpeg", CONFIG.IMAGE_QUALITY);
  saveImage(side, dataURL);
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
  const key = side.toLowerCase();
  STATE.images[key] = dataURL;

  // Show preview, hide camera
  document.getElementById(`img${side}`).src = dataURL;
  document.getElementById(`preview${side}`).style.display = "block";
  document.getElementById(`captureZone${side}`)
    .querySelector(".camera-frame").style.display = "none";

  setErr(key, "");
  showToast(`${side} ID captured ✓`, "success");
}

// ══════════════════════════════════════════════════════════════
//  FILE UPLOAD
// ══════════════════════════════════════════════════════════════

function handleFileUpload(side, input) {
  const file = input.files[0];
  if (!file) return;

  // Size check
  if (file.size > CONFIG.MAX_IMAGE_SIZE_MB * 1024 * 1024) {
    showToast(`File too large (max ${CONFIG.MAX_IMAGE_SIZE_MB}MB)`, "error");
    input.value = "";
    return;
  }

  // Type check
  const allowed = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
  if (!allowed.includes(file.type)) {
    showToast("Only JPG, PNG, WebP, or PDF files are allowed", "error");
    input.value = "";
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    saveImage(side, e.target.result);
    // Mark as PDF for backend handling
    if (file.type === "application/pdf") {
      STATE.images[side.toLowerCase() + "_is_pdf"] = true;
    }
  };
  reader.readAsDataURL(file);
}

// ══════════════════════════════════════════════════════════════
//  REVIEW POPULATION
// ══════════════════════════════════════════════════════════════

function populateReview() {
  document.getElementById("rv-name").textContent =
    `${v("firstName")} ${v("lastName")}`;
  document.getElementById("rv-gender").textContent = STATE.gender;
  document.getElementById("rv-id").textContent = v("idNumber");
  document.getElementById("rv-phone").textContent = v("phoneNumber");
  document.getElementById("rv-msisdn").textContent = v("msisdn");
  document.getElementById("rv-district").textContent = v("district");

  if (STATE.images.front) document.getElementById("rv-front").src = STATE.images.front;
  if (STATE.images.back)  document.getElementById("rv-back").src  = STATE.images.back;
  if (STATE.images.selfie) document.getElementById("rv-selfie").src = STATE.images.selfie;
}

// ══════════════════════════════════════════════════════════════
//  SUBMIT — MAIN FLOW
// ══════════════════════════════════════════════════════════════

async function submitKYC() {
  const btn = document.getElementById("submitBtn");
  const label = document.getElementById("submitLabel");
  const spinner = document.getElementById("submitSpinner");

  // ── 1. Disable UI ──
  btn.disabled = true;
  label.textContent = "Validating…";
  spinner.classList.remove("hidden");

  try {
    // ── 2. Build payload ──
    const payload = {
      first_name:   v("firstName"),
      last_name:    v("lastName"),
      gender:       STATE.gender,
      id_number:    v("idNumber").replace(/\s/g, ""),
      phone_number: v("phoneNumber"),
      msisdn:       v("msisdn"),
      district:     v("district"),
      front_image:  stripDataPrefix(STATE.images.front),
      back_image:   stripDataPrefix(STATE.images.back),
      selfie:       stripDataPrefix(STATE.images.selfie),
      front_is_pdf: STATE.images.front_is_pdf || false,
    };

    // ── 3. Call FastAPI ──
    label.textContent = "AI Verification…";
    const validationResult = await callFastAPI(payload);

    // ── 4. If approved → send to Apps Script ──
    if (validationResult.status === "approved") {
      label.textContent = "Saving data…";
      await callAppsScript({ ...payload, validation: validationResult });
    }

    // ── 5. Show result screen ──
    showResult(validationResult);

  } catch (err) {
    console.error("Submission error:", err);
    showToast("Submission failed: " + err.message, "error");
  } finally {
    btn.disabled = false;
    label.textContent = "Submit for Verification";
    spinner.classList.add("hidden");
  }
}

async function callFastAPI(payload) {
  const res = await fetch(CONFIG.FASTAPI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Validation API error (${res.status}): ${errText}`);
  }
  return res.json();
}

async function callAppsScript(payload) {
  const res = await fetch(CONFIG.APPS_SCRIPT_URL, {
    method: "POST",
    // Apps Script requires text/plain for no-cors compatibility
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(payload),
    mode: "no-cors", // Apps Script CORS workaround
  });
  // no-cors returns opaque response; we can't read it but it succeeds
  return true;
}

// ══════════════════════════════════════════════════════════════
//  RESULT SCREEN
// ══════════════════════════════════════════════════════════════

function showResult(result) {
  goStepDirect(6);
  const container = document.getElementById("resultContainer");
  const approved = result.status === "approved";
  const scorePercent = Math.round((result.score || 0) * 100);

  let issuesHTML = "";
  if (!approved && result.issues && result.issues.length > 0) {
    issuesHTML = `
      <div class="result-issues">
        <h4>Issues Found</h4>
        <ul>
          ${result.issues.map((i) => `<li>${i}</li>`).join("")}
        </ul>
      </div>
    `;
  }

  container.innerHTML = `
    <div class="result-icon">${approved ? "✅" : "❌"}</div>
    <div class="result-title ${approved ? "approved" : "rejected"}">
      ${approved ? "Verification Approved!" : "Verification Failed"}
    </div>
    <div class="result-score">
      Confidence Score: <span class="score-value">${scorePercent}%</span>
    </div>
    ${issuesHTML}
    ${approved
      ? `<div class="result-meta">Your data has been securely saved.<br/>You will receive confirmation shortly.</div>`
      : `<div class="result-meta">Please correct the issues and try again.</div>`
    }
    <div class="result-actions">
      ${!approved
        ? `<button class="btn-primary" onclick="goStep(1)">↺ Try Again</button>`
        : ""}
      <button class="btn-restart" onclick="restartFull()">Start New Registration</button>
    </div>
  `;
}

function goStepDirect(n) {
  STATE.currentStep = n;
  document.querySelectorAll(".step").forEach((s, i) => {
    s.classList.toggle("active", i + 1 === n);
  });
  document.getElementById("stepBadge").textContent = n <= 5 ? `Step ${n} of 5` : "Complete";
  document.getElementById("progressFill").style.width = "100%";
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function restartFull() {
  // Stop all streams
  ["Front", "Back", "Selfie"].forEach(stopStream);
  // Reset state
  STATE.images = { front: null, back: null, selfie: null };
  STATE.gender = "Male";
  // Reset form fields
  document.querySelectorAll("input[type='text'], input[type='tel']").forEach((i) => (i.value = ""));
  document.getElementById("district").value = "";
  document.getElementById("sameAsPhone").checked = true;
  // Reset gender toggle
  document.querySelectorAll(".toggle-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.value === "Male");
  });
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
  document.querySelectorAll(".err").forEach((e) => (e.textContent = ""));
}

function stripDataPrefix(dataURL) {
  if (!dataURL) return null;
  return dataURL.includes(",") ? dataURL.split(",")[1] : dataURL;
}

function showToast(msg, type = "") {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.className = "toast show" + (type ? ` ${type}` : "");
  setTimeout(() => toast.classList.remove("show"), 3000);
}

// ══════════════════════════════════════════════════════════════
//  EVENT LISTENERS
// ══════════════════════════════════════════════════════════════

document.addEventListener("DOMContentLoaded", () => {

  // ── Gender Toggle ──
  document.querySelectorAll(".toggle-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".toggle-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      STATE.gender = btn.dataset.value;
    });
  });

  // ── Same as phone checkbox ──
  const sameCheck = document.getElementById("sameAsPhone");
  const msisdnInput = document.getElementById("msisdn");
  const phoneInput = document.getElementById("phoneNumber");

  function syncMsisdn() {
    if (sameCheck.checked) {
      msisdnInput.value = phoneInput.value;
      msisdnInput.disabled = true;
    } else {
      msisdnInput.disabled = false;
    }
  }

  sameCheck.addEventListener("change", syncMsisdn);
  phoneInput.addEventListener("input", syncMsisdn);
  syncMsisdn();

  // ── Auto-format ID number with spaces ──
  const idInput = document.getElementById("idNumber");
  idInput.addEventListener("input", () => {
    // Only digits and spaces allowed
    idInput.value = idInput.value.replace(/[^\d\s]/g, "");
  });
});
