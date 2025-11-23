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

// ===== NEW: Added for serving HTML files =====
import path from "path";
import { fileURLToPath } from "url";
// =============================================

dotenv.config();

// ===== NEW: Added for serving HTML files =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// =============================================

const app = express();

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
[PROMPT1]  (sofa mode + mode_selection = "all")
Write your full, detailed, uncompressed prompt here.
This prompt will be used when the user reupholsters ALL sofa parts with a SINGLE fabric.
`;

const prompt2 = `
[PROMPT2]  (sofa mode + mode_selection = "partial")
Write your full, detailed, uncompressed prompt here.
This prompt will be used when the sofa parts receive DIFFERENT fabrics.
`;

const prompt3 = `
[PROMPT3]  (pillows mode + mode_selection = "single")
Write your full, detailed, uncompressed prompt here.
This prompt will be used when ALL pillows must use ONE fabric.
`;

const prompt4 = `
[PROMPT4]  (pillows mode + mode_selection = "random")
Write your full, detailed, uncompressed prompt here.
This prompt will be used when pillows receive fabrics RANDOMLY (1–3 fabrics).
`;


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

    // -----------------------------------------------------------------------
    // PROMPT SELECTION (4 possible branches)
    // -----------------------------------------------------------------------
    let prompt;

    if (meta.mode === "sofa" && meta.mode_selection === "all") {
      prompt = prompt1;
    }
    else if (meta.mode === "sofa" && meta.mode_selection === "partial") {
      prompt = prompt2;
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
    let size;

    if (meta.quality === "high") {
      fidelity = "high";
      outQuality = "high";
      size = "2048x2048";
    } else {
      fidelity = "low";
      outQuality = "medium";
      size = "1024x1024";
    }

    // -----------------------------------------------------------------------
    // Build the form to send to OpenAI
    // -----------------------------------------------------------------------
    const form = new FormData();

    // Required model configuration
    form.append("model", "gpt-image-1");

    // Insert dynamic parameters
    form.append("prompt", prompt);
    form.append("input_fidelity", fidelity);
    form.append("quality", outQuality);
    form.append("size", size);
    form.append("n", "1");   // always 1 image for now

    // Attach files (base image and all fabric images)
    // Each uploaded file has: fieldname, originalname, buffer
    for (const f of files) {
      form.append(f.fieldname, f.buffer, { filename: f.originalname });
    }

    // -----------------------------------------------------------------------
    // Send request to OpenAI Images Edit API
    // -----------------------------------------------------------------------
    const response = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + process.env.OPENAI_API_KEY
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

// ============================================================================
// Start the server
// ============================================================================
app.listen(3000, () => {
  console.log("Pishnama backend server running on port 3000");
});
