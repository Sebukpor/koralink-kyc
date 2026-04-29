/**
 * KoraLink KYC — Google Apps Script Backend v1.4.0
 * ==================================================

// ── CONFIGURATION ──────────────────────────────────────────────
const SHEET_ID        = "1yqna0ogwlicCC3QXYBuNX9qtrEnM30ZJnLr0r0fAWnc";
const DRIVE_FOLDER_ID = "1hVlKjTf8hZWzir9hhrjhmNozWipi2c4j";
const SHEET_NAME      = "KoraLink KYC";
const VERSION         = "KoraLink KYC v1.5.0";

// ── CORS HEADERS ────────────────────────────────────────────────
// These allow the browser to read the response from a cross-origin fetch().
const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// ══════════════════════════════════════════════════════════════
//  doOptions — handles browser CORS pre-flight (OPTIONS) request
// ══════════════════════════════════════════════════════════════

function doOptions(e) {
  return ContentService
    .createTextOutput("")
    .setMimeType(ContentService.MimeType.TEXT);
  // Note: Apps Script does not let us set arbitrary headers on the response
  // object returned from doOptions/doPost. The CORS headers are handled
  // automatically by Google's infrastructure when the web app is deployed
  // as "Access: Anyone". For cases where the browser still blocks the
  // response, the frontend falls back to the form-POST path which bypasses
  // CORS response reading entirely.
}

// ══════════════════════════════════════════════════════════════
//  doPost — main entry point
// ══════════════════════════════════════════════════════════════

function doPost(e) {
  try {

    // ── 1. Parse JSON payload ──────────────────────────────────
    // Two paths depending on how the frontend sent the data:
    //   Path A: fetch() with Content-Type: application/json
    //           → payload is in e.postData.contents
    //   Path B: hidden <form> POST (fallback)
    //           → JSON string is in e.parameter.payload
    let raw, data;
    try {
      if (e.postData && e.postData.contents && e.postData.contents.trim().startsWith("{")) {
        raw = e.postData.contents;
      } else if (e.parameter && e.parameter.payload) {
        raw = e.parameter.payload;
      } else {
        return jsonResponse({ success: false, error: "No payload received. Expected JSON body or form field 'payload'." });
      }
      data = JSON.parse(raw);
    } catch (parseErr) {
      return jsonResponse({ success: false, error: "Invalid JSON: " + parseErr.toString() });
    }

    // ── 2. Validate required metadata fields ───────────────────
    const required = [
      "first_name", "last_name", "gender", "id_number",
      "phone_number", "msisdn", "district",
      "front_image", "selfie"
    ];
    const missing = required.filter(k => !data[k]);
    if (missing.length > 0) {
      return jsonResponse({ success: false, error: "Missing required fields: " + missing.join(", ") });
    }

    // ── 3. Gate on approved validation ─────────────────────────
    if (!data.validation || data.validation.status !== "approved") {
      return jsonResponse({
        success: false,
        error:   "Only approved KYC submissions are stored. Validation status: " +
                 (data.validation ? data.validation.status : "missing")
      });
    }

    // ── 4. Determine document mode ─────────────────────────────
    const docType = (data.doc_type || "id").toLowerCase();
    const isCert  = docType === "cert";

    Logger.log(
      "Processing KYC submission — ID: " + data.id_number +
      " | Name: " + data.first_name + " " + data.last_name +
      " | Mode: " + docType +
      " | isPdf: " + (data.front_is_pdf === true)
    );

    // ── 5. Create per-submission Drive folder ──────────────────
    // Folder name format: {MODE}_{ID_NUMBER}_{LAST_NAME}_{TIMESTAMP}
    // Example: ID_1200070045629060_UWASE_20240615_143022
    const rootFolder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
    const timestamp  = Utilities.formatDate(new Date(), "UTC", "yyyyMMdd_HHmmss");
    const folderName = [
      docType.toUpperCase(),
      data.id_number,
      data.last_name.toUpperCase().replace(/[^A-Z0-9]/g, "_"),
      timestamp
    ].join("_");
    const submFolder = rootFolder.createFolder(folderName);

    Logger.log("Created Drive folder: " + folderName + " (id=" + submFolder.getId() + ")");

    // ── 6. Save files to Drive ─────────────────────────────────
    let frontUrl = "", backUrl = "", selfieUrl = "";

    if (isCert) {
      // Certificate mode: front_image is the PDF, no back image
      frontUrl  = saveFileToDrive(submFolder, data.front_image, "replacement_certificate.pdf", MimeType.PDF);
      backUrl   = "";  // not applicable in cert mode
      selfieUrl = saveFileToDrive(submFolder, data.selfie,      "selfie.jpg",                  MimeType.JPEG);
    } else {
      // Standard ID mode: front + back photos + selfie
      frontUrl  = saveFileToDrive(submFolder, data.front_image, "front_id.jpg",  MimeType.JPEG);
      backUrl   = saveFileToDrive(submFolder, data.back_image,  "back_id.jpg",   MimeType.JPEG);
      selfieUrl = saveFileToDrive(submFolder, data.selfie,      "selfie.jpg",    MimeType.JPEG);
    }

    Logger.log("Drive URLs — front: " + (frontUrl || "FAILED") +
               " | back: "  + (backUrl  || (isCert ? "N/A" : "FAILED")) +
               " | selfie: " + (selfieUrl || "FAILED"));

    // Warn if any expected file failed to save
    if (!frontUrl) Logger.log("WARNING: front file save failed for " + data.id_number);
    if (!isCert && !backUrl)  Logger.log("WARNING: back file save failed for "   + data.id_number);
    if (!selfieUrl) Logger.log("WARNING: selfie save failed for " + data.id_number);

    // ── 7. Append row to Google Sheet ──────────────────────────
    const rowData = buildRowData(data, docType, submFolder.getId(), frontUrl, backUrl, selfieUrl);
    appendToSheet(rowData);

    Logger.log("Sheet row appended successfully for " + data.id_number);

    return jsonResponse({
      success:    true,
      message:    "KYC submission saved successfully.",
      doc_type:   docType,
      folder_id:  submFolder.getId(),
      folder_url: submFolder.getUrl(),
      front_url:  frontUrl  || null,
      back_url:   backUrl   || null,
      selfie_url: selfieUrl || null,
      timestamp:  new Date().toISOString()
    });

  } catch (err) {
    Logger.log("doPost FATAL ERROR: " + err.toString() + "\n" + err.stack);
    return jsonResponse({ success: false, error: "Server error: " + err.toString() });
  }
}

// ══════════════════════════════════════════════════════════════
//  File helpers
// ══════════════════════════════════════════════════════════════

/**
 * Decode a base64 string and save it as a file in the given Drive folder.
 *
 * Handles:
 *   - Raw base64 strings
 *   - Data URLs (data:image/jpeg;base64,...)
 *   - Large payloads: uses chunked decoding to avoid GAS memory limits
 *
 * Returns the file's shareable view URL, or "" on any failure.
 */
