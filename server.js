import express from "express";
import { GoogleGenAI } from "@google/genai";
import crypto from "crypto";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.static("public"));

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ── Cache (in-memory, TTL 5 min) ──────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function getCacheKey(base64, targetTime) {
  return crypto.createHash("md5").update(base64 + targetTime).digest("hex");
}

function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
  return entry.data;
}

function setCache(key, data) {
  // ป้องกัน memory leak: ถ้า cache เกิน 100 entries ล้างตัวเก่าสุดออก
  if (cache.size >= 100) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
  cache.set(key, { data, ts: Date.now() });
}

// ── Gemini call with retry ────────────────────────────────────────────────────
async function callGemini(base64, targetTime, retries = 2) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        // ↓ แก้ตรงนเท่านั้น ↓
        `คุณคือระบบอ่านตารางโรงหนังจาก Major Cineplex
กฎสำคัญ:
1. นับเฉพาะรอบที่เวลาฉาย <= ${targetTime} เท่านั้น
2. "people" = ผลรวมคอลัมน์ "Admis" (จำนวนคน)
3. "money" = ผลรวมคอลัมน์ "Amount" (จำนวนเงิน บาท) — ห้ามเอาค่า Admis มาใส่ช่องนี้
4. Admis และ Amount คือคนละคอลัมน์ อย่าสับสน
5. "screens" = จำนวนโรงที่ฉายหนังเรื่องนั้น
6. "rounds" = จำนวนรอบที่ผ่านเงื่อนไข
7. รวมหนงชื่อเดียวกัน + เสียงเดียวกันเข้าด้วยกัน
8. "branch" = ชื่อสาขาจากช่อง Branch ในตาราง
9. ตอบเป็น JSON เท่านั้น ห้ามมีข้อความอื่น
{"branch": "", "movies": [{"name": "", "sound": "", "screens": 0, "rounds": 0, "people": 0, "money": 0}]}`,
        // ↑ จบส่วนที่แก้ ↑
        { inlineData: { mimeType: "image/png", data: base64 } },
      ],
      config: { responseMimeType: "application/json" },
    });
    return JSON.parse(response.text);
  } catch (err) {
    // ... โค้ดส่วนล่างเหมือนเดิมทุกอย่าง
    // Retry เฉพาะ 503 / network error (ไม่ retry 429 — ต้องรอโควตา)
   const retryable = err.status === 503 || err.status === 429 || err.name === "AbortError" || !err.status;
    if (retryable && retries > 0) {
      const delay = err.status === 429 ? 60_000 : (3 - retries) * 2000;
      await new Promise((r) => setTimeout(r, delay));
      return callGemini(base64, targetTime, retries - 1);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Input validation ──────────────────────────────────────────────────────────
function validateInput(image, targetTime) {
  if (!image || typeof image !== "string")
    return "กรุณาส่งรูปภาพมาด้วยครับ";
  if (!targetTime || typeof targetTime !== "string" || !/^\d{1,2}:\d{2}$/.test(targetTime))
    return "targetTime ต้องอยู่ในรูปแบบ HH:MM เช่น 18:30";
  if (image.length > 20_000_000)
    return "ไฟล์รูปใหญ่เกินไปครับ (สูงสุด ~15MB)";
  return null;
}

// ── Error message mapping ─────────────────────────────────────────────────────
function geminiErrorResponse(err) {
  if (err.status === 429)
    return { status: 429, message: "โควตา API เต็มครับ! รอประมาณ 1 นาทีแล้วกดใหม่นะ" };
  if (err.status === 400)
    return { status: 400, message: "รปภาพไม่ถูกต้องหรือ Gemini ไม่รองรับรูปแบบนี้" };
  if (err.status === 503)
    return { status: 503, message: "Gemini ไม่ว่างชั่วคราวครับ ลองใหม่อีกครั้ง" };
  if (err.name === "AbortError")
     return { status: 504, message: "Gemini ใช้เวลานานเกิน 30 วินาที ลองใหม่อีกครั้ง" };
  return { status: 500, message: `เกิดข้อผิดพลาด: ${err.message}` };
}

// ── Route ─────────────────────────────────────────────────────────────────────
app.post("/analyze", async (req, res) => {
  const { image, targetTime } = req.body;

  const validationError = validateInput(image, targetTime);
  if (validationError) return res.status(400).json({ error: validationError });

  const base64 = image.includes("base64,") ? image.split("base64,")[1] : image;
  const cacheKey = getCacheKey(base64, targetTime);

  const cached = getCache(cacheKey);
  if (cached) return res.json({ ...cached, fromCache: true });

  try {
    const result = await callGemini(base64, targetTime);
    setCache(cacheKey, result);
    res.json(result);
  } catch (err) {
    const { status, message } = geminiErrorResponse(err);
    res.status(status).json({ error: message });
  }
});

app.listen(3000, () => console.log("🔥 http://localhost:3000"));