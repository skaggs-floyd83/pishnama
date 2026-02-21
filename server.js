// ============================================================================
// Pishnama — Backend Image Generation Server
// server.js
//
// This backend receives FormData from the frontend (sofa.html or pillows.html),
// including: meta.json (as text), base image, and fabric images.
//
// It then:
//   • Determines which prompt to use (prompt1, prompt2, prompt3, or prompt4)
//     based on meta.mode and meta.mode_selection.
//   • Maps the quality ("standard" or "high") to:
//         - input_fidelity (low/high)
//         - output quality (medium/high)
//         - result size (1024x1024 or 2048x2048)
//   • Sends everything to OpenAI's Images Edit API using model gpt-image-1
//   • Returns the generated image as a base64 string.
//
// NOTE: This is a full rewrite, as requested, with no normalization or compression.
// ============================================================================

import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import dotenv from "dotenv";
import sharp from "sharp";

// AI model abstraction (OpenAI / Gemini)
// import { generateImage } from "./aiAdapter_aval.js";
import { generateImage } from "./aiAdapter_gap.js";

// ===== NEW: Added for serving HTML files =====
import path from "path";
import { fileURLToPath } from "url";
// =============================================

// ===== LOGIN SYSTEM (NEW) =====
import crypto from "crypto"; 
import nodemailer from "nodemailer";

// import DB & migrations
import { runMigrations, db } from "./db.js";


import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GetObjectCommand } from "@aws-sdk/client-s3";

import https from "https";
import { NodeHttpHandler } from "@smithy/node-http-handler";



dotenv.config({ quiet: true });

// ====================== PERSISTENCE DEBUG LOGGING ===========================
// Enable with: PERSIST_LOG_VERBOSE=true
const PERSIST_LOG_VERBOSE = (process.env.PERSIST_LOG_VERBOSE || "false") === "true";

// Tracks how many background persistence jobs are running concurrently.
let ACTIVE_PERSIST_JOBS = 0;

function nowIso() {
  return new Date().toISOString();
}

function msSince(t0) {
  return Date.now() - t0;
}

function shortHash(hex, n = 12) {
  if (!hex) return null;
  return String(hex).slice(0, n);
}

function safeNum(n) {
  return Number.isFinite(n) ? n : null;
}

// ---------------------- Buffered persistence logs -----------------
// We buffer logs per-trace and only print them if persistence ultimately fails.
const TRACE_LOG_BUFFER = new Map(); // trace -> payload[]
const TRACE_LOG_MAX_EVENTS = 600;    // safety cap per trace (avoid runaway memory)

function logP(trace, event, details = {}) {
  if (!PERSIST_LOG_VERBOSE) return;

  const t = trace || null;
  const payload = {
    ts: nowIso(),
    trace: t,
    event,
    ...details
  };

  if (!t) return; // no trace => nothing to buffer

  let arr = TRACE_LOG_BUFFER.get(t);
  if (!arr) {
    arr = [];
    TRACE_LOG_BUFFER.set(t, arr);
  }

  // Cap per-trace memory usage
  if (arr.length < TRACE_LOG_MAX_EVENTS) {
    arr.push(payload);
  } else if (arr.length === TRACE_LOG_MAX_EVENTS) {
    arr.push({
      ts: nowIso(),
      trace: t,
      event: "log_buffer_capped",
      maxEvents: TRACE_LOG_MAX_EVENTS
    });
  }
}

function discardTraceLogs(trace) {
  if (!trace) return;
  TRACE_LOG_BUFFER.delete(trace);
}

function flushTraceLogs(trace, reason = "unknown") {
  if (!trace) return;

  const arr = TRACE_LOG_BUFFER.get(trace);
  if (!arr || arr.length === 0) return;

  console.error(`[PERSIST][FLUSH] trace=${trace} reason=${reason} events=${arr.length}`);
  for (const payload of arr) {
    console.error("[PERSIST]", JSON.stringify(payload));
  }

  TRACE_LOG_BUFFER.delete(trace);
}
// ---------------------------------------------------------------------------


// ============================================================================




// ====================== S3-COMPATIBLE STORAGE (NEW) ===========================
// Works with AWS S3 and S3-compatible providers (MinIO, Wasabi, Backblaze B2 S3, etc.)
const S3_BUCKET = process.env.S3_BUCKET;
const S3_REGION = process.env.S3_REGION || "us-east-1";
const S3_ENDPOINT = process.env.S3_ENDPOINT; // optional for non-AWS providers
const S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID;
const S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY;
const S3_FORCE_PATH_STYLE = (process.env.S3_FORCE_PATH_STYLE || "false") === "true";

if (!S3_BUCKET || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) {
  console.warn("WARNING: S3 storage env vars missing. Cloud storage will not work until configured.");
}


const s3 = new S3Client({
  region: S3_REGION,
  endpoint: S3_ENDPOINT || undefined,
  forcePathStyle: S3_FORCE_PATH_STYLE,
  credentials: {
    accessKeyId: S3_ACCESS_KEY_ID || "",
    secretAccessKey: S3_SECRET_ACCESS_KEY || ""
  },

  // Helps a LOT with random ECONNRESET / socket drops on some S3-compatible providers
  requestHandler: new NodeHttpHandler({
    httpsAgent: new https.Agent({
      keepAlive: true,
      maxSockets: 50
    }),
    connectionTimeout: 10_000, // 10s to establish connection
    socketTimeout: 120_000     // 120s for upload/download
  }),

  // AWS SDK retry behavior; keep modest
  maxAttempts: 5
});

function briefS3Err(err) {
  return {
    name: err?.name,
    code: err?.code,
    errno: err?.errno,
    syscall: err?.syscall,
    message: err?.message,
    metadata: err?.$metadata
  };
}


async function s3Send(cmd, label, ctx = null) {
  const t0 = Date.now();

  // Optional start log (verbose)
  if (ctx?.trace) {
    logP(ctx.trace, "s3_send_start", {
      label,
      key: ctx?.storageKey || null,
      bytes: safeNum(ctx?.byteSize),
      mime: ctx?.mimeType || null
    });
  }

  try {
    const out = await s3.send(cmd);

    if (ctx?.trace) {
      logP(ctx.trace, "s3_send_ok", {
        label,
        key: ctx?.storageKey || null,
        ms: msSince(t0)
      });
    }

    return out;
  } catch (err) {
    console.error(`S3 error during ${label}:`, briefS3Err(err));

    if (ctx?.trace) {
      logP(ctx.trace, "s3_send_fail", {
        label,
        key: ctx?.storageKey || null,
        bytes: safeNum(ctx?.byteSize),
        mime: ctx?.mimeType || null,
        ms: msSince(t0),
        err: briefS3Err(err)
      });
    }

    throw err;
  }
}




function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function guessExtFromMime(mime) {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  return "jpg"; // default
}

// Ensure the object exists in S3 for a given key; if not, re-upload.
// This protects against rare cases where DB row exists but object was deleted or upload failed mid-way.
async function ensureObjectExists({ storageKey, buffer, mimeType, trace = null }) {
  const t0 = Date.now();

  try {
    await s3Send(
      new HeadObjectCommand({ Bucket: S3_BUCKET, Key: storageKey }),
      `HeadObject ${storageKey}`,
      { trace, storageKey }
    );

    if (trace) {
      logP(trace, "s3_head_exists", { key: storageKey, ms: msSince(t0) });
    }

    return; // exists
  } catch (e) {
    if (trace) {
      logP(trace, "s3_head_missing_or_fail", {
        key: storageKey,
        ms: msSince(t0),
        err: briefS3Err(e)
      });
    }

    // If missing (or any head failure), try to re-upload idempotently.
    await s3Send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: storageKey,
        Body: buffer,
        ContentType: mimeType,
        ACL: "private"
      }),
      `PutObject(reupload) ${storageKey}`,
      { trace, storageKey, byteSize: buffer?.length, mimeType }
    );

    if (trace) {
      logP(trace, "s3_reupload_ok", { key: storageKey });
    }
  }
}