function saveFileToDrive(folder, b64, filename, mimeType) {
  if (!b64) {
    Logger.log("saveFileToDrive: skipping " + filename + " — no data provided");
    return "";
  }

  try {
    // Strip data-URL prefix if present (e.g. "data:image/jpeg;base64,")
    const clean = b64.includes(",") ? b64.split(",")[1] : b64;

    // Skip obvious placeholder images (≤ 300 bytes of base64 ≈ ≤ 225 bytes decoded)
    if (clean.length < 300) {
      Logger.log("saveFileToDrive: skipping " + filename + " — looks like a placeholder (length=" + clean.length + ")");
      return "";
    }

    // Decode base64 → byte array
    // Large strings are decoded in 256KB base64 chunks to avoid GAS memory limits
    const decoded = decodeBase64Chunked(clean);

    const blob = Utilities.newBlob(decoded, mimeType, filename);
    const file = folder.createFile(blob);

    // Make file accessible to anyone with the link (read-only)
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    const url = file.getUrl();
    Logger.log("Saved " + filename + " — size: " + decoded.length + " bytes | url: " + url);
    return url;

  } catch (err) {
    Logger.log("saveFileToDrive ERROR [" + filename + "]: " + err.toString());
    return "";
  }
}

/**
 * Decode a (potentially large) base64 string by processing it in 256KB chunks.
 * Google Apps Script's Utilities.base64Decode() can silently fail or throw
 * on very large strings. Chunking keeps each call well within safe limits.
 *
 * Returns a flat byte array (number[]).
 */
