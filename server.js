import express from "express";
import cors from "cors"; 
import { GoogleGenAI } from "@google/genai";
import crypto from "crypto";
import dotenv from "dotenv";
import fs from "fs";         
import path from "path";     
import PDFDocument from "pdfkit"; 

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

// ── Gemini call ──────────────────────────────────────────────────────────────
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
7. แยกหนังตามชื่อและระบบเสียงที่ปรากฏในตาราง ห้ามรวมข้ามระบบเสียง
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

// ── [Route 1] วิเคราะห์และบันทึกผล ───────────────────────────────────────────────
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

    const fileName = `report-${Date.now()}.json`;
    const filePath = path.join(outputFolder, fileName);
    fs.writeFileSync(filePath, JSON.stringify(result, null, 2), "utf-8");
    console.log(`💾 บันทึกไฟล์ข้อมูลดิบสำเร็จ: ${filePath}`);

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

// ── [Route 2 แก้ไขสมบูรณ์แบบ 🛠️] บังคับเลย์เอาต์แถวแนวนอนสไตล์เว็บ ไม่ว่าข้อมูลจะเป็นอย่างไร ──
app.get("/export-pdf/:filename", (req, res) => {
  const jsonFileName = req.params.filename; 
  const jsonFilePath = path.join("./saved_outputs", jsonFileName);

  if (!fs.existsSync(jsonFilePath)) {
    return res.status(404).json({ error: "ไม่พบข้อมูลรายงานภาพยนตร์นี้บนระบบ" });
  }

  try {
    const rawData = fs.readFileSync(jsonFilePath, "utf-8");
    const result = JSON.parse(rawData);
    const pdfFileName = jsonFileName.replace(".json", ".pdf");

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=${pdfFileName}`);

    // สร้างเอกสาร PDF ขนาดมาตรฐาน A4 คลีนๆ สีขาวเด่นชัด
    const doc = new PDFDocument({ margin: 45, autoFirstPage: true });
    doc.pipe(res);

    const fontPath = path.join(process.cwd(), "fonts", "THSarabunNew.ttf");
    if (fs.existsSync(fontPath)) {
      doc.registerFont("THSarabun", fontPath);
      doc.font("THSarabun");
    }

    doc.on("pageAdded", () => {
      doc.font("THSarabun");
    });

    const movies = result.movies || [];
    const totalScreens = movies.reduce((a, m) => a + (m.screens || 0), 0);
    const totalPeople  = movies.reduce((a, m) => a + (m.people || 0), 0);
    const totalMoney   = movies.reduce((a, m) => a + (m.money || 0), 0);

    // 1. ส่วนหัวรายงานสไตล์เว็บบอร์ดบริหาร
    doc.fillColor("#0f172a").fontSize(22).text(`📈 Cinema Sales Dashboard`, { align: "left" });
    doc.fillColor("#64748b").fontSize(13).text(`สถานที่/สาขา: ${result.branch || "ไม่ระบุสาขาข้อมูลในระบบ"}`, { align: "left" });
    doc.moveDown(1);

    // 2. แผงควบคุมสรุปข้อมูลหลัก (Summary Cards แนวนอน 3 บล็อกสไตล์หน้าเว็บ)
    const cardY = doc.y;
    doc.rect(45, cardY, 505, 55).fillAndStroke("#f8fafc", "#cbd5e1");
    doc.fillColor("#0f172a");

    doc.fontSize(11).text("โรงภาพยนตร์ทั้งหมด", 45, cardY + 12, { width: 168, align: "center" });
    doc.fontSize(15).text(`${totalScreens} โรง`, 45, cardY + 28, { width: 168, align: "center" });

    doc.fontSize(11).text("ผู้ชมสะสมรวม", 213, cardY + 12, { width: 168, align: "center" });
    doc.fontSize(15).text(`${totalPeople.toLocaleString()} คน`, 213, cardY + 28, { width: 168, align: "center" });

    doc.fontSize(11).text("ยอดขายรวมสุทธิ", 381, cardY + 12, { width: 168, align: "center" });
    doc.fontSize(15).fillColor("#16a34a").text(`฿${totalMoney.toLocaleString()}`, 381, cardY + 28, { width: 168, align: "center" });

    // ขยับพิกัดลงมาด้านล่างแผงสรุป
    doc.text("", 45, cardY + 75);
    doc.fontSize(14).fillColor("#0f172a").text("📋 รายละเอียดรายได้จำแนกตามเรื่อง (เรียงตามข้อมูลระบบ)", { underline: false });
    doc.moveDown(0.5);

    // 3. เริ่มลูปวาดกล่องแถวแนวนอนรายตัวหนัง (Web Component Layout)
    let currentY = doc.y;

    if (movies.length > 0) {
      movies.forEach((movie, index) => {
        // เช็คความสูงหน้ากระดาษ (หากกล่องจะล้นระยะ 720px ให้ตัดขึ้นหน้าใหม่ทันทีเพื่อความระเบียบ)
        if (currentY > 700) {
          doc.addPage();
          currentY = 45;
        }

        // วาดกล่องพื้นหลังขาวขอบเทาอ่อนสไตล์กล่องหน้าเว็บ
        doc.roundedRect(45, currentY, 505, 48, 4).lineWidth(1).fillAndStroke("#ffffff", "#e2e8f0");

        // พิมพ์ชื่อหนังและลำดับ (จัดชิดซ้ายสุดของกล่อง สีน้ำเงินเทาเข้ม)
        doc.fillColor("#1e293b").fontSize(14);
        doc.text(`${index + 1}. ${movie.name}`, 55, currentY + 15, { width: 150, lineBreak: false });

        // พิมพ์แท็กระบบเสียงสไตล์ Badge ป้ายกำกับ (ฟอนต์สีขาวบนกล่องเทาเข้ม)
        doc.roundedRect(210, currentY + 13, 50, 22, 3).fill("#475569");
        doc.fillColor("#ffffff").fontSize(10).text(`${movie.sound || "TH/--"}`, 210, currentY + 18, { width: 50, align: "center" });

        // ข้อมูลตัวเลขคอลัมน์ด้านขวา (ล็อคพิกัดแกน X ตายตัว บังคับเป็นแถวหน้ากระดานแนวนอนเสมอ)
        doc.fillColor("#334155").fontSize(12);
        doc.text(`${movie.screens} โรง`, 275, currentY + 17, { width: 45, align: "center" });
        doc.text(`${movie.rounds} รอบ`, 325, currentY + 17, { width: 45, align: "center" });
        doc.text(`${movie.people.toLocaleString()} คน`, 375, currentY + 17, { width: 50, align: "center" });

        // ยอดเงินสุทธิปิดท้ายแถวขวาสุด (เน้นฟอนต์สีเขียวเข้มเพื่อความชัดเจนดึงดูดสายตา)
        doc.fillColor("#16a34a").fontSize(13);
        const formattedMoney = `${movie.money.toLocaleString()} บาท`;
        doc.text(formattedMoney, 430, currentY + 17, { width: 110, align: "right" });

        // เว้นช่องว่างระหว่างกล่องแต่ละเรื่อง 10 พิกัด (ความสูงกล่อง 48 + ช่องว่าง 10 = 58)
        currentY += 58; 
      });
    } else {
      doc.fillColor("#64748b").fontSize(13).text("ไม่พบข้อมูลภาพยนตร์ผ่านเงื่อนไขเวลากรุณาตรวจสอบอีกครั้ง", 45, currentY + 10);
    }

    // ส่วนล่างสุดบอกเวลาบันทึก
    doc.fontSize(9).fillColor("#94a3b8").text(`พิมพ์รายงานจากระบบ ณ วันเวลา: ${new Date().toLocaleString('th-TH')}`, 45, 770, { align: "left" });

    doc.end();

  } catch (err) {
    console.error("❌ เกิดข้อผิดพลาดร้ายแรงในการจัดหน้า PDF แนวนอน:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "เซิร์ฟเวอร์ไม่สามารถแปลงโครงสร้างตารางเป็นรูปแบบ PDF ได้" });
    } else {
      res.end();
    }
  }
});

// ── [Route 3] สำหรับดาวน์โหลดไฟล์ JSON ต้นฉบับ ───────────────────
app.get("/download/:filename", (req, res) => {
  const fileName = req.params.filename;
  const filePath = path.join("./saved_outputs", fileName);

  if (fs.existsSync(filePath)) {
    res.download(filePath, fileName); 
  } else {
    res.status(404).json({ error: "ไม่พบไฟล์รายงานนี้บนระบบ" });
  }
});

// ── Start Server ──────────────────────────────────────────────────────────────
app.listen(3000, () => {
  console.log("🔥 Server หลังบ้านทำงานเรียบร้อยที่พอร์ต 3000");
  console.log(`🔑 ตรวจพบจำนวน API Keys ทั้งหมด: ${apiKeys.length} คีย์`);
});