// Insert-or-reuse an image row (dedup) + ensure object exists in bucket
async function upsertImageForUser({ userId, buffer, mimeType, scope = "user", trace = null, role = null }) {
  const hash = sha256Hex(buffer);
  const byteSize = buffer.length;
  const ext = guessExtFromMime(mimeType);

  const t0 = Date.now();

  if (trace) {
    logP(trace, "img_upsert_start", {
      role: role || null,
      scope,
      userId,
      bytes: byteSize,
      mime: mimeType || null,
      sha: shortHash(hash)
    });
  }



  const ownerUserId = scope === "user" ? userId : null;

  // Stable key => perfect for dedup and CDN caching later
  const storageKey =
    scope === "user"
      ? `u/${userId}/${hash}.${ext}`
      : `g/${hash}.${ext}`;

  // Fast path: if row exists, ensure object exists and return
  const existing = db.prepare(`
    SELECT id, storage_key
    FROM images
    WHERE scope = ?
      AND owner_user_id IS ?
      AND sha256 = ?
  `).get(scope, ownerUserId, hash);

  if (existing) {
    await ensureObjectExists({ storageKey: existing.storage_key, buffer, mimeType, trace });
    if (trace) {
      logP(trace, "img_upsert_reused", {
        role: role || null,
        imageId: existing.id,
        key: existing.storage_key,
        sha: shortHash(hash),
        ms: msSince(t0)
      });
    }

    return { imageId: existing.id, storageKey: existing.storage_key, reused: true };
  }

  // Upload object first (idempotent because key is stable)
  await s3Send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: storageKey,
      Body: buffer,
      ContentType: mimeType,
      ACL: "private"
    }),
    `PutObject(dedup) ${storageKey}`,
    { trace, storageKey, byteSize, mimeType }
  );



  try {
    const info = db.prepare(`
      INSERT INTO images (scope, owner_user_id, sha256, byte_size, mime_type, storage_key)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(scope, ownerUserId, hash, byteSize, mimeType, storageKey);

    if (trace) {
      logP(trace, "img_upsert_inserted", {
        role: role || null,
        imageId: info.lastInsertRowid,
        key: storageKey,
        sha: shortHash(hash),
        ms: msSince(t0)
      });
    }
    return { imageId: info.lastInsertRowid, storageKey, reused: false };

  } catch (err) {
    // Race-safe dedup: another request may have inserted the same (scope, owner, sha256)
    const msg = String(err?.message || "");
    if (msg.includes("UNIQUE") || msg.includes("constraint")) {
      const row = db.prepare(`
        SELECT id, storage_key
        FROM images
        WHERE scope = ?
          AND owner_user_id IS ?
          AND sha256 = ?
      `).get(scope, ownerUserId, hash);

      if (row) {
        await ensureObjectExists({ storageKey: row.storage_key, buffer, mimeType, trace });
        if (trace) {
          logP(trace, "img_upsert_race_reused", {
            role: role || null,
            imageId: row.id,
            key: row.storage_key,
            sha: shortHash(hash),
            ms: msSince(t0)
          });
        }

        return { imageId: row.id, storageKey: row.storage_key, reused: true };
      }
    }

    console.error("Image upsert failed:", {
      userId,
      storageKey,
      err: err.message
    });

    if (trace) {
      logP(trace, "img_upsert_fail", {
        role: role || null,
        scope,
        userId,
        key: storageKey,
        sha: shortHash(hash),
        bytes: byteSize,
        mime: mimeType || null,
        ms: msSince(t0),
        err: String(err?.message || err)
      });
    }

    throw err;

  }
}



// Insert image WITHOUT deduplication (used for output images only)
async function insertImageNoDedup({ userId, buffer, mimeType, scope = "user", trace = null, role = null }) {

  const hash = sha256Hex(buffer); // stored for reference, NOT for dedup
  const byteSize = buffer.length;
  const ext = guessExtFromMime(mimeType);

  const t0 = Date.now();
  if (trace) {
    logP(trace, "img_output_start", {
      role: role || null,
      scope,
      userId,
      bytes: byteSize,
      mime: mimeType || null,
      sha: shortHash(hash)
    });
  }


  const ownerUserId = scope === "user" ? userId : null;

  // Unique key per call — prevents accidental reuse
  const uniqueSuffix = crypto.randomBytes(8).toString("hex");
  const storageKey =
    scope === "user"
      ? `u/${userId}/out/${Date.now()}_${uniqueSuffix}.${ext}`
      : `g/out/${Date.now()}_${uniqueSuffix}.${ext}`;

  

  await s3Send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: storageKey,
      Body: buffer,
      ContentType: mimeType,
      ACL: "private"
    }),
    `PutObject(output) ${storageKey}`,
    { trace, storageKey, byteSize, mimeType }
  );


  const info = db.prepare(`
    INSERT INTO images (scope, owner_user_id, sha256, byte_size, mime_type, storage_key)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(scope, ownerUserId, hash, byteSize, mimeType, storageKey);

  if (trace) {
    logP(trace, "img_output_ok", {
      role: role || null,
      imageId: info.lastInsertRowid,
      key: storageKey,
      ms: msSince(t0)
    });
  }


  return { imageId: info.lastInsertRowid, storageKey };
}


async function presignGetUrl(storageKey, expiresSeconds = 60) {
  const cmd = new GetObjectCommand({ Bucket: S3_BUCKET, Key: storageKey });
  return await getSignedUrl(s3, cmd, { expiresIn: expiresSeconds });
}













// ================= EMAIL TRANSPORTER (Nodemailer) =================
const emailTransporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || "smtp.gmail.com",
  port: Number(process.env.EMAIL_PORT) || 587,
  secure: false, // true only for 465
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// ================== SMS PANEL CONFIG (IPPANEL) ====================
const smsPanelToken = process.env.SMS_PANEL_TOKEN;
const smsFromNumber = process.env.SMS_FROM_NUMBER || "+983000505";

// ===== NEW: Added for serving HTML files =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


// ====================== HISTORY CONFIG ===========================
const HISTORY_PAGE_SIZE_DEFAULT = 20;
const HISTORY_PAGE_SIZE_MAX = 20;
const BASE_IMAGES_PAGE_SIZE_DEFAULT = 30;
const BASE_IMAGES_PAGE_SIZE_MAX = 50;
const FABRICS_PAGE_SIZE_DEFAULT = 30;
const FABRICS_PAGE_SIZE_MAX = 50;



const app = express();

// ===========================
// LOGIN CODE STORE (single-instance OK)
// ===========================
const loginCodes = {}; // short-lived, single-instance



// ===== static file serving  =====
app.use("/ui", express.static(path.join(__dirname, "public", "static")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "sofa.html"));
});

// Explicit HTML entry points (no directory-wide static serving)
app.get("/sofa", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "sofa.html"));
});

app.get("/pillows", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "pillows.html"));
});



// ===========================================


// ====================== HARD UPLOAD GUARDRAILS (Stage 4.4) ===================
// Hard caps to prevent memory spikes and unexpected provider costs.
const MAX_UPLOAD_FILES_HARD = 8;                 // base + base_raw + up to 6 fabrics (future-safe)
const MAX_UPLOAD_FILE_BYTES_HARD = 20 * 1024 * 1024; // 20 MB per file hard reject (pre-sharp)
const MAX_TOTAL_UPLOAD_BYTES_HARD = 40 * 1024 * 1024; // 40 MB total (pre-sharp)
const MAX_FABRICS_HARD = 3;                      // current product rule (sofa: up to 3, pillows: up to 3)

// We store uploads in memory because we immediately pipe them to the OpenAI API.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_FILE_BYTES_HARD,
    files: MAX_UPLOAD_FILES_HARD
  }
});


// ---------------------------------------------------------------------------
//  Define ALL FOUR PROMPTS explicitly
//  Replace the placeholders with your actual detailed prompts.
// ---------------------------------------------------------------------------
const prompt1 = `
replace the fabric of the sofa with the fabric in the other image so that all parts of the sofa appear to be made from exactly that fabric, with the same color and the same pattern.
`;                                                                                                                                         
// testing shirt replacement
// const prompt1 = `
// replace the fabric of the shirt of the boy with the fabric in the other image.
// `;

// const prompt3 = `
// Replace the fabric of all of the decorative pillows in the first image (including the probably dark ones or overlaid ones etc.), with the fabric in the second image so that all pillows appear to be made from exactly that fabric, with the same color and the same pattern. do not change anything else and keep everything else exactly as it is in the first image (this is very important). do not change anything like the carpet or such and keep them exactly as they are in the first image.
// `;
const prompt3 = `
Replace the fabric of all of the decorative pillows in the first image (including the probably dark ones or overlaid ones etc.), with the fabric in the second image so that all pillows appear to be made from exactly that fabric.
`;



