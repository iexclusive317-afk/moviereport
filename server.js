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
  return new GoogleGenAI({ apiKey: key });
}

function rotateKey() {
  if (apiKeys.length > 1) {
    currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
    console.log(`🔄 สลับไปใช้ API Key ลำดับที่: ${currentKeyIndex + 1}/${apiKeys.length}`);
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
// เปลี่ยนกลยุทธ์: ให้ Gemini สกัดข้อมูล "ทีละรอบฉาย" (raw row ต่อ 1 รอบ) เท่านั้น
// ไม่ให้ Gemini นับจำนวนโรง/รอบ หรือรวมยอดเอง เพราะ LLM มักนับ/บวกเลขผิดเมื่อตารางมีหลายสิบ-หลายร้อยแถว
// (โดยเฉพาะไฟล์ PDF ที่มีหลายหน้า) — การนับจำนวนโรงที่ไม่ซ้ำ, จำนวนรอบ, และผลรวม Admis/Amount
// จะไปทำแบบ deterministic ด้วยโค้ด JS ใน aggregateRows() แทน ซึ่งแม่นยำ 100%
async function callGemini(base64, mimeType = "application/pdf", retries = 2) {
  try {
    console.log(`⏳ กำลังส่งไฟล์ [${mimeType}] ไปให้ Gemini... (รอบที่เหลือ: ${retries})`);
    const ai = getGenAI();

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        `คุณคือระบบสกัดข้อมูล (data extraction) จากรายงานรอบฉายโรงภาพยนตร์ Major Cineplex (PDF/รูปภาพ/ข้อความ)

หน้าที่ของคุณคือ "คัดลอกข้อมูลดิบทีละแถว" ให้ครบและถูกต้องที่สุดเท่านั้น
ห้ามนับจำนวนโรง ห้ามนับจำนวนรอบ ห้ามรวมยอดเงินหรือที่นั่งเองเด็ดขาด — ระบบภายนอกจะเป็นผู้คำนวณต่อจากข้อมูลดิบที่คุณส่งมา

กฎการอ่านเอกสาร — เอกสารเป็นตารางที่แต่ละแถวคือ "1 รอบฉาย" (1 showtime) ให้คุณสร้าง 1 object ต่อ 1 แถว/1 รอบฉายที่พบในเอกสาร:

1. "branch": ชื่อสาขาโรงภาพยนตร์ตามที่ปรากฏในเอกสาร (เช่น Major Central Westville, ICON Cineconic) — ถ้าทั้งเอกสารมีสาขาเดียว ให้ใส่ชื่อเดียวกันทุกแถว
2. "movie": ชื่อภาพยนตร์ของรอบฉายนั้น
3. "sound": ระบบภาพ + ภาษาเสียง/คำบรรยายของรอบฉายนั้น (เช่น "2D EN/TH", "IMAX TH/--")
   - ข้อยกเว้นสำคัญ: หากในเอกสารระบุคำว่า "Laserplex" ปนอยู่ ให้ตัดคำว่า "Laserplex" ออกทั้งหมด เหลือเฉพาะภาษาเสียง/คำบรรยาย (เช่น "Laserplex EN/TH" → บันทึกเป็น "EN/TH" เท่านั้น ห้ามใส่คำว่า Laserplex ปนมา)
   - หากไม่มีระบุเลยให้ใส่ "-"
4. "theatre": หมายเลข/ชื่อโรงฉายของรอบฉายนั้น ตามที่ปรากฏในเอกสารเป๊ะๆ (เช่น "Theatre 5", "โรง 3", "Screen 7") — ห้ามคาดเดาหรือปล่อยว่างถ้าเอกสารมีระบุ ถ้าเอกสารไม่มีคอลัมน์นี้จริงๆ ให้ใส่ "-"
5. "time": เวลาฉายของรอบนั้น ในรูปแบบ "HH:MM" (24 ชั่วโมง) ตามที่ปรากฏในเอกสาร ห้ามปัดหรือแปลงเวลา
6. "admis": จำนวนผู้ชม/ที่นั่งของรอบฉายนั้นแถวเดียว (จากคอลัมน์ Admis) เป็นตัวเลขล้วนไม่มีคอมมา ถ้าไม่มีให้ใส่ 0
7. "amount": ยอดเงินของรอบฉายนั้นแถวเดียว (จากคอลัมน์ Amount/Revenue) เป็นตัวเลขล้วนไม่มีคอมมา ห้ามสลับกับ admis ถ้าไม่มีให้ใส่ 0

ข้อสำคัญที่สุด:
- ต้องส่งครบทุกแถว/ทุกรอบฉายที่พบในเอกสาร ห้ามข้าม ห้ามรวมแถวที่ดูคล้ายกันเข้าด้วยกัน แม้ภาพยนตร์เรื่องเดียวกันแสดงหลายรอบหลายโรง ก็ต้องแยกเป็นคนละ object ตามจำนวนแถวจริงในเอกสาร
- ถ้าเอกสารมีตัวเลขสรุป/รวมยอด (Total/Sum) ที่ท้ายตารางอยู่แล้ว ห้ามนำมาสร้างเป็น object เพิ่ม ให้ข้ามแถวสรุปนั้นไป (เอาเฉพาะแถวรอบฉายจริง)

ตอบกลับมาเป็น JSON Array ของ Object เท่านั้น ห้ามใส่ Markdown code block หรือข้อความอื่นเกริ่นนำ:
[{"branch": "", "movie": "", "sound": "", "theatre": "", "time": "", "admis": 0, "amount": 0}]`,
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
        console.log(`🔄 สลับคีย์แล้ว กำลังลองส่งใหม่อีกครั้ง...`);
        return callGemini(base64, mimeType, retries - 1);
      }
    }
    
    const retryable = statusCode === 503 || err.name === "AbortError" || !statusCode;
    if (retryable && retries > 0) {
      const delay = (3 - retries) * 2000;
      console.log(`🔄 กำลังลองใหม่อีกครั้งในอีก ${delay/1000} วินาที...`);
      await new Promise((r) => setTimeout(r, delay));
      return callGemini(base64, mimeType, retries - 1);
    }
    throw err;
  }
}