function decodeBase64Chunked(b64) {
  // Each base64 character encodes 6 bits; 256KB chunks = 256*1024*(4/3) ≈ 349,525 chars
  const CHUNK_CHARS = 349524;  // must be a multiple of 4 for valid base64 boundaries

  if (b64.length <= CHUNK_CHARS) {
    // Small enough to decode in one shot
    return Utilities.base64Decode(b64);
  }

  // Decode in chunks and concatenate
  let result = [];
  for (let i = 0; i < b64.length; i += CHUNK_CHARS) {
    const chunk   = b64.substring(i, i + CHUNK_CHARS);
    const decoded = Utilities.base64Decode(chunk);
    result = result.concat(Array.from(decoded));
  }
  return result;
}

// ══════════════════════════════════════════════════════════════
//  Sheet helpers
// ══════════════════════════════════════════════════════════════

/**
 * Build the row array for the Google Sheet.
 * Column order (19 columns):
 *   Timestamp | First Name | Last Name | Gender | ID Number |
 *   Phone | MSISDN | District | Document Type | Status |
 *   Confidence Score | Drive Folder | Doc 1 Label | Doc 1 URL |
 *   Doc 2 Label | Doc 2 URL | Doc 3 Label | Selfie URL |
 *   Issues | Source
 */
function buildRowData(data, docType, folderId, frontUrl, backUrl, selfieUrl) {
  const v      = data.validation || {};
  const isCert = docType === "cert";
  const score  = typeof v.score === "number" ? (v.score * 100).toFixed(1) + "%" : "—";
  const issues = Array.isArray(v.issues) && v.issues.length > 0
    ? v.issues.join("; ")
    : "None";

  // Drive folder hyperlink formula for easy navigation from the sheet
  const folderUrl    = "https://drive.google.com/drive/folders/" + folderId;
  const folderFormula = '=HYPERLINK("' + folderUrl + '","📁 Open Folder")';

  // Helper: turn a URL into a clickable hyperlink formula, or "—" if empty
  function linkOrDash(url, label) {
    if (!url) return "—";
    return '=HYPERLINK("' + url + '","' + label + '")';
  }

  return [
    new Date(),                                          // A: Timestamp
    data.first_name,                                     // B: First Name
    data.last_name,                                      // C: Last Name
    data.gender,                                         // D: Gender
    data.id_number,                                      // E: ID Number
    data.phone_number,                                   // F: Phone
    data.msisdn,                                         // G: MSISDN
    data.district,                                       // H: District
    isCert ? "Replacement Certificate" : "National ID",  // I: Document Type
    v.status  || "approved",                             // J: Status
    score,                                               // K: Confidence Score
    folderFormula,                                       // L: Drive Folder
    isCert ? "Certificate (PDF)" : "Front ID",           // M: Doc 1 Label
    linkOrDash(frontUrl,  isCert ? "📄 Certificate" : "🪪 Front ID"),  // N: Doc 1 URL
    isCert ? "—" : "Back ID",                            // O: Doc 2 Label
    isCert ? "—" : linkOrDash(backUrl, "🪪 Back ID"),    // P: Doc 2 URL
    "Selfie",                                            // Q: Doc 3 Label
    linkOrDash(selfieUrl, "🤳 Selfie"),                  // R: Selfie URL
    issues,                                              // S: Issues
    VERSION                                              // T: Source
  ];
}

