// aiAdapter.js
// Provider abstraction for Pishnama image generation.
// Supports:
//   - OpenAI Images Edit API (current server.js behavior)
//   - Gemini 3 Pro Image Preview (Nano Banana Pro) based on NanoPro.js

import fetch from "node-fetch";
import FormData from "form-data";

/**
 * Main entry point used by server.js
 * Returns: { buffer: Buffer, mimeType: string }
 */
export async function generateImage({ meta, prompt, processedFiles }) {
  const provider = String(process.env.AI_IMAGE_PROVIDER || "openai").toLowerCase();

  if (provider === "gemini" || provider === "nanopro" || provider === "gemini-3-pro-image-preview") {
    return await generateWithGemini3Pro({ meta, prompt, processedFiles });
  }

  // default: openai
  return await generateWithOpenAI({ meta, prompt, processedFiles });
}

// -------------------------------
// OpenAI (current backend behavior)
// -------------------------------
async function generateWithOpenAI({ meta, prompt, processedFiles }) {
  // Keep your existing mapping exactly as in server.js
  let fidelity;
  let outQuality;
  let model;
  let size = "auto";

  if (meta.quality === "high") {
    model = "gpt-image-1";
    fidelity = "low";
    outQuality = "medium";
  } else {
    model = "gpt-image-1-mini";
    fidelity = "low";
    outQuality = "high";
  }

  const form = new FormData();
  form.append("model", model);
  form.append("prompt", prompt);
  form.append("input_fidelity", fidelity);
  form.append("quality", outQuality);
  form.append("size", size);
  form.append("n", "1");

  // Preserve existing behavior: send base + base_raw (if present) + fabrics as "image"
  for (const f of processedFiles) {
    form.append("image", f.buffer, { filename: f.originalname });
  }

  const response = await fetch(process.env.AI_MODEL_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + process.env.AI_MODEL_TOKEN
    },
    body: form
  });

  const text = await response.text();
  if (!response.ok) {
    // pass provider error text upward
    throw new Error(`openai_request_failed: ${text}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`openai_non_json_response: ${text}`);
  }

  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error("openai_no_image_returned");
  }

  // NOTE: OpenAI response here does not provide mime type in your current flow.
  // Your server currently treats it as PNG; keep that default.
  return {
    buffer: Buffer.from(b64, "base64"),
    mimeType: "image/png"
  };
}

// -----------------------------------------
// Gemini 3 Pro Image Preview (NanoPro-like)
// -----------------------------------------
async function generateWithGemini3Pro({ meta, prompt, processedFiles }) {
  const apiUrl = process.env.AI_API_URL;
  const apiKey = process.env.AI_API_KEY;
  const authMode = process.env.AI_AUTH_MODE; // "bearer" OR "x-goog-api-key"

  if (!apiUrl || !apiKey) {
    throw new Error("gemini_missing_env: AI_API_URL or AI_API_KEY");
  }

  const headers = { "Content-Type": "application/json" };
  if (authMode === "x-goog-api-key") {
    headers["x-goog-api-key"] = apiKey;
  } else {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  // Map server "quality" to a sensible Gemini imageSize default.
  // You can override via env GEMINI_IMAGE_SIZE_STANDARD / GEMINI_IMAGE_SIZE_HIGH.
  const aspectRatio = process.env.GEMINI_ASPECT_RATIO || "1:1";
  const imageSize =
    meta?.quality === "high"
      ? (process.env.GEMINI_IMAGE_SIZE_HIGH || "1K") // could be changed to 2k
      : (process.env.GEMINI_IMAGE_SIZE_STANDARD || "1K");

  // Build parts exactly like NanoPro.js, but using in-memory buffers.
  // Keep existing behavior: include ALL processed files as inline images.
  const parts = [];

  // Put base_image first if present; otherwise just keep original order
  const base = processedFiles.find((f) => f.fieldname === "base_image");
  if (base) {
    parts.push({
      inlineData: {
        mimeType: base.mimetype || "image/jpeg",
        data: base.buffer.toString("base64")
      }
    });
  }

  for (const f of processedFiles) {
    if (base && f === base) continue;
    parts.push({
      inlineData: {
        mimeType: f.mimetype || "image/jpeg",
        data: f.buffer.toString("base64")
      }
    });
  }

  // Then instruction text (your prompt)
  parts.push({ text: prompt });

  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: {
        aspectRatio,
        imageSize
      }
    }
  };
  
  const res = await fetch(apiUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  
  const text = await res.text();


  if (!res.ok) {
    throw new Error(`gemini_request_failed: ${text}`);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`gemini_non_json_response: ${text}`);
  }

  // Extract inline image the same way NanoPro.js does
  const candidateParts =
    json?.candidates?.[0]?.content?.parts ||
    json?.candidates?.[0]?.content?.parts?.parts ||
    [];

  // 1) native inlineData
  let base64 = null;
  let mime = null;

  const inline = candidateParts.find((p) => p?.inlineData?.data);
  if (inline) {
    base64 = inline.inlineData.data;
    mime = inline.inlineData.mimeType || "image/png";
  }

  // 2) fallback data URL in text
  if (!base64) {
    const textPart = candidateParts.find((p) => typeof p?.text === "string");
    if (textPart) {
      const match = textPart.text.match(
        /data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/
      );
      if (match) {
        mime = match[1];
        base64 = match[2];
      }
    }
  }

  if (!base64) {
    throw new Error("gemini_no_image_found_in_response");
  }

  return {
    buffer: Buffer.from(base64, "base64"),
    mimeType: mime || "image/png"
  };
}
