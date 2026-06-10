import express from "express";
import cors from "cors"; 
import { GoogleGenAI } from "@google/genai";
import crypto from "crypto";
import dotenv from "dotenv";
import fs from "fs";         
import path from "path";     
import PDFDocument from "pdfkit"; // 📌 1. เพิ่มไลบรารีสร้าง PDF

dotenv.config();

const app = express();

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.static("public"));

// ── ระบบจัดการ API Keys (Rotation) ──────────────────────────────────────────
const apiKeys = process.env.GEMINI_API_KEYS ? process.env.GEMINI_API_KEYS.split(',') : [];
let currentKeyIndex = 0;

function getGenAI() {
  if (apiKeys.length === 0) {
    console.error("❌ ไม่พบ GEMINI_API_KEYS ใน .env");
    return new GoogleGenAI({ apiKey: "" });
  }
  const key = apiKeys[currentKeyIndex].trim();
  console.log(`🔑 กำลังใช้ API Key ลำดับที่: ${currentKeyIndex + 1}/${apiKeys.length}`);
  return new GoogleGenAI({ apiKey: key });
}

function rotateKey() {
  if (apiKeys.length > 1) {
    currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
    console.log(`🔄 ตรวจพบโควตาเต็ม! สลับไปใช้ API Key ลำดับที่: ${currentKeyIndex + 1}/${apiKeys.length}`);
  } else {
    console.log(`⚠️ มี API Key เพียงคีย์เดียว ไม่สามารถสลับได้`);
  }
}

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
  if (cache.size >= 100) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
  cache.set(key, { data, ts: Date.now() });
}