/**
 * Append a row to the KYC sheet, creating the sheet with headers if needed.
 */
function appendToSheet(rowData) {
  const ss    = SpreadsheetApp.openById(SHEET_ID);
  let   sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);

    const headers = [
      "Timestamp", "First Name", "Last Name", "Gender", "ID Number",
      "Phone", "MSISDN", "District", "Document Type", "Status",
      "Confidence Score", "Drive Folder",
      "Doc 1 Label", "Doc 1 URL",
      "Doc 2 Label", "Doc 2 URL",
      "Doc 3 Label", "Selfie URL",
      "Issues", "Source"
    ];

    sheet.appendRow(headers);

    const hRange = sheet.getRange(1, 1, 1, headers.length);
    hRange.setBackground("#1E6BFF")
          .setFontColor("#FFFFFF")
          .setFontWeight("bold")
          .setFontFamily("Arial")
          .setFontSize(10);

    sheet.setFrozenRows(1);

    // Column widths
    sheet.setColumnWidth(1,  160);  // Timestamp
    sheet.setColumnWidth(5,  200);  // ID Number
    sheet.setColumnWidth(12, 160);  // Drive Folder
    sheet.setColumnWidth(14, 250);  // Doc 1 URL
    sheet.setColumnWidth(16, 250);  // Doc 2 URL
    sheet.setColumnWidth(18, 250);  // Selfie URL
    sheet.setColumnWidth(19, 350);  // Issues

    Logger.log("Created new sheet '" + SHEET_NAME + "' with headers.");
  }

  sheet.appendRow(rowData);

  // Alternating row background for readability
  const lastRow = sheet.getLastRow();
  if (lastRow % 2 === 0) {
    sheet.getRange(lastRow, 1, 1, rowData.length)
         .setBackground("#F0F4FF");
  }

  // Auto-resize timestamp column
  sheet.autoResizeColumn(1);
}

// ══════════════════════════════════════════════════════════════
//  Utility
// ══════════════════════════════════════════════════════════════

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ══════════════════════════════════════════════════════════════
//  doGet — health check
// ══════════════════════════════════════════════════════════════

function doGet(e) {
  return jsonResponse({
    service: "KoraLink KYC Apps Script",
    version: VERSION,
    status:  "running",
    sheet:   SHEET_ID,
    folder:  DRIVE_FOLDER_ID,
    time:    new Date().toISOString()
  });
}

// ══════════════════════════════════════════════════════════════
//  TEST FUNCTIONS — run manually in the Apps Script editor
// ══════════════════════════════════════════════════════════════

/**
 * Run this from the Apps Script editor to verify Sheet + Drive connectivity
 * before going live. Check the Execution Log for results.
 */