// ============================================================================
// Dynamic prompt generator for:
//    mode = "sofa"
//    mode_selection = "partial"
// ============================================================================
// ============================================================================
// Dynamic prompt for prompt2 (sofa multi-fabric with possible "unchanged" parts)
// ============================================================================
function buildPrompt2(meta) {
  // First, create a reverse mapping: part → fabric index (1,2,3) or null
  const partToFabric = { back: null, seat: null, arms: null };

  meta.fabrics.forEach((f, index) => {
    f.parts.forEach(part => {
      partToFabric[part] = index + 1; // fabric indices are 1-based
    });
  });

  // Helper to convert index → label
  function fabricLabel(n) {
    if (n === 1) return "first fabric image";
    if (n === 2) return "second fabric image";
    if (n === 3) return "third fabric image";
    return null;
  }

  // Build each mapping line in the required format
  const mappings = [];

  ["back", "seat", "arms"].forEach(part => {
    const assigned = partToFabric[part];
    const label = assigned
      ? fabricLabel(assigned)
      : "do not change its fabric, keep its fabric exactly as it is in the original sofa image.";

    // Format exactly as you requested:
    // Back -> second fabric image
    mappings.push(`${capitalize(part)} -> ${label}`);
  });

  const lines = [];

  lines.push("The first image includes a sofa. replace the fabric of the “sofa parts” (back, seat, arms) using the fabrics in the other images, according to the following mapping:");
  lines.push(mappings.join("\n"));
  lines.push("The reupholstered parts of the sofa should appear to be made from exactly the associated fabric, with the same color and the same pattern. Do not change anything else and keep everything else exactly and completely as it is in the first image. Do not change anything like the carpet or such and keep them exactly as they are in the first image.");

  return lines.join("\n");
}

// Small helper to capitalize the part names
function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// ============================================================================
// Dynamic prompt for prompt4 (pillows multi-fabric with 1–3 fabrics)
// ============================================================================

function buildPrompt4(meta) {
  const fabricCount = meta?.fabrics?.length || 0;

  // SAFETY GUARD (should never happen because of hard limits, but safe anyway)
  if (fabricCount < 1 || fabricCount > 3) {
    throw new Error("Invalid number of fabrics for prompt4");
  }

  const PROMPT4_ONE_FABRIC = `
Replace the fabric of the decorative pillows (including the probably dark ones or overlaid ones etc.) at marker locations using the fabric in the uploaded image. The fabric should be used for pillows tagged with F1 (red). the tags should not be included in the generated image. Each marker marks only one pillow, and shouldn't affect other pillows. Keep the fabric of the pillows that are not tagged (do not have a marker on them) unchanged even if they are very close, or over, or under a tagged pillow.
`;

  const PROMPT4_TWO_FABRICS = `
Replace the fabric of the decorative pillows (including the probably dark ones or overlaid ones etc.) at marker locations using the fabrics in the uploaded images. first fabric should be used for pillows tagged with F1 (red), second fabric should be used for pillows tagged with F2 (green). the tags should not be included in the generated image. Each marker marks only one pillow, and shouldn't affect other pillows. Keep the fabric of the pillows that are not tagged (do not have a marker on them) unchanged even if they are very close, or over, or under a tagged pillow.
`;

  const PROMPT4_THREE_FABRICS = `
Replace the fabric of the decorative pillows (including the probably dark ones or overlaid ones etc.) at marker locations using the fabrics in the uploaded images. first fabric should be used for pillows tagged with F1 (red), second fabric should be used for pillows tagged with F2 (green) and third fabric should be used for pillows tagged with F3 (blue). the tags should not be included in the generated image. Each marker marks only one pillow, and shouldn't affect other pillows. Keep the fabric of the pillows that are not tagged (do not have a marker on them) unchanged even if they are very close, or over, or under a tagged pillow.
`;

  if (fabricCount === 1) {
    return PROMPT4_ONE_FABRIC;
  }

  if (fabricCount === 2) {
    return PROMPT4_TWO_FABRICS;
  }

  return PROMPT4_THREE_FABRICS;
}




// ====================== LOGIN HELPERS ===========================

function isEmail(identifier) {
  return identifier.includes("@");
}

function isValidEmailServer(str) {
  return /\S+@\S+\.\S+/.test(str);
}


function isValidPhoneServer(str) {
  // Normalized numbers: +989xxxxxxxxx
  return /^\+989\d{9}$/.test(str);
}


async function sendLoginEmail(email, code) {
  if (!emailTransporter) {
    console.warn("Email transporter not configured.");
    return;
  }

  const from = process.env.EMAIL_FROM || process.env.EMAIL_USER;

  await emailTransporter.sendMail({
    from,
    to: email,
    subject: "کد ورود پیشنما",
    text: `کد ورود شما: ${code}`
  });
}

async function sendLoginSms(phone, code) {
  const body = {
    sending_type: "webservice",
    from_number: smsFromNumber,
    message: `کد ورود شما: ${code}`,
    params: {
      recipients: [phone]
    }
  };

  const res = await fetch("https://edge.ippanel.com/v1/api/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": smsPanelToken   // whatever final correct format you fixed
    },
    body: JSON.stringify(body)
  });

  const resultText = await res.text();
  // console.log("IPPANEL RAW RESPONSE:", resultText);

  if (!res.ok) {
    console.error("SMS send failed:", resultText);
    throw new Error("sms_send_failed");
  }

  console.log("SMS send accepted by panel:", resultText);
}


// ====================== AUTH TOKEN CONFIG ===========================
const AUTH_TOKEN_DAYS = 30; // persistent login lifetime


// ====================== CREDIT CONFIG & HELPERS===========================

// Maximum number of old credits that can be preserved on top-up
const CREDIT_KEEP_THRESHOLD = 10;

// Fixed model configuration (single model, single quality)
const FIXED_MODEL_QUALITY = "high";
const CREDIT_COST_FIXED = 2;

// Default expiration for new credit packages (days)
const CREDIT_PACKAGE_DAYS = 30;

// Low-level DB helpers (safe primitives)

// Fetch user row
function getUserById(userId) {
  return db
    .prepare(
      `SELECT id, credits, credits_expires_at
       FROM users
       WHERE id = ?`
    )
    .get(userId);
}

// Expire credits if needed (self-healing)
function expireCreditsIfNeeded(user) {
  if (!user) return null;

  if (
    user.credits_expires_at &&
    new Date(user.credits_expires_at) < new Date()
  ) {
    db.prepare(
      `UPDATE users
       SET credits = 0,
           credits_expires_at = NULL
       WHERE id = ?`
    ).run(user.id);

    return {
      ...user,
      credits: 0,
      credits_expires_at: null
    };
  }

  return user;
}

// Public credit reader (This becomes the only way the rest of your code reads credits.)
function getUserCredits(userId) {
  let user = getUserById(userId);
  if (!user) return null;

  user = expireCreditsIfNeeded(user);

  return {
    credits: user.credits,
    credits_expires_at: user.credits_expires_at
  };
}

// Generation cost calculator (fixed)
function getGenerationCost(_meta) {
  return CREDIT_COST_FIXED;
}




///
// Credit deduction primitive (This function assumes sufficiency)
function deductCredits(userId, amount) {
  db.prepare(
    `UPDATE users
     SET credits = credits - ?
     WHERE id = ?`
  ).run(amount, userId);
}

/**
 * Atomically reserve credits (deduct now) to prevent race conditions.
 * If anything later fails, call refundCredits().
 *
 * This is done inside a DB transaction to:
 *   1) self-heal expired credits
 *   2) then deduct only if sufficient balance remains
 */
function reserveCredits(userId, amount) {
  return db.transaction(() => {
    // Ensure expiry is applied before we reserve
    let user = getUserById(userId);
    if (!user) return false;
    user = expireCreditsIfNeeded(user);

    const info = db.prepare(`
      UPDATE users
      SET credits = credits - ?
      WHERE id = ?
        AND credits >= ?
    `).run(amount, userId, amount);

    return info.changes === 1;
  })();
}

function refundCredits(userId, amount) {
  db.prepare(`
    UPDATE users
    SET credits = credits + ?
    WHERE id = ?
  `).run(amount, userId);
}

///






function addDaysToNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}



