function geminiErrorResponse(err) {
  const statusCode = err.status || err.statusCode || (err.error?.code);
  if (statusCode === 429) return { status: 429, message: "โควตา API เต็มครับ! ระบบทำการสลับคีย์ให้แล้ว กรุณาลองใหม่อีกครั้ง" };
  if (statusCode === 400) return { status: 400, message: "ไฟล์ไม่ถูกต้องหรือ Gemini ไม่รองรับรูปแบบนี้" };
  if (statusCode === 503) return { status: 503, message: "Gemini ไม่ว่างชั่วคราว ลองใหม่อีกครั้ง" };
  if (err.name === "AbortError") return { status: 504, message: "Gemini ใช้เวลานานเกินไปในการอ่านไฟล์ ลองใหม่อีกครั้ง" };
  return { status: 500, message: `เกิดข้อผิดพลาดบนเซิร์ฟเวอร์: ${err.message}` };
}

// ── ตัวช่วยแปลง "HH:MM" (หรือรูปแบบใกล้เคียง) → จำนวนนาที เพื่อเปรียบเทียบเวลาอย่างแม่นยำ ──
function timeToMinutes(t) {
  if (t === null || t === undefined) return null;
  const s = String(t).trim();
  // ดึงเฉพาะตัวเลขสองกลุ่มแรก เผื่อรูปแบบเพี้ยนเช่น "18.30" หรือ "1830" หรือมีข้อความปน
  const m = s.match(/(\d{1,2})[:.]?(\d{2})/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
  return hh * 60 + mm;
}

// แปลงตัวเลขที่อาจมีคอมมา/สัญลักษณ์เงินปนมา ให้เป็น Number ที่ปลอดภัย
function toNumber(v) {
  if (typeof v === "number") return v;
  if (v === null || v === undefined) return 0;
  const cleaned = String(v).replace(/[,\s฿]/g, "");
  const n = Number(cleaned);
  return Number.isNaN(n) ? 0 : n;
}

// ── รวมข้อมูลดิบ (1 object = 1 รอบฉาย) ให้เป็นยอดสรุปต่อ (สาขา + เรื่อง + ระบบ) ──────
// นับ "screens" จากจำนวน theatre ที่ไม่ซ้ำจริง และ "showings" จากจำนวนแถวจริง แทนที่จะให้ Gemini นับเอง
function aggregateRows(rawRows, targetTime = "23:59") {
  const targetMinutes = timeToMinutes(targetTime);

  const filtered = (Array.isArray(rawRows) ? rawRows : []).filter(row => {
    if (targetMinutes === null) return true; // ไม่ได้กำหนดเวลา หรือแปลงไม่ได้ → เอาทั้งหมด
    const rowMinutes = timeToMinutes(row.time);
    if (rowMinutes === null) return true; // อ่านเวลาของแถวนี้ไม่ได้ → ไม่กรองทิ้ง กันข้อมูลหาย
    return rowMinutes <= targetMinutes;
  });

  const groups = new Map();

  filtered.forEach(row => {
    const branch = (row.branch || "").trim() || "ไม่ระบุสาขา";
    const movie = (row.movie || row.name || "").trim();
    const sound = (row.sound || "-").trim() || "-";
    const theatre = (row.theatre || row.screen || "-").toString().trim() || "-";
    if (!movie) return; // ไม่มีชื่อเรื่อง ข้ามแถวนี้ (กันข้อมูลสรุป/ขยะหลุดมา)

    const key = `${branch}___${movie}___${sound}`;
    if (!groups.has(key)) {
      groups.set(key, {
        branch, movie, sound,
        theatres: new Set(),
        showings: 0,
        seats: 0,
        revenue: 0,
      });
    }
    const g = groups.get(key);
    if (theatre !== "-") g.theatres.add(theatre);
    g.showings += 1;
    g.seats += toNumber(row.admis ?? row.seats);
    g.revenue += toNumber(row.amount ?? row.revenue);
  });

  return Array.from(groups.values()).map(g => ({
    branch: g.branch,
    movie: g.movie,
    sound: g.sound,
    // ถ้าไม่มีข้อมูลโรงเลยสักแถว (theatre เป็น "-" ทั้งหมด) ให้ fallback เป็น 1 โรง แทน 0 กันข้อมูลดูผิดปกติ
    screens: g.theatres.size > 0 ? g.theatres.size : 1,
    showings: g.showings,
    seats: g.seats,
    revenue: g.revenue,
  }));
}

app.post("/analyze", async (req, res) => {
  const { image, targetTime = "23:59" } = req.body;

  if (!image || typeof image !== "string") {
    return res.status(400).json({ error: "กรุณาส่งข้อมูลรูปภาพ, PDF, Excel หรือ Text Base64 มาด้วยครับ" });
  }

  let mimeType = "image/png"; 
  if (image.startsWith("data:")) {
    const match = image.match(/^data:(.*?);base64,/);
    if (match) mimeType = match[1];
  }

  const base64 = image.includes("base64,") ? image.split("base64,")[1] : image;
  const cacheKey = getCacheKey(base64, targetTime);

  const cached = getCache(cacheKey);
  if (cached) return res.json({ success: true, fileName: cached.fileName, data: cached.data, fromCache: true });

  try {
    const rawRows = await callGemini(base64, mimeType);
    const aggregated = aggregateRows(rawRows, targetTime);

    const formattedResult = {
      branch: aggregated.length > 0 ? aggregated[0].branch : "หลายสาขา/รวม",
      movies: aggregated.map(r => ({
        name: r.movie,
        sound: r.sound,
        screens: r.screens,
        rounds: r.showings,
        people: r.seats,
        money: r.revenue,
      })),
    };

    const outputFolder = "./saved_outputs";
    if (!fs.existsSync(outputFolder)) {
      fs.mkdirSync(outputFolder, { recursive: true });
    }

    const fileName = `report-${Date.now()}.json`;
    const filePath = path.join(outputFolder, fileName);
    fs.writeFileSync(filePath, JSON.stringify(formattedResult, null, 2), "utf-8");
    console.log(`💾 บันทึกไฟล์ข้อมูลดิบสำเร็จ: ${filePath}`);

    const cachePayload = { fileName, data: aggregated };
    setCache(cacheKey, cachePayload);

    res.json({
      success: true,
      fileName: fileName,
      data: aggregated
    });
  } catch (err) {
    const { status, message } = geminiErrorResponse(err);
    res.status(status).json({ error: message });
  }
});

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

    const doc = new PDFDocument({ margin: 45, autoFirstPage: true });
    doc.pipe(res);

    const fontPath = path.join(process.cwd(), "fonts", "THSarabunNew.ttf");
    if (fs.existsSync(fontPath)) {
      doc.registerFont("THSarabun", fontPath);
      doc.font("THSarabun");
    }

    doc.on("pageAdded", () => {
      if (fs.existsSync(fontPath)) doc.font("THSarabun");
    });

    const movies = result.movies || [];
    const totalScreens = movies.reduce((a, m) => a + (m.screens || 0), 0);
    const totalPeople  = movies.reduce((a, m) => a + (m.people || 0), 0);
    const totalMoney   = movies.reduce((a, m) => a + (m.money || 0), 0);

    doc.fillColor("#0f172a").fontSize(22).text(`📈 Cinema Sales Dashboard`, { align: "left" });
    doc.fillColor("#64748b").fontSize(13).text(`สถานที่/สาขา: ${result.branch || "ไม่ระบุสาขาข้อมูลในระบบ"}`, { align: "left" });
    doc.moveDown(0.5);

    const cardY = doc.y;
    doc.rect(45, cardY, 505, 55).fillAndStroke("#f8fafc", "#cbd5e1");
    doc.fillColor("#0f172a");

    doc.fontSize(11).text("โรงภาพยนตร์ทั้งหมด", 45, cardY + 12, { width: 168, align: "center" });
    doc.fontSize(15).text(`${totalScreens} โรง`, 45, cardY + 28, { width: 168, align: "center" });

    doc.fontSize(11).text("ผู้ชมสะสมรวม", 213, cardY + 12, { width: 168, align: "center" });
    doc.fontSize(15).text(`${totalPeople.toLocaleString()} คน`, 213, cardY + 28, { width: 168, align: "center" });

    doc.fontSize(11).text("ยอดขายรวมสุทธิ", 381, cardY + 12, { width: 168, align: "center" });
    doc.fontSize(15).fillColor("#16a34a").text(`฿${totalMoney.toLocaleString()}`, 381, cardY + 28, { width: 168, align: "center" });

    doc.y = cardY + 70;
    doc.fontSize(14).fillColor("#0f172a").text("📋 รายละเอียดรายได้จำแนกตามเรื่อง (เรียงตามข้อมูลระบบ)");
    doc.moveDown(0.5);

    let currentY = doc.y;

    if (movies.length > 0) {
      movies.forEach((movie, index) => {
        if (currentY > 710) {
          doc.addPage();
          currentY = 45;
        }

        doc.roundedRect(45, currentY, 505, 48, 4).lineWidth(1).fillAndStroke("#ffffff", "#e2e8f0");

        doc.fillColor("#1e293b").fontSize(13);
        doc.text(`${index + 1}. ${movie.name}`, 55, currentY + 15, { 
          width: 145, 
          height: 25,
          ellipsis: true 
        });

        doc.roundedRect(205, currentY + 13, 55, 22, 3).fill("#475569");
        doc.fillColor("#ffffff").fontSize(10).text(`${movie.sound || "-"}`, 205, currentY + 18, { width: 55, align: "center" });

        doc.fillColor("#334155").fontSize(12);
        doc.text(`${movie.screens || 0} โรง`, 265, currentY + 17, { width: 50, align: "center" });
        doc.text(`${movie.rounds || 0} รอบ`, 320, currentY + 17, { width: 50, align: "center" });
        doc.text(`${(movie.people || 0).toLocaleString()} คน`, 375, currentY + 17, { width: 60, align: "center" });

        doc.fillColor("#16a34a").fontSize(13);
        const formattedMoney = `${(movie.money || 0).toLocaleString()} บาท`;
        doc.text(formattedMoney, 440, currentY + 17, { width: 100, align: "right" });

        currentY += 56; 
      });
    } else {
      doc.fillColor("#64748b").fontSize(13).text("ไม่พบข้อมูลภาพยนตร์ผ่านเงื่อนไขเวลากรุณาตรวจสอบอีกครั้ง", 45, currentY + 10);
    }

    doc.fontSize(9).fillColor("#94a3b8").text(`พิมพ์รายงานจากระบบ ณ วันเวลา: ${new Date().toLocaleString('th-TH')}`, 45, 770, { align: "left" });

    doc.end();

  } catch (err) {
    console.error("❌ เกิดข้อผิดพลาดในการสร้าง PDF:", err);
    if (!res.headersSent) res.status(500).json({ error: "ไม่สามารถสร้าง PDF ได้" });
  }
});

app.listen(3000, () => {
  console.log("🔥 Web Dashboard & Server ทำงานเรียบร้อยที่ http://localhost:3000");
});