function testIDSubmission() {
  const mockEvent = {
    parameter: {},
    postData: {
      contents: JSON.stringify({
        first_name:   "Sumaya",
        last_name:    "Uwase",
        gender:       "Female",
        id_number:    "1200070045629060",
        phone_number: "0781234567",
        msisdn:       "0781234567",
        district:     "Rwamagana",
        doc_type:     "id",
        front_is_pdf: false,
        // These are tiny valid JPEGs (not placeholders) — long enough to pass the 300-char check
        front_image: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoH" +
                     "BwYIDAoMCwsKCwsNCxAQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/wAARC" +
                     "AACAAIDASIA2gABAREA/8QAFgABAQEAAAAAAAAAAAAAAAAABgUEB//EACMQAAIB" +
                     "BAMBAQEAAAAAAAAAAAECAwQFERIhMUH/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8Q" +
                     "AFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8Aqk2taJptuZ9Q1K1so" +
                     "1GSZ5lQD8yQKi9Q8QaPqdwbbT9Vs7ydhlY4Z1Zh+AJoooA//9k=",
        back_image:  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoH" +
                     "BwYIDAoMCwsKCwsNCxAQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/wAARC" +
                     "AACAAIDASIA2gABAREA/8QAFgABAQEAAAAAAAAAAAAAAAAABgUEB//EACMQAAIBBAMBAQEAAAAAAAAAAAECAwQFERIhMUH/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8Aqk2taJptuZ9Q1K1soA==",
        selfie:      "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoH" +
                     "BwYIDAoMCwsKCwsNCxAQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/wAARC" +
                     "AACAAIDASIA2gABAREA/8QAFgABAQEAAAAAAAAAAAAAAAAABgUEB//EACMQAAIBBAMBAQEAAAAAAAAAAAECAwQFERIhMUH/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8Aqk2taJptuZ9Q1K1soA==",
        validation: { status: "approved", score: 0.90, issues: [] }
      })
    }
  };
  const result = doPost(mockEvent);
  Logger.log("testIDSubmission result: " + result.getContent());
}

function testCertSubmission() {
  const mockEvent = {
    parameter: {},
    postData: {
      contents: JSON.stringify({
        first_name:   "Janvier",
        last_name:    "Mwnedata",
        gender:       "Female",
        id_number:    "1199870085095057",
        phone_number: "0781234567",
        msisdn:       "0781234567",
        district:     "Gasabo",
        doc_type:     "cert",
        front_is_pdf: true,
        // Minimal valid PDF base64 (just enough to pass the 300-char check)
        front_image: "JVBERi0xLjQKJcOkw7zDtsOfCjIgMCBvYmoKPDwvTGVuZ3RoIDMgMCBSL0ZpbHRlci9GbGF0ZURlY29kZT4+CnN0cmVhbQp4nCtUMlAqS60oKUpVslIqLU4tykvMTQUAKqQF5gplbmRzdHJlYW0KZW5kb2JqCjMgMCBvYmoKMzUKZW5kb2JqCjQgMCBvYmoKPDwvVHlwZS9YT2JqZWN0L1N1YnR5cGUvRm9ybS9CQm94WzAgMCA2MTIgNzkyXS9SZXNvdXJjZXM8PC9Gb250PDwvRjE8PC9UeXBlL0ZvbnQvU3VidHlwZS9UeXBlMS9CYXNlRm9udC9IZWx2ZXRpY2E+Pj4+Pj4vTGVuZ3RoIDUgMCBSL0ZpbHRlci9GbGF0ZURlY29kZT4+CnN0cmVhbQp4nCtUMlAqS60oKUpVslIqLU4tykvMTU0tykvMTa0oKUpVMtRRKkktLk4tKs9ILUpVslIqy0xJLSoGAFBxD6MKZW5kc3RyZWFtCmVuZG9iago=",
        back_image:   "",
        selfie:       "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMCwsKCwsNCxAQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/wAARCAACAA" +
                      "IDASIA2gABAREA/8QAFgABAQEAAAAAAAAAAAAAAAAABgUEB//EACMQAAIBBAMBAQEAAAAAAAAAAAECAwQFERIhMUH/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8Aqk2taJptuZ9Q1K1soA==",
        validation: { status: "approved", score: 0.82, issues: [] }
      })
    }
  };
  const result = doPost(mockEvent);
  Logger.log("testCertSubmission result: " + result.getContent());
}

/**
 * Quick connectivity test — verifies SHEET_ID and DRIVE_FOLDER_ID are correct.
 * Run this first before deploying.
 */
function testConnectivity() {
  try {
    const ss     = SpreadsheetApp.openById(SHEET_ID);
    const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
    Logger.log("✅ Sheet found: " + ss.getName());
    Logger.log("✅ Drive folder found: " + folder.getName());
  } catch (err) {
    Logger.log("❌ Connectivity test FAILED: " + err.toString());
  }
}