// ===============================================
// POST /api/request-code
// Receives: { identifier: "email OR phone" }
// ===============================================
app.post("/api/request-code", express.json(), async (req, res) => {

  // Rate limit protection
  const ip = req.ip || req.connection.remoteAddress || "unknown";
  const rl = rateLimit({
    key: `request-code:${ip}`,
    limit: 5,
    windowMs: 10 * 60 * 1000 // 10 minutes
  });
  if (!rl.allowed) {
    return res.status(429).json({ error: "too_many_requests" });
  }


  try {
    let { identifier } = req.body;
    if (!identifier) {
      return res.status(400).json({ error: "identifier required" });
    }

    // Validate identifier
    if (!isValidEmailServer(identifier) && !isValidPhoneServer(identifier)) {
      return res.status(400).json({ error: "invalid_identifier" });
    }

    const code = String(Math.floor(1000 + Math.random() * 9000));
    loginCodes[identifier] = code;

    console.log("LOGIN CODE for " + identifier + ": " + code);

    if (isEmail(identifier)) {
      await sendLoginEmail(identifier, code);
    } else {
      // await sendLoginSms(identifier, code);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("Error in /api/request-code:", err);
    return res.status(500).json({ error: "send_failed" });
  }
});


// ===============================================
// POST /api/verify-code
// Receives: { identifier, code }
// Returns: { token }
// ===============================================
app.post("/api/verify-code", express.json(), (req, res) => {

  // Rate limit protection
  const ip = req.ip || req.connection.remoteAddress || "unknown";
  const rl = rateLimit({
    key: `verify-code:${ip}`,
    limit: 10,
    windowMs: 10 * 60 * 1000 // 10 minutes
  });
  if (!rl.allowed) {
    return res.status(429).json({ error: "too_many_requests" });
  }


  let { identifier, code } = req.body;
  if (!identifier || !code)
    return res.status(400).json({ error: "missing fields" });

  if (!isValidEmailServer(identifier) && !isValidPhoneServer(identifier)) {
    return res.status(400).json({ error: "invalid_identifier" });
  }
  
  if (!identifier || !code)
    return res.status(400).json({ error: "missing fields" });

  if (loginCodes[identifier] !== code)
    return res.status(400).json({ error: "invalid code" });

  delete loginCodes[identifier];

  

  

  // ================= DB USER RESOLUTION =================

  // 1) Find user by identifier
  let row = db
    .prepare("SELECT id FROM users WHERE identifier = ?")
    .get(identifier);

  // 2) If user does not exist, create it
  if (!row) {
    const info = db
      .prepare("INSERT INTO users (identifier) VALUES (?)")
      .run(identifier);

    row = { id: info.lastInsertRowid };
  }

  // 3) Generate persistent token and store in DB
  const token = crypto.randomBytes(24).toString("hex");

  const expiresAt = (() => {
    const d = new Date();
    d.setDate(d.getDate() + AUTH_TOKEN_DAYS);
    return d.toISOString();
  })();

  db.prepare(`
    INSERT INTO auth_tokens (token, user_id, expires_at)
    VALUES (?, ?, ?)
  `).run(token, row.id, expiresAt);



  // Set a cookie so <img src="/media/..."> is authenticated
  res.setHeader(
    "Set-Cookie",
    `pishnama_token=${encodeURIComponent(token)}; Path=/; SameSite=Lax; HttpOnly`
  );
  // 4) Return token to frontend
  return res.json({ token });



});


// ===============================================
// Attach userId to req if token is valid
// Supports:
//   - Header: x-user-token (current frontend fetchWithAuth)
//   - Cookie: pishnama_token (for <img src> and normal browser navigation)
//   - Query:  ?t=...         (fallback if cookie missing)
// ===============================================
function readCookie(req, name) {
  const raw = req.headers.cookie || "";
  const parts = raw.split(";").map(s => s.trim());
  for (const p of parts) {
    if (p.startsWith(name + "=")) return decodeURIComponent(p.slice(name.length + 1));
  }
  return null;
}

// ====================== RATE LIMITING (Stage 4.3) ===========================
// Simple in-memory token buckets (single-instance safe)

const rateBuckets = new Map(); 
// key -> { count, resetAt }

function rateLimit({ key, limit, windowMs }) {
  const now = Date.now();
  let bucket = rateBuckets.get(key);

  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    rateBuckets.set(key, bucket);
  }

  bucket.count += 1;

  return {
    allowed: bucket.count <= limit,
    remaining: Math.max(0, limit - bucket.count),
    resetAt: bucket.resetAt
  };
}


 
app.use((req, res, next) => {
  const headerToken = req.headers["x-user-token"];
  const cookieToken = readCookie(req, "pishnama_token");
  const queryToken = req.query?.t;

  const token = headerToken || cookieToken || queryToken;
  if (!token) return next();

  const row = db.prepare(`
    SELECT user_id
    FROM auth_tokens
    WHERE token = ?
      AND expires_at > datetime('now')
  `).get(token);

  if (row) {
    req.userId = row.user_id;
    req.userToken = token;
  }

  next();
});

app.post("/api/logout", (req, res) => {
  if (!req.userToken) {
    return res.status(200).json({ ok: true });
  }

  db.prepare(`DELETE FROM auth_tokens WHERE token = ?`)
    .run(req.userToken);

  res.setHeader(
    "Set-Cookie",
    "pishnama_token=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly"
  );

  return res.json({ ok: true });
});



// ===============================================
// GET /media/:imageId
// Authenticated media access:
// - Verifies ownership (or global scope)
// - Redirects to short-lived presigned URL
// ===============================================
app.get("/media/:imageId", async (req, res) => {
  if (!req.userId) {
    return res.status(401).json({ error: "login_required" });
  }

  // Rate limit protection
  const rl = rateLimit({
    key: `media:${req.userId}`,
    limit: 120,
    windowMs: 60 * 1000 // 1 minute
  });
  if (!rl.allowed) {
    return res.status(429).json({ error: "rate_limited" });
  }



  const imageId = Number(req.params.imageId);
  if (!imageId) return res.status(400).json({ error: "invalid_image_id" });

  const img = db.prepare(`
    SELECT id, scope, owner_user_id, storage_key
    FROM images
    WHERE id = ?
  `).get(imageId);

  
  if (!img) {
    // Do not leak whether an image ever existed
    return res.status(404).json({ error: "not_found" });
  }


  // Access rule:
  // - scope='user' => only owner can access
  // - scope='global' => any logged-in user can access (future shared catalogs)
  if (img.scope === "user" && img.owner_user_id !== req.userId) {
    // Do NOT leak existence
    return res.status(404).json({ error: "not_found" });
  }

  try {
    const url = await presignGetUrl(img.storage_key, 60);

    // Prevent caching of redirects to signed URLs
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");

    return res.redirect(302, url);

  } catch (e) {
    // Do not leak storage or presign failures
    return res.status(404).json({ error: "not_found" });
  }

});



// ====================== IMAGE NORMALIZATION / COMPRESSION ===================

const MAX_BASE_BYTES_SERVER   = 4 * 1024 * 1024; // 4 MB server threshold for base
const MAX_FABRIC_BYTES_SERVER = 4 * 1024 * 1024; // 4 MB server threshold for fabrics
const BASE_MAX_SIDE_SERVER    = 1536;
const FABRIC_MAX_SIDE_SERVER  = 1024;

async function generateThumbnail(buffer, mimeType) {
  const img = sharp(buffer);

  const thumb = await img
    .resize({
      width: 320,
      height: 320,
      fit: "inside",
      withoutEnlargement: true
    })
    .jpeg({ quality: 75 })
    .toBuffer();

  return {
    buffer: thumb,
    mime_type: "image/jpeg"
  };
}


function ensureJpegExtensionServer(name) {
  if (!name) return "image.jpg";
  return name.replace(/\.[^.]+$/,"") + ".jpg";
}

function isSafeOriginalJpeg(file, kind) {
  const limit = kind === "base" ? MAX_BASE_BYTES_SERVER : MAX_FABRIC_BYTES_SERVER;
  return file.mimetype === "image/jpeg" && file.size <= limit;
}

/**
 * Normalize an uploaded image:
 *  - If already a small-enough JPEG → keep as-is
 *  - Otherwise → resize to maxSide (inside) and encode as JPEG with quality
 */
