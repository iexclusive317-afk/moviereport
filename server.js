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

// ── Gemini call (ปรับ Prompt ให้เก็บเฉพาะระบบเสียงปกติ/ภาษา) ─────────────────
async function callGemini(base64, mimeType = "application/pdf", retries = 2) {
  try {
    console.log(`⏳ กำลังส่งไฟล์ [${mimeType}] ไปให้ Gemini... (รอบที่เหลือ: ${retries})`);
    const ai = getGenAI();

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        `คุณคือระบบสกัดข้อมูลระดับสูงจากเอกสารรายงานรอบฉายโรงภาพยนตร์ (PDF/รูปภาพ เช่น รายงาน Vista / Major Cineplex)

หน้าที่ของคุณคือ "คัดลอกข้อมูลดิบทีละแถว (Showtime Row / รอบฉายรายบรรทัด)" ให้ครบถ้วนทุกหน้า ห้ามข้ามเด็ดขาด ห้ามสรุปยอดรวมเองโดยเด็ดขาด เพราะระบบหลังบ้านจะนำข้อมูลดิบที่คุณส่งไปประมวลผลต่อ

กฎเหล็กในการอ่านตารางเอกสาร:
1. "branch": ชื่อสาขาโรงภาพยนตร์ (เช่น "1142 Major Central westville") — ให้ดึงชื่อสาขาที่ปรากฏในหัวรายงานของหน้านั้นๆ ให้ถูกต้อง
2. "movie": ชื่อภาพยนตร์เต็มของรอบฉายนั้นๆ (เช่น "SPIDER MAN BRAND NEW DAY", "THE ODYSSEY")
3. "sound": ระบบภาพและเสียง ให้ระบุเฉพาะระบบเสียงหรือภาษาเท่านั้น (เช่น "EN/TH", "TH/--") **ให้ตัด/ละเว้นคำว่า Laserplex, IMAX, 4DX, ScreenX ออกทั้งหมด** ถ้าไม่มีให้ใส่ "-"
4. "theatre": หมายเลขโรงฉายหรือชื่อจอ (เช่น "VIP CINEMA 2", "Theatre 5") ห้ามปล่อยว่าง ให้ดึงชื่อโรงหรือหมายเลขโรงที่คุมรอบฉายนั้นๆ มาใส่ให้ครบทุกแถว
5. "time": เวลาฉายในรอบนั้นๆ รูปแบบ "HH:MM" (24 ชม.) เช่น "12:00", "15:30", "19:00"
6. "admis": จำนวนผู้ชม/ที่นั่ง เป็นตัวเลขล้วน ไม่มีคอมมา (ดูจากคอลัมน์ Admits ในแถวนั้น) ถ้าไม่มีให้ใส่ 0
7. "amount": ยอดเงิน/รายได้ **ให้ดึงค่าจากคอลัมน์ Gross เท่านั้น** เป็นตัวเลขดิบล้วนๆ ห้ามเอาช่อง Tax หรือ Net มาใส่ ถ้าไม่มีให้ใส่ 0

ข้อควรระวังสำคัญ:
- ต้องอ่านข้อมูลให้ครบทุกโรง ทุกหน้า (ตั้งแต่หน้าแรกจนถึงหน้าสุดท้าย)
- ข้ามแถวที่เป็นผลรวมสรุปท้ายหน้าหรือท้ายเอกสาร (Day Total, Total, Sum) ให้เก็บเฉพาะข้อมูลรายละเอียดรอบฉายจริงเท่านั้น

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

function timeToMinutes(t) {
  if (t === null || t === undefined) return null;
  const s = String(t).trim();
  const m = s.match(/(\d{1,2})[:.]?(\d{2})/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
  return hh * 60 + mm;
}

function toNumber(v) {
  if (typeof v === "number") return v;
  if (v === null || v === undefined) return 0;
  const cleaned = String(v).replace(/[,\s฿$บาท]/g, "");
  const n = Number(cleaned);
  return Number.isNaN(n) ? 0 : n;
}

function aggregateRows(rawRows, targetTime = "23:59") {
  const targetMinutes = timeToMinutes(targetTime);

  const filtered = (Array.isArray(rawRows) ? rawRows : []).filter(row => {
    if (targetMinutes === null) return true;
    const rowMinutes = timeToMinutes(row.time);
    if (rowMinutes === null) return true;
    return rowMinutes <= targetMinutes;
  });

  const groups = new Map();
  let lastValidTheatre = "-";
  let lastValidTime = "-";

  filtered.forEach(row => {
    const branch = (row.branch || "").trim() || "ไม่ระบุสาขา";
    const movie = (row.movie || row.name || "").trim();
    
    // กรองคำว่า Laserplex และระบบพิเศษอื่นๆ ออกจาก sound ให้เหลือเฉพาะระบบเสียงปกติ
    let soundRaw = (row.sound || "-").trim();
    let sound = soundRaw
      .replace(/laserplex/gi, "")
      .replace(/imax/gi, "")
      .replace(/4dx/gi, "")
      .replace(/screenx/gi, "")
      .replace(/dolby/gi, "")
      .trim();
      
    if (!sound || sound === "-") {
      sound = "-";
    }
    
    let theatre = (row.theatre || row.screen || "").toString().trim();
    if (!theatre || theatre === "-" || theatre === "undefined") {
      theatre = lastValidTheatre;
    } else {
      lastValidTheatre = theatre;
    }

    let time = (row.time || "").toString().trim();
    if (!time || time === "-" || time === "undefined" || !time.includes(":")) {
      time = lastValidTime;
    } else {
      lastValidTime = time;
    }

    if (!movie) return;

    const key = `${branch}___${movie}___${sound}`;
    if (!groups.has(key)) {
      groups.set(key, {
        branch, movie, sound,
        theatres: new Set(),
        times: new Set(),
        seats: 0,
        grossRevenue: 0,
      });
    }
    const g = groups.get(key);
    if (theatre && theatre !== "-") {
      g.theatres.add(theatre);
    }
    if (time && time !== "-") {
      g.times.add(time);
    }
    
    g.seats += toNumber(row.admis ?? row.seats);
    g.grossRevenue += toNumber(row.amount ?? row.gross ?? row.revenue);
  });

  const aggregatedArray = Array.from(groups.values()).map(g => ({
    branch: g.branch,
    movie: g.movie,
    sound: g.sound,
    screens: g.theatres.size > 0 ? g.theatres.size : 1,
    showings: g.times.size > 0 ? g.times.size : 1,
    seats: g.seats,
    revenue: g.grossRevenue,
  }));

  aggregatedArray.sort((a, b) => {
    const movieCompare = a.movie.localeCompare(b.movie, 'th');
    if (movieCompare !== 0) return movieCompare;
    return a.sound.localeCompare(b.sound, 'th');
  });

  return aggregatedArray;
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

    doc.fontSize(11).text("ยอดขายรวมสุทธิ (Gross)", 381, cardY + 12, { width: 168, align: "center" });
    doc.fontSize(15).fillColor("#16a34a").text(`฿${totalMoney.toLocaleString()}`, 381, cardY + 28, { width: 168, align: "center" });

    doc.y = cardY + 70;
    doc.fontSize(14).fillColor("#0f172a").text("📋 รายละเอียดรายได้จำแนกตามเรื่อง (เฉพาะยอด Gross)");
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