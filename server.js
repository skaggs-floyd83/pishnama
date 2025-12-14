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
import FormData from "form-data";
import sharp from "sharp";

// ===== NEW: Added for serving HTML files =====
import path from "path";
import { fileURLToPath } from "url";
// =============================================

// ===== LOGIN SYSTEM (NEW) =====
import crypto from "crypto"; 
import nodemailer from "nodemailer";

// import DB & migrations
import { runMigrations, db } from "./db.js";



dotenv.config();

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
// =============================================


const app = express();

// ===========================
// SIMPLE IN-MEMORY LOGIN STORE
// ===========================
const loginCodes = {};     // { emailOrPhone : "1234" }
const userTokens = {};     // { token : emailOrPhone }


// ===== NEW: Added static file serving =====
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "sofa.html"));
});
// ===========================================


// We store uploads in memory because we immediately pipe them to the OpenAI API.
const upload = multer({ storage: multer.memoryStorage() });

// ---------------------------------------------------------------------------
//  Define ALL FOUR PROMPTS explicitly
//  Replace the placeholders with your actual detailed prompts.
// ---------------------------------------------------------------------------
const prompt1 = `
replace the fabric of the sofa with the fabric in the other image so that all parts of the sofa appear to be made from exactly that fabric, with the same color and the same pattern. do not change anything else and keep everything else exactly and completely as it is in the first image. do not change anything like the carpet or such and keep them exactly as they are in the first image.
`;
// testing shirt replacement
// const prompt1 = `
// replace the fabric of the shirt of the boy with the fabric in the other image.
// `;

const prompt3 = `
Replace the fabric of all of the decorative pillows in the first image (including the probably dark ones or overlaid ones etc.), with the fabric in the second image so that all pillows appear to be made from exactly that fabric, with the same color and the same pattern. do not change anything else and keep everything else exactly as it is in the first image (this is very important). do not change anything like the carpet or such and keep them exactly as they are in the first image.
`;