async function processUploadedImage(file, kind) {
  const maxSide    = kind === "base" ? BASE_MAX_SIDE_SERVER    : FABRIC_MAX_SIDE_SERVER;
  const limitBytes = kind === "base" ? MAX_BASE_BYTES_SERVER   : MAX_FABRIC_BYTES_SERVER;
  const baseQuality = kind === "base" ? 80 : 85;

  // No need for conversion when it's already a small JPEG
  if (isSafeOriginalJpeg(file, kind)) {
    return file;
  }

  const img = sharp(file.buffer, { failOnError: false });
  const meta = await img.metadata();
  const width  = meta.width  || maxSide;
  const height = meta.height || maxSide;

  let pipeline = img;
  if (Math.max(width, height) > maxSide) {
    pipeline = pipeline.resize({ width: maxSide, height: maxSide, fit: "inside" });
  }

  let q = baseQuality;
  let output = await pipeline.jpeg({ quality: q }).toBuffer();

  // If still big, lower quality in steps
  while (output.length > limitBytes && q > 60) {
    q -= 10;
    output = await img.jpeg({ quality: q }).toBuffer();
  }

  return {
    ...file,
    buffer: output,
    mimetype: "image/jpeg",
    originalname: ensureJpegExtensionServer(file.originalname)
  };
}


// ===============================================
// GET /api/credits
// Returns current credit balance + expiry
// ===============================================
app.get("/api/credits", (req, res) => {
  if (!req.userId) {
    return res.status(401).json({ error: "login_required" });
  }

  const creditInfo = getUserCredits(req.userId);

  return res.json({
    credits: creditInfo.credits,
    credits_expires_at: creditInfo.credits_expires_at
  });
});


