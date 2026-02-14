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
  
  return await generateWithGemini3Pro({ meta, prompt, processedFiles });

  // default: openai
  // return await generateWithOpenAI({ meta, prompt, processedFiles });
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

  // You can override via env GEMINI_IMAGE_SIZE_STANDARD / GEMINI_IMAGE_SIZE_HIGH.
  const aspectRatio = process.env.GEMINI_ASPECT_RATIO || "1:1";
  const imageSize = process.env.GEMINI_IMAGE_SIZE || "1K";
    

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