const prompt4 = `
Replace the fabric of all of the decorative pillows in the first image (including the probably dark ones or overlaid ones etc.), with the fabrics in the other images so that all of the pillows appear to be made from exactly that fabric, with exactly the same color and exactly the same pattern. For each pillow choose the fabric that results in the best overall composition and make sure that all of the fabrics are used. Each pillow should be covered with a single fabric. do not change anything else and keep everything else exactly as it is in the first image (this is very important). do not change anything like the carpet or such and keep them exactly as they are in the first image.
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


// ====================== CREDIT CONFIG & HELPERS===========================

// Maximum number of old credits that can be preserved on top-up
const CREDIT_KEEP_THRESHOLD = 10;

// Credit cost per generation
const CREDIT_COST_STANDARD = 1;
const CREDIT_COST_HIGH = 2;

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

// Generation cost calculator
function getGenerationCost(meta) {
  if (meta?.quality === "high") {
    return CREDIT_COST_HIGH;
  }
  return CREDIT_COST_STANDARD;
}

// Credit deduction primitive (This function assumes sufficiency)
function deductCredits(userId, amount) {
  db.prepare(
    `UPDATE users
     SET credits = credits - ?
     WHERE id = ?`
  ).run(amount, userId);
}




















// ===============================================
// POST /api/request-code
// Receives: { identifier: "email OR phone" }
// ===============================================
app.post("/api/request-code", express.json(), async (req, res) => {
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
      await sendLoginSms(identifier, code);
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

  // 3) Generate token and map it to user.id (NOT identifier)
  const token = crypto.randomBytes(24).toString("hex");
  userTokens[token] = row.id;

  // 4) Return token to frontend
  return res.json({ token });

});


// ===============================================
// Attach userId to req if token is valid
// ===============================================
app.use((req, res, next) => {
  const token = req.headers["x-user-token"];
  if (token && userTokens[token]) {
    req.userId = userTokens[token];
  }
  next();
});


// ====================== IMAGE NORMALIZATION / COMPRESSION ===================

const MAX_BASE_BYTES_SERVER   = 4 * 1024 * 1024; // 4 MB server threshold for base
const MAX_FABRIC_BYTES_SERVER = 4 * 1024 * 1024; // 4 MB server threshold for fabrics
const BASE_MAX_SIDE_SERVER    = 1536;
const FABRIC_MAX_SIDE_SERVER  = 1024;

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


// ============================================================================
// POST /api/generate
// Main route that receives meta, base_image, fabric files.
// ============================================================================
app.post("/api/generate", upload.any(), async (req, res) => {
  try {
    // -----------------------------------------------------------------------
    // Parse metadata sent by the frontend
    // meta fields include:
    //   meta.mode: "sofa" or "pillows"
    //   meta.mode_selection:
    //        sofa:    "all" or "partial"
    //        pillows: "single" or "random"
    //   meta.quality: "standard" or "high"
    // -----------------------------------------------------------------------
    const meta = JSON.parse(req.body.meta);
    const files = req.files;

    // Normalize / compress uploads (server safety net)
    const processedFiles = [];
    for (const f of files) {
      const kind = (f.fieldname === "base_image") ? "base" : "fabric";
      const processed = await processUploadedImage(f, kind);
      processedFiles.push(processed);
    }


    // console.log("Generation requested by user:", req.userId || "unauthenticated");
    // const creditInfo = getUserCredits(req.userId);
    // console.log("User credits state:", creditInfo);


    if (!req.userId) {
      return res.status(401).json({ error: "login_required" });
    }



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
      // console.log(prompt);
    }
    else if (meta.mode === "pillows" && meta.mode_selection === "single") {
      prompt = prompt3;
    }
    else if (meta.mode === "pillows" && meta.mode_selection === "random") {
      prompt = prompt4;
    }
    else {
      // fallback for unexpected values
      prompt = prompt1;
    }

    // -----------------------------------------------------------------------
    // QUALITY → INPUT_FIDELITY → SIZE MAPPING
    //
    // If meta.quality === "standard":
    //      input_fidelity = "low"
    //      quality       = "medium"
    //      size          = "1024x1024"
    //
    // If meta.quality === "high":
    //      input_fidelity = "high"
    //      quality        = "high"
    //      size           = "2048x2048"
    // -----------------------------------------------------------------------
    let fidelity;
    let outQuality;
    let model;
    let size = "auto";

    if (meta.quality === "high") {
      model = "gpt-image-1";
      fidelity = "low";
      outQuality = "medium";
      // size = "2048x2048";
    } else {
      model = "gpt-image-1-mini";
      fidelity = "low";
      outQuality = "high";
      // size = "1024x1024";
    }


    // -----------------------------------------------------------------------
    // Build the form to send to OpenAI
    // -----------------------------------------------------------------------
    const form = new FormData();

    // Required model configuration
    form.append("model", model);

    // Insert dynamic parameters
    form.append("prompt", prompt);
    form.append("input_fidelity", fidelity);
    form.append("quality", outQuality);
    form.append("size", size);
    form.append("n", "1");   // always 1 image for now

    
    // Attach normalized files (base image and all fabric images)
    // Each uploaded file has: fieldname, originalname, buffer
    for (const f of processedFiles) {
      if (f.fieldname === "base_image") {
        // OpenAI requires this exact name:
        form.append("image", f.buffer, { filename: f.originalname });
      } else {
        // Fabric images: any name is OK
        form.append("image", f.buffer, { filename: f.originalname });
      }
    }




    // === SAMPLE REQUEST FOR PROVIDER (SAFE TO LOG) ===
    /*
    console.log("=== SAMPLE OUTGOING REQUEST ===");
    console.log("URL:", process.env.AI_MODEL_ENDPOINT);
    console.log("Headers:", {
      Authorization: "Bearer " + process.env.AI_MODEL_TOKEN
    });
    console.log("Content-Type:", form.getHeaders()["content-type"]);
    console.log("Fields:", {
      model: "gpt-image-1",
      prompt,
      input_fidelity: fidelity,
      quality: outQuality,
      size,
      n: 1
    });
    console.log("Files:", files.map(f => ({
      fieldname: f.fieldname,
      filename: f.originalname,
      size: f.size
    })));
    console.log("=== END OF SAMPLE REQUEST ===");
    */

    // -----------------------------------------------------------------------
    // Send request to OpenAI Images Edit API
    // -----------------------------------------------------------------------
    const response = await fetch(process.env.AI_MODEL_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + process.env.AI_MODEL_TOKEN
      },
      body: form
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(500).json({
        error: "OpenAI request failed",
        details: errText
      });
    }

    const data = await response.json();

    if (!data.data || !data.data[0] || !data.data[0].b64_json) {
      return res.status(500).json({
        error: "No image returned from OpenAI"
      });
    }

    // -----------------------------------------------------------------------
    // Return the base64 image to the frontend
    // -----------------------------------------------------------------------
    res.json({ image_base64: data.data[0].b64_json });
  }

  catch (err) {
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