// ===============================================
// GET /api/history
// Query params:
//   page (1-based, default = 1)
//   pageSize (optional)
//
// IMPORTANT (Stage 1 history simplification):
//   - We HARD-LIMIT the returned history to the latest 20 creations.
//   - Older creations remain in DB + storage, but are not returned by this API.
//   - This keeps bandwidth low and makes the UI predictable.
// ===============================================
app.get("/api/history", (req, res) => {
  if (!req.userId) {
    return res.status(401).json({ error: "login_required" });
  }

  const HARD_LIMIT = 20;

  const page = Math.max(1, parseInt(req.query.page || "1", 10));
  const pageSizeRaw = parseInt(req.query.pageSize || HISTORY_PAGE_SIZE_DEFAULT, 10);

  // Even if a client requests a larger page size, never exceed the hard limit.
  const pageSize = Math.min(
    Math.max(1, pageSizeRaw),
    Math.min(HISTORY_PAGE_SIZE_MAX, HARD_LIMIT)
  );

  const offset = (page - 1) * pageSize;

  // Prevent paging beyond HARD_LIMIT (we don't expose older items).
  if (offset >= HARD_LIMIT) {
    return res.json({
      page,
      pageSize,
      total: 0,
      items: []
    });
  }

  // Total count (clamped) so UI won't show "Load more" beyond the hard limit.
  const totalRow = db.prepare(`
    SELECT COUNT(*) AS cnt
    FROM creations
    WHERE user_id = ?
  `).get(req.userId);

  const totalClamped = Math.min(totalRow.cnt, HARD_LIMIT);

  // Fetch page of creations (only within the hard limit)
  const rows = db.prepare(`
    SELECT
      id,
      mode,
      mode_selection,
      quality,
      cost_credits,
      created_at,
      output_image_id,
      output_thumb_image_id
    FROM creations
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(req.userId, pageSize, offset);

  return res.json({
    page,
    pageSize,
    total: totalClamped,
    items: rows.map(r => ({
      id: r.id,
      mode: r.mode,
      mode_selection: r.mode_selection,
      quality: r.quality,
      cost_credits: r.cost_credits,
      created_at: r.created_at,
      // IMPORTANT: history grid should use thumbnails to avoid downloading full images.
      output_thumb_url: r.output_thumb_image_id ? `/media/${r.output_thumb_image_id}` : null,
      // Full image for click-to-open.
      output_image_url: `/media/${r.output_image_id}`,
      // Backward-compatible alias for full image.
      output_full_image_url: `/media/${r.output_image_id}`

    }))
  });
});



// ===============================================
// GET /api/base-images
// Returns distinct base images with thumb/full URLs
// NOTE:
//   - For tagged pillows, base_image_id is the ANNOTATED base (markers)
//     and base_image_raw_id is the ORIGINAL base.
//   - The base album should show ORIGINAL base when available.
// ===============================================
app.get("/api/base-images", (req, res) => {
  if (!req.userId) {
    return res.status(401).json({ error: "login_required" });
  }

  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSizeRaw = Number(req.query.pageSize) || BASE_IMAGES_PAGE_SIZE_DEFAULT;
  const pageSize = Math.min(Math.max(1, pageSizeRaw), BASE_IMAGES_PAGE_SIZE_MAX);
  const offset = (page - 1) * pageSize;

  // We want to show ORIGINAL base when available (base_image_raw_id),
  // otherwise fall back to base_image_id.
  const totalRow = db.prepare(`
    SELECT COUNT(DISTINCT COALESCE(base_image_raw_id, base_image_id)) AS cnt
    FROM creations
    WHERE user_id = ?
      AND (base_image_id IS NOT NULL OR base_image_raw_id IS NOT NULL)
  `).get(req.userId);

  const rows = db.prepare(`
    SELECT
      chosen.image_id AS image_id,
      chosen.thumb_image_id AS thumb_image_id,
      chosen.created_at AS created_at
    FROM (
      SELECT
        COALESCE(base_image_raw_id, base_image_id) AS image_id,
        COALESCE(base_raw_thumb_image_id, base_thumb_image_id) AS thumb_image_id,
        created_at,
        id
      FROM creations
      WHERE user_id = ?
        AND (base_image_id IS NOT NULL OR base_image_raw_id IS NOT NULL)
    ) chosen
    JOIN (
      SELECT
        COALESCE(base_image_raw_id, base_image_id) AS image_id,
        MAX(created_at) AS max_created_at,
        MAX(id) AS max_id
      FROM creations
      WHERE user_id = ?
        AND (base_image_id IS NOT NULL OR base_image_raw_id IS NOT NULL)
      GROUP BY COALESCE(base_image_raw_id, base_image_id)
    ) latest
      ON latest.image_id = chosen.image_id
     AND (chosen.created_at = latest.max_created_at OR chosen.id = latest.max_id)
    GROUP BY chosen.image_id
    ORDER BY chosen.created_at DESC
    LIMIT ? OFFSET ?
  `).all(req.userId, req.userId, pageSize, offset);

  return res.json({
    page,
    pageSize,
    total: totalRow.cnt,
    items: rows.map(r => ({
      image_id: r.image_id,
      created_at: r.created_at,
      thumb_url: r.thumb_image_id ? `/media/${r.thumb_image_id}` : null,
      full_url: `/media/${r.image_id}`
    }))
  });
});





// ===============================================
// GET /api/fabrics
// Returns fabrics with thumb/full URLs
// ===============================================
app.get("/api/fabrics", (req, res) => {
  if (!req.userId) {
    return res.status(401).json({ error: "login_required" });
  }

  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSizeRaw = Number(req.query.pageSize) || FABRICS_PAGE_SIZE_DEFAULT;
  const pageSize = Math.min(Math.max(1, pageSizeRaw), FABRICS_PAGE_SIZE_MAX);
  const offset = (page - 1) * pageSize;

  const totalRow = db.prepare(`
    SELECT COUNT(*) AS cnt
    FROM fabrics
    WHERE user_id = ?
  `).get(req.userId);

  const rows = db.prepare(`
    SELECT
      id,
      image_id,
      thumb_image_id,
      created_at
    FROM fabrics
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(req.userId, pageSize, offset);

  return res.json({
    page,
    pageSize,
    total: totalRow.cnt,
    items: rows.map(r => ({
      id: r.id,
      image_id: r.image_id,
      created_at: r.created_at,
      thumb_url: r.thumb_image_id ? `/media/${r.thumb_image_id}` : null,
      full_url: `/media/${r.image_id}`
    }))
  });
});



// ===============================================
// GET /api/creation/:id
// Full creation details (with fabrics)
// ===============================================
app.get("/api/creation/:id", (req, res) => {
  if (!req.userId) {
    return res.status(401).json({ error: "login_required" });
  }

  const creationId = Number(req.params.id);
  if (!creationId) {
    return res.status(400).json({ error: "invalid_creation_id" });
  }

  // ---- fetch creation ----
  const creation = db.prepare(`
    SELECT
      id,
      mode,
      mode_selection,
      quality,
      cost_credits,
      created_at,
      meta_json,
      base_image_id,
      base_image_raw_id,
      output_image_id,
      base_thumb_image_id,
      base_raw_thumb_image_id,
      output_thumb_image_id
    FROM creations
    WHERE id = ? AND user_id = ?
  `).get(creationId, req.userId);

  if (!creation) {
    return res.status(404).json({ error: "not_found" });
  }

  // ---- fetch fabrics linked to this creation ----
  const fabricRows = db.prepare(`
    SELECT
      f.id AS fabric_id,
      f.image_id AS image_id,
      f.thumb_image_id AS thumb_image_id,
      cf.ord AS ord,
      cf.part AS part
    FROM creation_fabrics cf
    JOIN fabrics f ON f.id = cf.fabric_id
    WHERE cf.creation_id = ?
    ORDER BY cf.ord ASC, cf.id ASC
  `).all(creationId);





  // Rebuild frontend-compatible fabric objects from ord + part
  const grouped = new Map(); // key = `${ord}:${fabric_id}`

  for (const r of fabricRows) {
    const key = `${r.ord}:${r.fabric_id}`;

    if (!grouped.has(key)) {      
      grouped.set(key, {
        id: r.fabric_id,
        image_id: r.image_id,
        thumb_image_id: r.thumb_image_id,
        role: `fabric_${String(r.ord).padStart(2, "0")}`,
        meta: { parts: [] }
      });

    }

    if (r.part) {
      grouped.get(key).meta.parts.push(r.part);
    }
  }

  
  const fabrics = Array.from(grouped.values()).map(f => ({
    ...f,
    image_url: `/media/${f.image_id}`,
    full_url: `/media/${f.image_id}`,
    thumb_url: f.thumb_image_id ? `/media/${f.thumb_image_id}` : null
  }));




  // ---- response ----  
    return res.json({
    id: creation.id,
    mode: creation.mode,
    mode_selection: creation.mode_selection,
    quality: creation.quality,
    cost_credits: creation.cost_credits,
    created_at: creation.created_at,
    meta: JSON.parse(creation.meta_json || "{}"),

    // =========================
    // Base (annotated for tagged pillows)
    // =========================
    base_image_id: creation.base_image_id,
    base_image_url: creation.base_image_id ? `/media/${creation.base_image_id}` : null,
    base_full_image_url: creation.base_image_id ? `/media/${creation.base_image_id}` : null,
    base_thumb_image_url: creation.base_image_id
      ? `/media/${creation.base_thumb_image_id || creation.base_image_id}`
      : null,

    // =========================
    // Base RAW (original, only for tagged pillows restore)
    // =========================
    base_image_raw_id: creation.base_image_raw_id,
    base_image_raw_url: creation.base_image_raw_id ? `/media/${creation.base_image_raw_id}` : null,
    base_raw_full_image_url: creation.base_image_raw_id ? `/media/${creation.base_image_raw_id}` : null,
    base_raw_thumb_image_url: creation.base_image_raw_id
      ? `/media/${creation.base_raw_thumb_image_id || creation.base_image_raw_id}`
      : null,

    // =========================
    // Output
    // =========================
    output_image_id: creation.output_image_id,
    output_image_url: creation.output_image_id ? `/media/${creation.output_image_id}` : null, // backward-compatible
    output_full_image_url: creation.output_image_id ? `/media/${creation.output_image_id}` : null,
    output_thumb_image_url: creation.output_image_id
      ? `/media/${creation.output_thumb_image_id || creation.output_image_id}`
      : null,

    fabrics
  });







});



// ===============================================
// POST /api/buy-credits
// Body: { package_credits: number, confirm?: true }
// ===============================================
app.post("/api/buy-credits", express.json(), (req, res) => {
  if (!req.userId) {
    return res.status(401).json({ error: "login_required" });
  }

  const { package_credits, confirm } = req.body;

  if (!Number.isInteger(package_credits) || package_credits <= 0) {
    return res.status(400).json({ error: "invalid_package_credits" });
  }

  // Get current credit state (with auto-expiry)
  const current = getUserCredits(req.userId);

  const currentCredits = current?.credits || 0;

  const preserved = Math.min(currentCredits, CREDIT_KEEP_THRESHOLD);
  const burned = Math.max(0, currentCredits - CREDIT_KEEP_THRESHOLD);

  const newTotal = preserved + package_credits;
  const newExpiresAt = addDaysToNow(CREDIT_PACKAGE_DAYS);

  // If burning occurs and user has not confirmed yet, warn first
  if (burned > 0 && confirm !== true) {
    return res.json({
      ok: false,
      requires_confirmation: true,
      preserved,
      burned,
      new_total: newTotal,
      new_expires_at: newExpiresAt
    });
  }

  // Apply purchase
  db.prepare(
    `UPDATE users
     SET credits = ?,
         credits_expires_at = ?
     WHERE id = ?`
  ).run(newTotal, newExpiresAt, req.userId);

  return res.json({
    ok: true,
    credits: newTotal,
    credits_expires_at: newExpiresAt
  });
});



// ============================================================================
// POST /api/generate
// Main route that receives meta, base_image, fabric files.
// ============================================================================
app.post("/api/generate", upload.any(), async (req, res) => {

  // Track credit reservation so we can safely refund on any failure path
  let creditsReserved = false;
  let reservedCost = 0;

  try {


    // -----------------------------------------------------------------------
    // Parse metadata sent by the frontend
    // meta fields include:
    //   meta.mode: "sofa" or "pillows"
    //   meta.mode_selection:
    //        sofa:    "all" or "partial"
    //        pillows: "single" or "random"
    //   meta.quality: fixed model quality (a fixed amount for now that we use only one model with one quality-might change in the future)
    // -----------------------------------------------------------------------
    const meta = JSON.parse(req.body.meta);
    // Force fixed quality (frontend no longer exposes quality selection)
    meta.quality = FIXED_MODEL_QUALITY;    
    const files = req.files;

    // Per-request trace id for correlating persistence logs
    const trace = crypto.randomBytes(8).toString("hex");
    const reqT0 = Date.now();

    logP(trace, "generate_received", {
      userId: req.userId || null,
      mode: meta?.mode || null,
      mode_selection: meta?.mode_selection || null,
      quality: meta?.quality || null,
      fileCount: Array.isArray(files) ? files.length : 0,
      files: Array.isArray(files)
        ? files.map(f => ({
            fieldname: f.fieldname,
            name: f.originalname,
            bytes: f.size,
            mime: f.mimetype
          }))
        : []
    });

    
    // ====================== HARD GUARDRAILS (Stage 4.4) ======================
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: "no_files" });
    }

    if (files.length > MAX_UPLOAD_FILES_HARD) {
      return res.status(400).json({ error: "too_many_files" });
    }

    // Total bytes guard (multer fileSize limits each file; this caps sum)
    const totalBytes = files.reduce((sum, f) => sum + (f?.size || 0), 0);
    if (totalBytes > MAX_TOTAL_UPLOAD_BYTES_HARD) {
      return res.status(400).json({ error: "payload_too_large" });
    }

    // Enforce fieldnames: only allow base_image, base_image_raw, and fabrics
    // (We treat any other non-base field as "fabric", but we reject obviously wrong payloads.)
    const allowedBaseFields = new Set(["base_image", "base_image_raw"]);

    const fabricFiles = files.filter(f => !allowedBaseFields.has(f.fieldname));
    if (fabricFiles.length > MAX_FABRICS_HARD) {
      return res.status(400).json({ error: "too_many_fabrics" });
    }

    // Enforce minimum fabrics by mode (cost-safe + predictable)
    if (meta?.mode === "pillows" && meta?.mode_selection === "single" && fabricFiles.length !== 1) {
      return res.status(400).json({ error: "invalid_fabric_count" });
    }
    if (meta?.mode === "pillows" && meta?.mode_selection === "tagged" && (fabricFiles.length < 1 || fabricFiles.length > MAX_FABRICS_HARD)) {
      return res.status(400).json({ error: "invalid_fabric_count" });
    }
    // Sofa modes: allow 1..3 fabrics (partial can be 1; all can be 1..3 depending on UI)
    if (meta?.mode === "sofa" && (fabricFiles.length < 1 || fabricFiles.length > MAX_FABRICS_HARD)) {
      return res.status(400).json({ error: "invalid_fabric_count" });
    }

    // Tagged pillows MUST include the original base image as base_image_raw,
    // so we can persist it and correctly restore/reuse later.
    if (meta?.mode === "pillows" && meta?.mode_selection === "tagged") {
      const hasBaseRaw = Array.isArray(files) && files.some(f => f.fieldname === "base_image_raw");
      if (!hasBaseRaw) {
        return res.status(400).json({ error: "base_image_raw_required" });
      }
    }



    // Normalize / compress uploads (server safety net)
    const processedFiles = [];
    for (const f of files) {
      const kind = (f.fieldname === "base_image" || f.fieldname === "base_image_raw") ? "base" : "fabric";
      const processed = await processUploadedImage(f, kind);
      processedFiles.push(processed);
    }
    logP(trace, "uploads_processed", {
      ms: msSince(reqT0),
      processed: processedFiles.map(f => ({
        fieldname: f.fieldname,
        name: f.originalname,
        bytes: f.buffer?.length,
        mime: f.mimetype || null

      }))
    });



    // console.log("Generation requested by user:", req.userId || "unauthenticated");
    // const creditInfo = getUserCredits(req.userId);
    // console.log("User credits state:", creditInfo);


    if (!req.userId) {
      return res.status(401).json({ error: "login_required" });
    }

    // Rate limit protection
    const rl = rateLimit({
      key: `generate:${req.userId}`,
      limit: 5,
      windowMs: 60 * 60 * 1000 // 1 hour
    });
    if (!rl.allowed) {
      return res.status(429).json({ error: "rate_limited" });
    }


    // ====================== CREDIT RESERVATION (ATOMIC) ===========================
    // Reserve (deduct) credits up-front to prevent race conditions.
    // If anything fails later, we will refund.

    const cost = getGenerationCost(meta);

    const reserved = reserveCredits(req.userId, cost);
    if (!reserved) {
      const creditInfo = getUserCredits(req.userId);
      return res.status(402).json({
        error: "insufficient_credits",
        credits: creditInfo ? creditInfo.credits : 0,
        needed: cost
      });
    }

    creditsReserved = true;
    reservedCost = cost;

    logP(trace, "credits_reserved", { cost, ms: msSince(reqT0) });




    // Logging the received files
    // console.log("FILES RECEIVED BY BACKEND:", files);

    // -----------------------------------------------------------------------
    // PROMPT SELECTION (4 possible branches)
    // -----------------------------------------------------------------------
    let prompt;

    if (meta.mode === "sofa" && meta.mode_selection === "all") {
      prompt = prompt1;
    }
    else if (meta.mode === "sofa" && meta.mode_selection === "partial") {
      prompt = buildPrompt2(meta);
    }
    else if (meta.mode === "pillows" && meta.mode_selection === "single") {
      prompt = prompt3;
    }
    else if (meta.mode === "pillows" && meta.mode_selection === "tagged") {
      prompt = buildPrompt4(meta);
    }
    else {
      // fallback for unexpected values
      prompt = prompt1;
    }

    ///////////
    // -----------------------------------------------------------------------
    // AI CALL (ABSTRACTED): OpenAI or Gemini via aiAdapter.js
    // Controlled by env: AI_IMAGE_PROVIDER=openai|gemini
    // -----------------------------------------------------------------------
    let imageBuffer;
    let outputMimeType = "image/png";

    try {
      const out = await generateImage({
        meta,
        prompt,
        processedFiles
      });

      imageBuffer = out.buffer;
      outputMimeType = out.mimeType || "image/png";

    } catch (e) {
      // Refund reserved credits because generation failed
      if (creditsReserved) {
        try { refundCredits(req.userId, reservedCost); } catch (x) {}
        creditsReserved = false;
      }

      return res.status(500).json({
        error: "AI request failed",
        details: String(e?.message || e)
      });
    }
    ///////////



    // Upload output image ONCE (reused across retries)
    let outputImageInsert = null;

    async function ensureOutputImageUploadedOnce() {
      if (outputImageInsert) return outputImageInsert;


      outputImageInsert = await insertImageNoDedup({
        userId: req.userId,
        buffer: imageBuffer,
        mimeType: outputMimeType,
        scope: "user",
        trace,
        role: "output_full"
      });
      

      return outputImageInsert;
    }



    logP(trace, "generation_ok_fast_response", {
      outputBytes: imageBuffer.length,
      ms: msSince(reqT0)
    });
    // ====================== FAST RESPONSE TO USER ======================
    // Respond immediately with the generated image
    let persistenceFailed = false;
    res.json({
      image_base64: imageBuffer.toString("base64"),
      persistence_pending: true
    });

    

    //
    async function runPersistenceOnce() {
      const persistT0 = Date.now();
      let persistStage = "start";

      logP(trace, "persist_attempt_start", {
        activeJobs: ACTIVE_PERSIST_JOBS,
        msSinceRequest: msSince(reqT0)
      });

      try {
        // Hard cap output size (cost + storage guardrail)
        const MAX_OUTPUT_BYTES_HARD = 12 * 1024 * 1024; // 12 MB
        if (imageBuffer.length > MAX_OUTPUT_BYTES_HARD) {
          throw new Error("output_too_large");
        }

        const baseAnnotatedFile = processedFiles.find(f => f.fieldname === "base_image");
        const baseRawFile = processedFiles.find(f => f.fieldname === "base_image_raw");

        let baseImageId = null;
        let baseImageRawId = null;

        // ====================== STORE BASE IMAGES (ANNOTATED + RAW) =================
        // Annotated (generation input)
        if (baseAnnotatedFile) {
          persistStage = "base_annotated";

          const upsert = await upsertImageForUser({
            userId: req.userId,
            buffer: baseAnnotatedFile.buffer,
            mimeType: baseAnnotatedFile.mimetype || "image/jpeg",
            scope: "user",
            trace,
            role: "base_annotated"
          });

          baseImageId = upsert.imageId;
        }

        // Raw original (optional)
        if (baseRawFile) {
          persistStage = "base_raw";

          const upsertRaw = await upsertImageForUser({
            userId: req.userId,
            buffer: baseRawFile.buffer,
            mimeType: baseRawFile.mimetype || "image/jpeg",
            scope: "user",
            trace,
            role: "base_raw"
          });

          baseImageRawId = upsertRaw.imageId;
        }

        // Must have base annotated to create a creation
        if (!baseAnnotatedFile || !baseImageId) {
          throw new Error("missing_base_image");
        }

        // Precompute fabric rows (async work already done above for images; this is just mapping)
        const fabricPlans = []; // [{ ord, imageId, parts, buffer, mimeType }] where parts is array or string (pillows)
        let fabricIndex = 1;

        for (const f of processedFiles) {
          if (f.fieldname === "base_image" || f.fieldname === "base_image_raw") continue;

          persistStage = `fabric_${String(fabricIndex).padStart(2, "0")}`;

          // Store fabric in cloud (dedup) — OUTSIDE the DB transaction (async)
          const fabricUpsert = await upsertImageForUser({
            userId: req.userId,
            buffer: f.buffer,
            mimeType: f.mimetype || "image/jpeg",
            scope: "user",
            trace,
            role: `fabric_${String(fabricIndex).padStart(2, "0")}`
          });

          const ord = fabricIndex;

          if (meta.mode === "sofa") {
            const fabricKey = `fabric_${String(ord).padStart(2, "0")}`;
            const mf = meta.fabrics.find(x => x.id === fabricKey);
            const parts = Array.isArray(mf?.parts) ? mf.parts : [];

            fabricPlans.push({
              ord,
              imageId: fabricUpsert.imageId,
              parts,
              buffer: f.buffer,
              mimeType: f.mimetype || "image/jpeg"
            });
          } else {
            // pillows mode: store mode_selection in `part`
            fabricPlans.push({
              ord,
              imageId: fabricUpsert.imageId,
              parts: meta.mode_selection || "pillows",
              buffer: f.buffer,
              mimeType: f.mimetype || "image/jpeg"
            });
          }

          fabricIndex++;
        }

        // Prepare statements once
        const insertCreation = db.prepare(`
          INSERT INTO creations (
            user_id,
            mode,
            mode_selection,
            quality,
            base_image_id,
            base_image_raw_id,
            output_image_id,
            meta_json,
            cost_credits
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const insertFabric = db.prepare(`
          INSERT INTO fabrics (
            user_id,
            image_id,
            created_at
          )
          VALUES (?, ?, CURRENT_TIMESTAMP)
        `);

        const insertCreationFabric = db.prepare(`
          INSERT INTO creation_fabrics (
            creation_id,
            fabric_id,
            ord,
            part
          )
          VALUES (?, ?, ?, ?)
        `);

        // Ensure output image uploaded (reused across retries)
        persistStage = "output_full";
        const outputInsert = await ensureOutputImageUploadedOnce();

        logP(trace, "persist_db_phase_start", { ms: msSince(persistT0) });

        const outputImageId = outputInsert.imageId;
        const fabricRows = [];

        // ====================== DB TRANSACTION ======================
        persistStage = "db_transaction";

        const creationId = db.transaction(() => {
          const result = insertCreation.run(
            req.userId,
            meta.mode,
            meta.mode_selection,
            meta.quality,
            baseImageId,
            baseImageRawId || null,
            outputImageId,
            JSON.stringify(meta),
            cost
          );

          const newCreationId = result.lastInsertRowid;

          for (const plan of fabricPlans) {
            if (!plan.imageId) {
              throw new Error("fabric_image_missing");
            }

            
            // Reuse existing fabric row for this user+image_id (prevents album duplicates)
            let existing = db.prepare(`
              SELECT id
              FROM fabrics
              WHERE user_id = ? AND image_id = ?
              ORDER BY created_at DESC
              LIMIT 1
            `).get(req.userId, plan.imageId);

            let fabricId;
            if (existing?.id) {
              fabricId = existing.id;
            } else {
              const fabricResult = insertFabric.run(req.userId, plan.imageId);
              fabricId = fabricResult.lastInsertRowid;
            }





            fabricRows.push({
              fabricId,
              imageId: plan.imageId,
              buffer: plan.buffer,
              mimeType: plan.mimeType
            });

            if (meta.mode === "sofa") {
              const parts = Array.isArray(plan.parts) ? plan.parts : [];

              if (parts.length === 0) {
                insertCreationFabric.run(newCreationId, fabricId, plan.ord, null);
              } else {
                for (const part of parts) {
                  insertCreationFabric.run(newCreationId, fabricId, plan.ord, part);
                }
              }
            } else {
              // pillows: plan.parts is a string
              insertCreationFabric.run(newCreationId, fabricId, plan.ord, String(plan.parts || "pillows"));
            }
          }

          return newCreationId;
        })();

        // ======================
        // THUMBNAIL GENERATION (non-fatal)
        // ======================
        persistStage = "thumbnails";

        try {
          let baseThumbId = null;
          let baseRawThumbId = null;
          let outputThumbId = null;

          // Base (annotated) thumbnail
          if (baseAnnotatedFile?.buffer) {
            const t = await generateThumbnail(baseAnnotatedFile.buffer, baseAnnotatedFile.mimetype || "image/jpeg");

            const up = await upsertImageForUser({
              userId: req.userId,
              buffer: t.buffer,
              mimeType: t.mime_type,
              scope: "user",
              trace,
              role: "thumb_base_annotated"
            });

            baseThumbId = up.imageId;
          }

          // Base RAW thumbnail (tagged pillows)
          if (baseRawFile?.buffer) {
            const t = await generateThumbnail(baseRawFile.buffer, baseRawFile.mimetype || "image/jpeg");

            const up = await upsertImageForUser({
              userId: req.userId,
              buffer: t.buffer,
              mimeType: t.mime_type,
              scope: "user",
              trace,
              role: "thumb_base_raw"
            });

            baseRawThumbId = up.imageId;
          }

          // Output thumbnail (generated image)
          if (imageBuffer) {

            const t = await generateThumbnail(imageBuffer, outputMimeType);

            const up = await upsertImageForUser({
              userId: req.userId,
              buffer: t.buffer,
              mimeType: t.mime_type,
              scope: "user",
              trace,
              role: "thumb_output"
            });

            outputThumbId = up.imageId;
          }

          const fabricThumbCache = new Map();

          for (const row of fabricRows) {
            if (!row?.imageId) continue;

            let thumbId = fabricThumbCache.get(row.imageId);

            if (!thumbId) {
              const existingThumb = db.prepare(`
                SELECT thumb_image_id
                FROM fabrics
                WHERE image_id = ?
                  AND thumb_image_id IS NOT NULL
                ORDER BY created_at DESC
                LIMIT 1
              `).get(row.imageId);

              if (existingThumb?.thumb_image_id) {
                thumbId = existingThumb.thumb_image_id;
              } else if (row.buffer) {
                const t = await generateThumbnail(row.buffer, row.mimeType || "image/jpeg");

                const up = await upsertImageForUser({
                  userId: req.userId,
                  buffer: t.buffer,
                  mimeType: t.mime_type,
                  scope: "user",
                  trace,
                  role: `thumb_fabric_image_${row.imageId}`
                });

                thumbId = up.imageId;
              }

              if (thumbId) {
                fabricThumbCache.set(row.imageId, thumbId);
              }
            }

            if (thumbId) {
              db.prepare(`
                UPDATE fabrics
                SET thumb_image_id = ?
                WHERE id = ? AND user_id = ?
              `).run(thumbId, row.fabricId, req.userId);
            }
          }

          db.prepare(`
            UPDATE creations
            SET
              base_thumb_image_id = ?,
              base_raw_thumb_image_id = ?,
              output_thumb_image_id = ?
            WHERE id = ? AND user_id = ?
          `).run(
            baseThumbId,
            baseRawThumbId,
            outputThumbId,
            creationId,
            req.userId
          );

        } catch (thumbErr) {
          console.warn("Thumbnail generation failed (non-fatal):", thumbErr?.message || thumbErr);
        }

        logP(trace, "persist_attempt_ok", { ms: msSince(persistT0) });

      } catch (e) {
        // This is the missing piece: stage-aware “throw” log, so you can see
        // exactly whether it died at base/fabric/output/db/thumbs.
        logP(trace, "persist_attempt_throw", {
          stage: persistStage,
          ms: msSince(persistT0),
          err: String(e?.message || e)
        });
        throw e;
      }
    }

    //
    
    
    setImmediate(async () => {
      ACTIVE_PERSIST_JOBS += 1;
      logP(trace, "persist_job_start", { activeJobs: ACTIVE_PERSIST_JOBS });

      let jobOk = false;
      let jobRetryOk = false;

      try {
        await runPersistenceOnce();
        jobOk = true;
        logP(trace, "persist_job_done", { activeJobs: ACTIVE_PERSIST_JOBS, ok: true });

      } catch (err1) {
        console.warn("Persistence attempt 1 failed, retrying once:", err1.message);

        logP(trace, "persist_attempt1_failed", {
          err: String(err1?.message || err1),
          activeJobs: ACTIVE_PERSIST_JOBS
        });

        try {
          await runPersistenceOnce();
          jobOk = true;
          jobRetryOk = true;
          logP(trace, "persist_job_done", { activeJobs: ACTIVE_PERSIST_JOBS, ok: true, retry: true });

        } catch (err2) {
          persistenceFailed = true;
          console.error("Persistence failed after retry:", err2);

          logP(trace, "persist_failed_after_retry", {
            err: String(err2?.message || err2),
            activeJobs: ACTIVE_PERSIST_JOBS
          });

          // Refund reserved credits because persistence ultimately failed
          if (creditsReserved) {
            try { refundCredits(req.userId, reservedCost); } catch (e) {}
            creditsReserved = false;

            logP(trace, "credits_refunded_after_persist_fail", {
              refunded: reservedCost,
              msSinceRequest: msSince(reqT0)
            });
          }
        }
      } finally {
        ACTIVE_PERSIST_JOBS -= 1;
        logP(trace, "persist_job_end", { activeJobs: ACTIVE_PERSIST_JOBS });

        // Option A behavior:
        // - Success => discard buffered logs (no console noise)
        // - Failure => flush buffered logs to console once
        if (jobOk) {
          discardTraceLogs(trace);
        } else {
          flushTraceLogs(trace, "persist_failed_after_retry");
        }
      }
    });



  }

  
  catch (err) {
    // Refund reserved credits on any unexpected failure path
    try {
      if (req.userId && typeof creditsReserved !== "undefined" && creditsReserved) {
        refundCredits(req.userId, reservedCost);
        creditsReserved = false;
      }
    } catch (e) {}

    res.status(500).json({
      error: "Server error",
      details: err.message
    });
  }
});





// Run DB migrations once at startup
runMigrations();

// ============================================================================
// Start the server
// ============================================================================
app.listen(3000, () => {
  console.log("Pishnama backend server running on port 3000");
});