// ── Gemini call ───────────────────────────────────────────────────────────────
async function callGemini(base64, targetTime, mimeType = "image/png", retries = 2) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);

  try {
    console.log(`⏳ กำลังส่งไฟล์ [${mimeType}] ไปให้ Gemini... (รอบที่เหลือ: ${retries})`);
    const ai = getGenAI();

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
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
        { inlineData: { mimeType: mimeType, data: base64 } },
      ],
      config: { responseMimeType: "application/json" },
    });

    console.log("✅ Gemini ตอบกลับมาสำเร็จ!");
    return JSON.parse(response.text);
  } catch (err) {
    console.error("❌ เกิด Error ระหว่างคุยกับ Gemini:", err.message || err);
    const statusCode = err.status || err.statusCode || (err.error?.code);
    
    if (statusCode === 429) {
      rotateKey();
      if (retries > 0) {
        console.log(`🔄 สลับคีย์แล้ว กำลังลองส่งใหม่อีกครั้งทันที...`);
        return callGemini(base64, targetTime, mimeType, retries - 1);
      }
    }
    
    const retryable = statusCode === 503 || err.name === "AbortError" || !statusCode;
    if (retryable && retries > 0) {
      const delay = (3 - retries) * 2000;
      console.log(`🔄 กำลังลองใหม่อีกครั้งในอีก ${delay/1000} วินาที...`);
      await new Promise((r) => setTimeout(r, delay));
      return callGemini(base64, targetTime, mimeType, retries - 1);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function validateInput(image, targetTime) {
  if (!image || typeof image !== "string") return "กรุณาส่งไฟล์รูปภาพหรือ PDF มาด้วยครับ";
  if (!targetTime || typeof targetTime !== "string" || !/^\d{1,2}:\d{2}$/.test(targetTime))
    return "targetTime ต้องอยู่ในรูปแบบ HH:MM เช่น 18:30";
  return null;
}

function geminiErrorResponse(err) {
  const statusCode = err.status || err.statusCode || (err.error?.code);
  if (statusCode === 429) return { status: 429, message: "โควตา API เต็มครับ! ระบบทำการสลับคีย์ให้แล้ว กรุณาลองใหม่อีกครั้ง" };
  if (statusCode === 400) return { status: 400, message: "ไฟล์ไม่ถูกต้องหรือ Gemini ไม่รองรับรูปแบบนี้" };
  if (statusCode === 503) return { status: 503, message: "Gemini ไม่ว่างชั่วคราวชั่วคราว ลองใหม่อีกครั้ง" };
  if (err.name === "AbortError") return { status: 504, message: "Gemini ใช้เวลานานเกินไปในการอ่านไฟล์ ลองใหม่อีกครั้ง" };
  return { status: 500, message: `เกิดข้อผิดพลาดบนเซิร์ฟเวอร์: ${err.message}` };
}

// ── [Route 1] หลักสำหรับประมวลผล + บันทึกไฟล์ (อัปเดตเป็น PDF) ───────────────────────
app.post("/analyze", async (req, res) => {
  const { image, targetTime } = req.body;

  const validationError = validateInput(image, targetTime);
  if (validationError) return res.status(400).json({ error: validationError });

  let mimeType = "image/png"; 
  if (image.startsWith("data:")) {
    const match = image.match(/^data:(.*?);base64,/);
    if (match) mimeType = match[1];
  }

  const base64 = image.includes("base64,") ? image.split("base64,")[1] : image;
  const cacheKey = getCacheKey(base64, targetTime);

  const cached = getCache(cacheKey);
  if (cached) return res.json({ ...cached, fromCache: true });

  try {
    const result = await callGemini(base64, targetTime, mimeType);
    setCache(cacheKey, result);

    const outputFolder = "./saved_outputs";
    if (!fs.existsSync(outputFolder)) {
      fs.mkdirSync(outputFolder);
    }

    // 📌 2. ตั้งชื่อไฟล์เป็น .pdf
    const fileName = `report-${Date.now()}.pdf`;
    const filePath = path.join(outputFolder, fileName);

    // 📌 3. วาดและสร้าง PDF ลงไฟล์ด้วย Promise เพื่อให้รอไฟล์เขียนเสร็จ
    await new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50 });
      const stream = fs.createWriteStream(filePath);

      doc.pipe(stream);

      // ⚠️ โหลดฟอนต์ภาษาไทย (ถ้าโปรเจกต์คุณไม่มีไฟล์นี้ให้คอมเมนต์บรรทัดล่างทิ้ง แต่ภาษาไทยจะอ่านไม่ออก)
      try {
        doc.font('./fonts/THSarabunNew.ttf');
      } catch (e) {
        console.warn("⚠️ ไม่พบไฟล์ฟอนต์ภาษาไทยที่ ./fonts/THSarabunNew.ttf ระบบจะใช้ฟอนต์เริ่มต้นแทน");
      }

      // สร้างหัวเอกสาร
      doc.fontSize(24).text(`รายงานข้อมูลโรงภาพยนตร์`, { align: 'center' });
      doc.fontSize(18).text(`สาขา: ${result.branch || 'ไม่ระบุ'}`, { align: 'center' });
      doc.moveDown(2);

      // นำข้อมูล Movies มาวนลูปเขียนลง PDF
      if (result.movies && result.movies.length > 0) {
        result.movies.forEach((movie, index) => {
          doc.fontSize(16).text(`${index + 1}. ${movie.name} (เสียง: ${movie.sound})`, { underline: true });
          doc.fontSize(14).text(`   - จำนวนโรง: ${movie.screens} โรง`);
          doc.fontSize(14).text(`   - จำนวนรอบฉาย: ${movie.rounds} รอบ`);
          doc.fontSize(14).text(`   - จำนวนผู้ชม: ${movie.people} คน`);
          doc.fontSize(14).text(`   - ยอดเงิน: ${movie.money.toLocaleString()} บาท`);
          doc.moveDown();
        });
      } else {
        doc.fontSize(16).text("ไม่มีข้อมูลภาพยนตร์ตามเงื่อนไข", { align: 'center' });
      }

      doc.end(); // สั่งจบการเขียน PDF

      stream.on('finish', resolve);
      stream.on('error', reject);
    });

    console.log(`💾 บันทึกไฟล์ PDF สำเร็จ: ${filePath}`);

    res.json({
      success: true,
      fileName: fileName,
      data: result
    });
  } catch (err) {
    const { status, message } = geminiErrorResponse(err);
    res.status(status).json({ error: message });
  }
});

// ── [Route 2] สำหรับเปิดให้คนใช้มือถือคลิกดาวน์โหลดไฟล์เพื่อแชร์ต่อ ─────────────────────
app.get("/download/:filename", (req, res) => {
  const fileName = req.params.filename;
  const filePath = path.join("./saved_outputs", fileName);

  if (fs.existsSync(filePath)) {
    // 📌 แจ้งบราวเซอร์ว่านี่คือไฟล์ PDF เพื่อให้โหลดหรือแสดงผลได้ถูกต้อง
    res.setHeader('Content-Type', 'application/pdf');
    res.download(filePath, fileName); 
  } else {
    res.status(404).json({ error: "ไม่พบไฟล์รายงานนี้บนระบบ" });
  }
});

app.listen(3000, () => {
  console.log("🔥 Server is running on http://localhost:3000");
  console.log(`🔑 API Keys Loaded: ${apiKeys.length} keys found.`);
});