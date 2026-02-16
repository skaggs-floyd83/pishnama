// aiAdapter_v2.js
// Provider abstraction for Pishnama image generation.
//
// IMPORTANT:
// - gemini-3-pro-image-preview is NOT supported on /v1/images/edits for AvalAI (per your error),
//   so we use AvalAI's OpenAI-compatible Chat Completions endpoint:
//     POST https://api.avalai.ir/v1/chat/completions
//
// Multi-image input:
// - Send multiple images by including multiple {type:"image_url"} items inside messages[0].content[]
//   using data URLs (base64).
//
// Image output (AvalAI Gemini image examples):
// - The generated/edited image is returned in:
//     response.choices[0].message.images[0].image_url.url
//   (not necessarily inside message.content[])

import fetch from "node-fetch";

/**
 * Main entry point used by server.js
 * Returns: { buffer: Buffer, mimeType: string }
 */
export async function generateImage({ meta, prompt, processedFiles }) {
  // Keep meta in signature for future compatibility, but do not use meta.quality here.
  return await generateWithAvalAIChat({ meta, prompt, processedFiles });
}

// -----------------------------------------
// AvalAI (Chat Completions)
// -----------------------------------------
async function generateWithAvalAIChat({ meta, prompt, processedFiles }) {
  const baseUrl = (process.env.AVALAI_BASE_URL || "https://api.avalai.ir/v1").replace(/\/+$/, "");
  const apiKey = process.env.AVALAI_API_KEY || process.env.AI_API_KEY; // fallback for convenience
  const model = process.env.AVALAI_MODEL || "gemini-3-pro-image-preview";
  const url = `${baseUrl}/chat/completions`;

  if (!apiKey) {
    throw new Error("avalai_missing_env: AVALAI_API_KEY (or AI_API_KEY fallback)");
  }

  // Build OpenAI-compatible multimodal message.
  // Their docs show:
  // messages=[{ role:"user", content:[{type:"text",text:"..."},{type:"image_url",image_url:{url:"..."}}]}]
  // modalities=["image","text"]
  const content = [];

  // Put instruction text first (matches their sample style)
  content.push({ type: "text", text: prompt });

  // Add images (base_image first, then the rest)
  const files = Array.isArray(processedFiles) ? processedFiles : [];
  if (files.length > 0) {
    const base = files.find((f) => f.fieldname === "base_image");
    const ordered = [];

    if (base) ordered.push(base);
    for (const f of files) {
      if (base && f === base) continue;
      ordered.push(f);
    }

    for (const f of ordered) {
      if (!f?.buffer) continue;

      const mime = f.mimetype || "image/jpeg";
      const b64 = f.buffer.toString("base64");
      const dataUrl = `data:${mime};base64,${b64}`;

      content.push({
        type: "image_url",
        image_url: { url: dataUrl }
      });
    }
  }

  const body = {
    model,
    messages: [{ role: "user", content }],
    // AvalAI sample for this model includes modalities=["image","text"]
    modalities: ["image", "text"]
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const rawText = await res.text();

  if (!res.ok) {
    throw new Error(`avalai_request_failed: ${rawText}`);
  }

  let json;
  try {
    json = JSON.parse(rawText);
  } catch {
    throw new Error(`avalai_non_json_response: ${rawText}`);
  }

  const extracted = await extractImageFromAvalAIChatResponse(json);
  if (!extracted?.buffer) {
    // Helpful debugging without dumping massive base64:
    const msg = json?.choices?.[0]?.message;
    const hasImages = Array.isArray(msg?.images) && msg.images.length > 0;
    const contentType = Array.isArray(msg?.content) ? "array" : typeof msg?.content;
    throw new Error(
      `avalai_no_image_found_in_response: hasMessageImages=${hasImages} messageContentType=${contentType}`
    );
  }

  return extracted;
}

/**
 * Extract image from AvalAI Chat Completions response.
 *
 * Primary (per AvalAI Gemini image examples):
 * - json.choices[0].message.images[0].image_url.url
 *
 * That URL can be:
 * - a remote https URL
 * - or a data URL (data:image/...;base64,...)
 *
 * We also keep a few fallbacks for other shapes.
 */
async function extractImageFromAvalAIChatResponse(json) {
  const decodeDataUrl = (s) => {
    const match = s.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/);
    if (!match) return null;
    return { buffer: Buffer.from(match[2], "base64"), mimeType: match[1] };
  };

  // 1) PRIMARY: choices[0].message.images[0].image_url.url
  const imagesArr = json?.choices?.[0]?.message?.images;
  if (Array.isArray(imagesArr) && imagesArr.length > 0) {
    const url = imagesArr?.[0]?.image_url?.url;
    if (typeof url === "string" && url.length > 0) {
      const decoded = decodeDataUrl(url);
      if (decoded) return decoded;

      if (url.startsWith("http")) {
        const fetched = await fetch(url);
        if (!fetched.ok) {
          throw new Error(`avalai_image_url_fetch_failed: ${fetched.status} ${fetched.statusText}`);
        }
        const arrayBuf = await fetched.arrayBuffer();
        const contentType = fetched.headers.get("content-type") || "image/png";
        return { buffer: Buffer.from(arrayBuf), mimeType: contentType };
      }
    }
  }

  // 2) Fallback: sometimes gateways put data URLs in message.content (array or string)
  const content = json?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) {
    for (const it of content) {
      const url = it?.image_url?.url;
      if (typeof url === "string") {
        const decoded = decodeDataUrl(url);
        if (decoded) return decoded;
      }
      const text = typeof it?.text === "string" ? it.text : null;
      if (text) {
        const m = text.match(/data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/);
        if (m) return { buffer: Buffer.from(m[2], "base64"), mimeType: m[1] };
      }
    }
  } else if (typeof content === "string") {
    const m = content.match(/data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/);
    if (m) return { buffer: Buffer.from(m[2], "base64"), mimeType: m[1] };
  }

  // 3) Last-resort legacy shapes some providers return
  const b64json = json?.data?.[0]?.b64_json;
  if (typeof b64json === "string" && b64json.length > 0) {
    return { buffer: Buffer.from(b64json, "base64"), mimeType: "image/png" };
  }

  const url = json?.data?.[0]?.url;
  if (typeof url === "string" && url.startsWith("http")) {
    const fetched = await fetch(url);
    if (!fetched.ok) {
      throw new Error(`avalai_image_url_fetch_failed: ${fetched.status} ${fetched.statusText}`);
    }
    const arrayBuf = await fetched.arrayBuffer();
    const contentType = fetched.headers.get("content-type") || "image/png";
    return { buffer: Buffer.from(arrayBuf), mimeType: contentType };
  }

  return null;
}
