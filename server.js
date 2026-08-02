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
async function callGemini(base64, targetTime = "23:59", mimeType = "application/pdf", retries = 2) {
  try {
    console.log(`⏳ กำลังส่งไฟล์ [${mimeType}] ไปให้ Gemini... (รอบที่เหลือ: ${retries})`);
    const ai = getGenAI();

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        `คุณคือระบบวิเคราะห์และสกัดข้อมูลรายงานรอบฉายโรงภาพยนตร์ Major Cineplex จากเอกสาร PDF/รูปภาพ/ข้อความ
กรุณาอ่านข้อมูลจากเอกสารแล้วแปลงเป็น JSON ตามกฎเกณฑ์ที่กำหนดอย่างเคร่งครัด:

กฎการสกัดข้อมูล:
1. "branch": ชื่อสาขาโรงภาพยนตร์ (เช่น Major Central Westville หรือ ICON Cineconic)
2. กรองเฉพาะรอบฉายที่มีเวลา <= ${targetTime} เท่านั้น (หาก targetTime เป็น 23:59 หรือไม่ได้กำหนด ให้ดึงข้อมูลทั้งหมด)
3. "movie": ชื่อภาพยนตร์
4. "sound": ระบบฉาย / ระบบภาพ / ภาษาเสียงและคำบรรยาย
   - ให้รวบรวมข้อมูลระบบภาพ (เช่น 2D, 3D, IMAX, 4DX, ScreenX) และภาษา (เช่น EN/TH, TH/--) เข้าด้วยกัน
   - ข้อยกเว้นสำคัญ: หากระบบฉายที่พบคือ "Laserplex" ให้ตัดคำว่า "Laserplex" ออกทั้งหมด เหลือไว้เฉพาะภาษาเสียง/คำบรรยายเท่านั้น (เช่น พบ "Laserplex EN/TH" ในเอกสาร ให้บันทึกผลลัพธ์เป็น "EN/TH" เท่านั้น ห้ามใส่คำว่า Laserplex ปนมาด้วยเด็ดขาด)
   - ตัวอย่างรูปแบบที่ถูกต้อง: "2D EN/TH", "EN/TH" (กรณีเดิมเป็น Laserplex), "2D TH/--" หรือหากไม่มีระบุเลยให้ใส่ "-"
5. "screens": จำนวนโรงที่ฉายภาพยนตร์เรื่องนั้นๆ (นับจำนวน Theatre/โรงที่ไม่ซ้ำ)
6. "showings": จำนวนรอบฉายทั้งหมดที่ผ่านเงื่อนไขเวลา
7. "seats": ผลรวมจากคอลัมน์ "Admis" (จำนวนผู้ชม/ที่นั่ง)
8. "revenue": ผลรวมจากคอลัมน์ "Amount" หรือ "Revenue" (จำนวนเงินบาท) — ห้ามสลับค่ากับ Admis
9. ข้อห้ามสำคัญ: หากชื่อเรื่องเดียวกันแต่ระบบฉาย/ระบบเสียงต่างกัน (เช่น 2D EN/TH กับ 2D TH/--) ให้แยกเป็นคนละรายการ ห้ามนำมารวมกัน

ตอบกลับมาเป็น JSON Array ของ Object เท่านั้น ห้ามใส่ Markdown code block หรือข้อความอื่นเกริ่นนำ:
[{"branch": "", "movie": "", "sound": "", "screens": 0, "showings": 0, "revenue": 0, "seats": 0}]`,
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

// ── [Route 1] วิเคราะห์ข้อความ/รูปภาพ/PDF/Excel ด้วย Gemini ──────────────────────
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
    const rawResult = await callGemini(base64, targetTime, mimeType);
    
    const formattedResult = {
      branch: Array.isArray(rawResult) && rawResult.length > 0 ? rawResult[0].branch : "หลายสาขา/รวม",
      movies: Array.isArray(rawResult) ? rawResult.map(r => ({
        name: r.movie || r.name || "",
        sound: r.sound || "-",
        screens: Number(r.screens || 0),
        rounds: Number(r.showings || r.rounds || 0),
        people: Number(r.seats || r.people || 0),
        money: Number(r.revenue || r.money || 0)
      })) : []
    };

    const outputFolder = "./saved_outputs";
    if (!fs.existsSync(outputFolder)) {
      fs.mkdirSync(outputFolder, { recursive: true });
    }

    const fileName = `report-${Date.now()}.json`;
    const filePath = path.join(outputFolder, fileName);
    fs.writeFileSync(filePath, JSON.stringify(formattedResult, null, 2), "utf-8");
    console.log(`💾 บันทึกไฟล์ข้อมูลดิบสำเร็จ: ${filePath}`);

    const cachePayload = { fileName, data: rawResult };
    setCache(cacheKey, cachePayload);

    res.json({
      success: true,
      fileName: fileName,
      data: rawResult
    });
  } catch (err) {
    const { status, message } = geminiErrorResponse(err);
    res.status(status).json({ error: message });
  }
});

// ── [Route 2] Export PDF ───────────────────────────────────────────────────
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

// ── [Route Main] เสิร์ฟหน้า HTML Web App ─────────────────────────────────────
app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>สรุปยอดหนังรายสาขา - Major Cineplex Analysis</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=IBM+Plex+Sans+Thai:wght@400;500;600;700&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>
<style>
  :root{
    --bg:#12141c;
    --surface:#1b1e29;
    --surface-2:#232735;
    --stub-edge:#0d0e14;
    --gold:#e7b23f;
    --gold-dim:#8a6c26;
    --red:#d64545;
    --green:#22c55e;
    --text:#f3efe6;
    --text-dim:#9199ac;
    --line:#31364a;
  }
  *{box-sizing:border-box;}
  body{
    margin:0;
    background:
      radial-gradient(ellipse at 20% -10%, #1e2233 0%, transparent 60%),
      radial-gradient(ellipse at 90% 0%, #22181c 0%, transparent 50%),
      var(--bg);
    color:var(--text);
    font-family:'IBM Plex Sans Thai', sans-serif;
    min-height:100vh;
    padding-bottom:60px;
  }
  .display{font-family:'Bebas Neue', 'IBM Plex Sans Thai', sans-serif; letter-spacing:.03em;}

  header{
    padding:38px 24px 26px;
    text-align:center;
    border-bottom:1px solid var(--line);
    position:relative;
    overflow:hidden;
  }
  header::before{
    content:"";
    position:absolute; inset:0;
    background-image:repeating-linear-gradient(90deg, rgba(231,178,63,.06) 0 2px, transparent 2px 26px);
    pointer-events:none;
  }
  header h1{
    font-size:44px;
    margin:0;
    color:var(--gold);
    text-shadow:0 0 24px rgba(231,178,63,.25);
  }
  header p{margin:8px 0 0; color:var(--text-dim); font-size:14px;}

  .wrap{max-width:1100px; margin:0 auto; padding:0 20px;}

  section.panel{
    margin-top:28px;
    background:var(--surface);
    border:1px solid var(--line);
    border-radius:14px;
    padding:22px 24px;
  }
  .panel h2{
    font-family:'Bebas Neue', sans-serif;
    letter-spacing:.04em;
    font-size:24px;
    color:var(--gold);
    margin:0 0 4px;
    display:flex; align-items:center; gap:10px;
  }
  .panel h2 .no{
    font-size:13px;
    color:var(--stub-edge);
    background:var(--gold);
    border-radius:5px;
    padding:2px 8px;
    font-family:'IBM Plex Sans Thai', sans-serif;
    font-weight:700;
  }
  .hint{color:var(--text-dim); font-size:12.5px; margin:0 0 16px; line-height:1.6;}

  .input-grid{
    display:grid;
    grid-template-columns:1fr 1fr;
    gap:16px;
  }
  @media(max-width:720px){ .input-grid{grid-template-columns:1fr;} }

  .input-box{
    background:var(--surface-2);
    border:1px dashed var(--line);
    border-radius:10px;
    padding:14px;
  }
  .input-box label{
    display:block; font-size:13px; font-weight:600; color:var(--text); margin-bottom:8px;
  }
  textarea{
    width:100%; min-height:130px; resize:vertical;
    background:var(--bg); color:var(--text);
    border:1px solid var(--line); border-radius:8px;
    padding:10px; font-family:monospace; font-size:12px;
  }
  input[type=file], input[type=text]{
    width:100%; color:var(--text-dim); font-size:12.5px;
  }
  .target-time-input {
    background: var(--bg);
    border: 1px solid var(--line);
    color: var(--gold);
    border-radius: 6px;
    padding: 6px 10px;
    font-weight: bold;
    margin-bottom: 10px;
    width: 120px !important;
  }
  button{
    cursor:pointer; border:none; border-radius:8px;
    font-family:'IBM Plex Sans Thai', sans-serif; font-weight:600;
    font-size:13.5px; padding:9px 16px;
    transition:transform .12s ease, opacity .12s ease;
  }
  button:active{transform:scale(.97);}
  .btn-primary{background:var(--gold); color:#241a05;}
  .btn-primary:hover{opacity:.9;}
  .btn-ghost{background:transparent; color:var(--text-dim); border:1px solid var(--line);}
  .btn-ghost:hover{color:var(--text);}
  .btn-danger{background:var(--red); color:#fff;}
  .btn-success{background:#16a34a; color:#fff;}
  .row-actions{display:flex; gap:10px; margin-top:10px;}

  .status-msg{font-size:12.5px; margin-top:8px; min-height:16px;}
  .status-msg.err{color:var(--red);}
  .status-msg.ok{color:#7fd18f;}

  .upload-guide {
    background: rgba(231, 178, 63, 0.08);
    border: 1px solid rgba(231, 178, 63, 0.2);
    border-radius: 6px;
    padding: 5px 9px;
    margin-top: 8px;
    font-size: 11px;
    color: #e2d1a3;
    line-height: 1.4;
    white-space: normal;
  }
  .upload-guide strong {
    color: var(--gold);
    font-weight: 600;
  }

  .manual-form{display:grid; grid-template-columns:repeat(7,1fr); gap:8px; align-items:end;}
  @media(max-width:900px){ .manual-form{grid-template-columns:repeat(2,1fr);} }
  .manual-form div{display:flex; flex-direction:column; gap:5px;}
  .manual-form label{font-size:11px; color:var(--text-dim);}
  .manual-form input{
    background:var(--bg); border:1px solid var(--line); border-radius:7px;
    color:var(--text); padding:8px; font-size:13px; font-family:inherit;
  }

  .review-table{width:100%; border-collapse:collapse; margin-top:14px; font-size:12.5px;}
  .review-table th{ text-align:left; color:var(--gold); font-weight:600; padding:6px 8px; border-bottom:1px solid var(--line);}
  .review-table td{padding:4px 6px;}
  .review-table input{
    width:100%; background:var(--bg); border:1px solid var(--line); border-radius:6px;
    color:var(--text); padding:5px 6px; font-size:12px; font-family:inherit;
  }
  .review-table input.num{width:80px;}
  .review-table input.snd{width:80px; text-transform:uppercase;}
  .review-table .del{background:none; border:none; color:var(--red); cursor:pointer; font-size:15px;}

  .sound-badge{
    display:inline-block;
    background:#31364a;
    color:#e7b23f;
    font-size:11px;
    font-weight:600;
    padding:1px 6px;
    border-radius:4px;
    margin-left:6px;
  }

  table.summary{width:100%; border-collapse:collapse; margin-top:6px;}
  table.summary th{
    text-align:left; font-size:12px; color:var(--gold); text-transform:uppercase; letter-spacing:.04em;
    padding:8px 10px; border-bottom:1px solid var(--line);
  }
  table.summary td{padding:9px 10px; border-bottom:1px solid rgba(255,255,255,.04); font-size:13.5px;}
  table.summary tr:hover td{background:rgba(231,178,63,.05);}
  .num{font-family:'Bebas Neue',sans-serif; font-size:16px; letter-spacing:.02em;}
  .rev{color:var(--gold);}

  .branch-layout{display:flex; gap:18px; margin-top:8px;}
  .branch-nav{
    flex:0 0 200px; max-height:520px; overflow-y:auto;
    border-right:1px solid var(--line); padding-right:12px;
  }
  .branch-nav button{
    display:block; width:100%; text-align:left; background:none; color:var(--text-dim);
    padding:8px 10px; border-radius:7px; font-size:12.5px; margin-bottom:2px; font-weight:500;
  }
  .branch-nav button:hover{background:var(--surface-2); color:var(--text);}
  .branch-nav button.active{background:var(--gold); color:#241a05;}

  .branch-scroll{
    flex:1; max-height:560px; overflow-y:auto; scroll-behavior:smooth;
    padding-right:6px;
  }
  .ticket{
    position:relative;
    background:var(--surface-2);
    border:1px solid var(--line);
    border-radius:12px;
    padding:18px 20px 16px;
    margin-bottom:22px;
  }
  .ticket::before, .ticket::after{
    content:"";
    position:absolute; top:50%; transform:translateY(-50%);
    width:16px; height:16px; border-radius:50%;
    background:var(--bg);
    border:1px solid var(--line);
  }
  .ticket::before{ left:-9px; }
  .ticket::after{ right:-9px; }
  .ticket-perf{
    border-top:1px dashed var(--line);
    margin:12px 0;
  }
  .ticket h3{
    font-family:'Bebas Neue', sans-serif; font-size:22px; letter-spacing:.03em;
    color:var(--text); margin:0;
  }
  .ticket .totalline{color:var(--text-dim); font-size:12px; margin-top:2px;}
  .ticket table{width:100%; border-collapse:collapse; margin-top:10px; font-size:12.5px;}
  .ticket th{text-align:left; color:var(--gold); font-weight:600; padding:5px 6px;}
  .ticket td{padding:5px 6px; border-top:1px solid rgba(255,255,255,.05);}

  .empty{
    text-align:center; padding:40px 10px; color:var(--text-dim); font-size:13.5px;
  }
</style>
</head>
<body>

<header>
  <h1 class="display">สรุปยอดหนังรายสาขา</h1>
  <p>วางข้อความ / อัปโหลดรูปภาพ / PDF / Excel (เลือกได้หลายไฟล์พร้อมกัน) — ส่งให้ Gemini 2.5 Flash ช่วยประมวลผลเป็นตารางสรุป</p>
</header>

<div class="wrap">

  <!-- INPUT -->
  <section class="panel">
    <h2><span class="no">1</span> นำเข้าข้อมูล</h2>
    <p class="hint">เลือกกำหนดเงื่อนไขเวลาฉายสูงสุด (Target Time) และอัปโหลดไฟล์/ข้อความเข้าสู่ระบบ Gemini</p>

    <div style="margin-bottom:15px;">
      <label style="font-size:13px; font-weight:600; color:var(--gold);">⏰ กรองเวลาฉายสูงสุด (Target Time): </label>
      <input type="text" id="targetTime" class="target-time-input" value="23:59" placeholder="18:30">
    </div>

    <div class="input-grid">
      <div class="input-box">
        <label>📋 วางข้อความตาราง</label>
        <textarea id="pasteText" placeholder="วางข้อมูลตารางที่นี่..."></textarea>
        <div class="row-actions">
          <button class="btn-primary" onclick="extractFromText()">แยกข้อมูลจากข้อความ</button>
          <button class="btn-ghost" onclick="document.getElementById('pasteText').value=''">ล้าง</button>
        </div>
        <div class="status-msg" id="textStatus"></div>
      </div>

      <div class="input-box">
        <label>🖼️ อัปโหลดรูปภาพ (เลือกหลายรูปได้)</label>
        <input type="file" id="imgFile" accept="image/*" multiple="multiple">
        
        <div class="upload-guide">
          💡 เลือกหลายรูป: <strong>คอมฯ</strong> กด Ctrl/Shift ค้าง · <strong>มือถือ</strong> แตะค้างแล้วเลือกเพิ่ม
        </div>

        <div class="row-actions">
          <button class="btn-primary" onclick="extractFromFile('imgFile','image')">แยกข้อมูลจากรูปภาพ</button>
        </div>
        <div class="status-msg" id="imgStatus"></div>
      </div>

      <div class="input-box">
        <label>📄 อัปโหลดไฟล์ PDF (เลือกหลายไฟล์ได้)</label>
        <input type="file" id="pdfFile" accept="application/pdf" multiple="multiple">
        
        <div class="upload-guide">
          💡 เลือกหลายไฟล์: <strong>คอมฯ</strong> กด Ctrl ค้าง · <strong>มือถือ</strong> แตะค้างแล้วเลือกเพิ่ม
        </div>

        <div class="row-actions">
          <button class="btn-primary" onclick="extractFromFile('pdfFile','pdf')">แยกข้อมูลจาก PDF</button>
        </div>
        <div class="status-msg" id="pdfStatus"></div>
      </div>

      <div class="input-box">
        <label>📊 อัปโหลดไฟล์ Excel (.xlsx / .xls / .csv, เลือกหลายไฟล์ได้)</label>
        <input type="file" id="excelFile" accept=".xlsx,.xls,.csv" multiple="multiple">

        <div class="upload-guide">
          💡 เลือกหลายไฟล์: กด Ctrl ค้าง (คอมฯ) หรือแตะค้างแล้วเลือกเพิ่ม (มือถือ) · อ่านทุกชีตอัตโนมัติ
        </div>

        <div class="row-actions">
          <button class="btn-primary" onclick="extractFromExcel()">แยกข้อมูลจาก Excel</button>
        </div>
        <div class="status-msg" id="excelStatus"></div>
      </div>

      <div class="input-box">
        <label>✏️ กรอกข้อมูลเอง (ทีละแถว)</label>
        <div class="manual-form">
          <div><label>สาขา</label><input id="m_branch" placeholder="เช่น ICON"></div>
          <div><label>เรื่อง</label><input id="m_movie" placeholder="เช่น Top Gun"></div>
          <div><label>ระบบ</label><input id="m_sound" placeholder="เช่น 2D TH"></div>
          <div><label>โรง</label><input id="m_screens" type="number"></div>
          <div><label>รอบ</label><input id="m_showings" type="number"></div>
          <div><label>เงิน</label><input id="m_revenue" type="number"></div>
          <div><label>ที่นั่ง</label><input id="m_seats" type="number"></div>
        </div>
        <div class="row-actions">
          <button class="btn-primary" onclick="addManualRow()">+ เพิ่มแถวนี้</button>
        </div>
        <div class="status-msg" id="manualStatus"></div>
      </div>
    </div>
  </section>

  <!-- REVIEW -->
  <section class="panel" id="reviewPanel" style="display:none;">
    <h2><span class="no">2</span> ตรวจสอบก่อนเพิ่มข้อมูล</h2>
    <p class="hint">แก้ไขค่าที่ผิดได้โดยตรงในตาราง กด ✕ เพื่อลบแถวที่ไม่ต้องการ แล้วกดยืนยันเพื่อเพิ่มเข้าข้อมูลจริง</p>
    <table class="review-table" id="reviewTable"></table>
    <div class="row-actions">
      <button class="btn-primary" onclick="confirmReview()">✓ ยืนยันและเพิ่มข้อมูล</button>
      <button class="btn-ghost" onclick="cancelReview()">ยกเลิก</button>
    </div>
  </section>

  <!-- SUMMARY -->
  <section class="panel">
    <h2><span class="no">3</span> สรุปยอดรวมแต่ละเรื่อง</h2>
    <div id="summaryArea"><div class="empty">ยังไม่มีข้อมูล — เริ่มนำเข้าข้อมูลด้านบน</div></div>
  </section>

  <!-- BRANCH SCROLL -->
  <section class="panel">
    <h2><span class="no">4</span> ยอดแยกรายสาขา</h2>
    <p class="hint">คลิกชื่อสาขาด้านซ้ายเพื่อเลื่อนไปดู หรือเลื่อนดูทีละสาขาในกรอบขวาได้เลย</p>
    <div id="branchArea"><div class="empty">ยังไม่มีข้อมูล</div></div>
    <div class="row-actions" style="margin-top:16px;">
      <button class="btn-danger" onclick="resetAll()">ล้างข้อมูลทั้งหมด</button>
      <button class="btn-success" id="btnExportPDF" style="display:none;" onclick="exportPDF()">📄 ออกรายงาน PDF</button>
    </div>
  </section>

  <!-- SCHEDULE ORGANIZER -->
  <section class="panel">
    <h2><span class="no">5</span> จัดระเบียบข้อมูลจากไฟล์ Excel (อัตโนมัติ)</h2>
    <p class="hint">
      รองรับ 2 รูปแบบ ระบบจะตรวจจับให้อัตโนมัติตามชีตที่เลือก:<br>
      • <strong>ตารางหนังเข้าฉายแยกตามค่าย</strong> (คอลัมน์ วันที่เข้าฉาย / ชื่อหนัง / เวลา / เสียง / เวอร์ชั่น เรียงเป็นบล็อกตามค่าย)<br>
      • <strong>รายการลำดับตัวอย่างหนัง (Trailer Order)</strong> (บล็อก ลำดับที่ / ชื่อเรื่อง / Date / Time แยกตามพื้นที่โรงฉาย)<br>
      ประมวลผลในเบราว์เซอร์ทันที ไม่ต้องผ่าน Gemini
    </p>

    <div class="input-box" style="margin-bottom:14px;">
      <label>📁 เลือกไฟล์ Excel</label>
      <input type="file" id="scheduleFile" accept=".xlsx,.xls" onchange="handleScheduleFileSelect()">
      <div id="scheduleSheetPicker" style="display:none; margin-top:10px;">
        <label style="font-size:12px; color:var(--text-dim); display:block; margin-bottom:6px;">เลือกชีตที่ต้องการจัดระเบียบ:</label>
        <select id="scheduleSheetSelect" style="width:100%; background:var(--bg); color:var(--text); border:1px solid var(--line); border-radius:7px; padding:8px; font-size:12.5px;"></select>
      </div>
      <div class="row-actions">
        <button class="btn-primary" onclick="runOrganizeSchedule()">จัดระเบียบข้อมูล</button>
        <button class="btn-success" id="btnExportSchedule" style="display:none;" onclick="exportScheduleExcel()">📊 ดาวน์โหลดเป็น Excel</button>
      </div>
      <div class="status-msg" id="scheduleStatus"></div>
    </div>

    <div id="scheduleResultArea"></div>
  </section>

  <!-- TRAILER LIST BOARD (image/PDF via Gemini) -->
  <section class="panel">
    <h2><span class="no">6</span> วิเคราะห์ตารางตัวอย่างหนังหน้าโรง (Trailer List)</h2>
    <p class="hint">
      สำหรับรูปภาพ/PDF ตาราง Trailer List ของโรงหนัง (เช่น คอลัมน์ CINEMA/MOVIE ทางซ้าย และคอลัมน์ NEXT PROGRAM
      พร้อมรหัสในช่อง เช่น D1, D2, S5, S7, N4) — ส่งให้ Gemini อ่านโครงตารางแล้วแปลงเป็นตารางรายการ
      "โรง/จอ → หนังที่ฉายอยู่ → ตัวอย่างเรื่องไหน ลำดับที่เท่าไร ฉายวันไหน"
    </p>

    <div class="input-box">
      <label>🖼️ อัปโหลดรูปภาพ หรือ 📄 PDF ตาราง Trailer List (เลือกหลายไฟล์ได้)</label>
      <input type="file" id="trailerFile" accept="image/*,application/pdf" multiple="multiple">
      <div class="upload-guide">
        💡 เลือกหลายไฟล์: กด Ctrl ค้าง (คอมฯ) หรือแตะค้างแล้วเลือกเพิ่ม (มือถือ)
      </div>
      <div class="row-actions">
        <button class="btn-primary" onclick="extractTrailerBoard()">วิเคราะห์ตาราง Trailer List</button>
      </div>
      <div class="status-msg" id="trailerStatus"></div>
    </div>

    <div id="trailerResultArea"></div>
  </section>

</div>

<script>
let records = [];      // {branch, movie, sound, screens, showings, revenue, seats}
let reviewBuffer = [];
let lastSavedFileName = "";

let scheduleWorkbook = null;
let scheduleRecords = [];   // organized movie-schedule rows for export

function fmt(n){ return Number(n||0).toLocaleString('th-TH'); }

async function callExpressBackend(base64Payload) {
  const targetTime = document.getElementById('targetTime').value.trim() || "23:59";
  const res = await fetch("/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: base64Payload, targetTime: targetTime })
  });
  
  const resData = await res.json();
  if (!res.ok) throw new Error(resData.error || "เกิดข้อผิดพลาดจากเซิร์ฟเวอร์");
  
  if (resData.fileName) {
    lastSavedFileName = resData.fileName;
    document.getElementById('btnExportPDF').style.display = 'inline-block';
  }
  
  return resData.data;
}

async function extractFromText(){
  const el = document.getElementById('pasteText');
  const statusEl = document.getElementById('textStatus');
  const txt = el.value.trim();
  if(!txt){ statusEl.textContent="กรุณาวางข้อความก่อน"; statusEl.className="status-msg err"; return; }
  statusEl.textContent="กำลังส่งให้ Gemini วิเคราะห์ข้อมูล..."; statusEl.className="status-msg";
  
  try{
    const b64Data = "data:text/plain;base64," + btoa(unescape(encodeURIComponent(txt)));
    const arr = await callExpressBackend(b64Data);
    openReview(arr);
    statusEl.textContent = \`สำเร็จ พบ \${arr.length} แถว — ตรวจสอบด้านล่าง\`; statusEl.className="status-msg ok";
  }catch(err){
    statusEl.textContent = "เกิดข้อผิดพลาด: " + err.message; statusEl.className="status-msg err";
  }
}

function fileToBase64(file){
  return new Promise((res,rej)=>{
    const r = new FileReader();
    r.onload = ()=> res(r.result);
    r.onerror = ()=> rej(new Error("อ่านไฟล์ไม่สำเร็จ"));
    r.readAsDataURL(file);
  });
}

function fileToArrayBuffer(file){
  return new Promise((res,rej)=>{
    const r = new FileReader();
    r.onload = ()=> res(r.result);
    r.onerror = ()=> rej(new Error("อ่านไฟล์ไม่สำเร็จ"));
    r.readAsArrayBuffer(file);
  });
}

// อ่านหลายไฟล์แบบวนลูป (รูปภาพ / PDF)
async function extractFromFile(inputId, kind){
  const input = document.getElementById(inputId);
  const statusEl = document.getElementById(kind==='image' ? 'imgStatus' : 'pdfStatus');
  const files = Array.from(input.files);
  
  if(files.length === 0){ 
    statusEl.textContent="กรุณาเลือกไฟล์อย่างน้อย 1 ไฟล์ก่อน"; 
    statusEl.className="status-msg err"; 
    return; 
  }

  let aggregatedResults = [];
  let successCount = 0;

  for(let i = 0; i < files.length; i++){
    const file = files[i];
    statusEl.textContent = \`กำลังอ่านและวิเคราะห์ไฟล์ที่ \${i + 1}/\${files.length}: \${file.name}...\`;
    statusEl.className = "status-msg";

    try {
      const b64Data = await fileToBase64(file);
      const arr = await callExpressBackend(b64Data);
      if(Array.isArray(arr)) {
        aggregatedResults = aggregatedResults.concat(arr);
        successCount++;
      }
    } catch(err) {
      console.error(\`เกิดข้อผิดพลาดกับไฟล์ \${file.name}:\`, err);
    }
  }

  if(aggregatedResults.length > 0) {
    openReview(aggregatedResults);
    statusEl.textContent = \`วิเคราะห์สำเร็จ \${successCount}/\${files.length} ไฟล์ (พบทั้งหมด \${aggregatedResults.length} รายการ)\`;
    statusEl.className = "status-msg ok";
  } else {
    statusEl.textContent = "ไม่สามารถประมวลผลไฟล์ที่เลือกได้ หรือไม่มีข้อมูล";
    statusEl.className = "status-msg err";
  }

  input.value = "";
}

// แปลงไฟล์ Excel/CSV เป็นข้อความ (CSV) ทุกชีต แล้วส่งเข้าเส้นทางเดียวกับ "วางข้อความ"
async function extractFromExcel(){
  const input = document.getElementById('excelFile');
  const statusEl = document.getElementById('excelStatus');
  const files = Array.from(input.files);

  if(files.length === 0){
    statusEl.textContent = "กรุณาเลือกไฟล์ Excel อย่างน้อย 1 ไฟล์ก่อน";
    statusEl.className = "status-msg err";
    return;
  }

  if(typeof XLSX === 'undefined'){
    statusEl.textContent = "โหลดไลบรารีอ่าน Excel ไม่สำเร็จ กรุณาตรวจสอบการเชื่อมต่ออินเทอร์เน็ตแล้วลองใหม่";
    statusEl.className = "status-msg err";
    return;
  }

  let aggregatedResults = [];
  let successCount = 0;

  for(let i = 0; i < files.length; i++){
    const file = files[i];
    statusEl.textContent = \`กำลังอ่านไฟล์ Excel ที่ \${i + 1}/\${files.length}: \${file.name}...\`;
    statusEl.className = "status-msg";

    try {
      const buffer = await fileToArrayBuffer(file);
      const workbook = XLSX.read(buffer, { type: 'array' });

      let combinedCsv = "";
      workbook.SheetNames.forEach(sheetName => {
        const sheet = workbook.Sheets[sheetName];
        const csv = XLSX.utils.sheet_to_csv(sheet);
        if(csv && csv.trim()){
          combinedCsv += \`### ชีต: \${sheetName} (ไฟล์: \${file.name}) ###\\n\${csv}\\n\\n\`;
        }
      });

      if(!combinedCsv.trim()){
        console.warn(\`ไม่พบข้อมูลในไฟล์ \${file.name}\`);
        continue;
      }

      const b64Data = "data:text/plain;base64," + btoa(unescape(encodeURIComponent(combinedCsv)));
      const arr = await callExpressBackend(b64Data);
      if(Array.isArray(arr)) {
        aggregatedResults = aggregatedResults.concat(arr);
        successCount++;
      }
    } catch(err) {
      console.error(\`เกิดข้อผิดพลาดกับไฟล์ \${file.name}:\`, err);
    }
  }

  if(aggregatedResults.length > 0) {
    openReview(aggregatedResults);
    statusEl.textContent = \`วิเคราะห์สำเร็จ \${successCount}/\${files.length} ไฟล์ (พบทั้งหมด \${aggregatedResults.length} รายการ)\`;
    statusEl.className = "status-msg ok";
  } else {
    statusEl.textContent = "ไม่สามารถประมวลผลไฟล์ Excel ที่เลือกได้ หรือไม่มีข้อมูล";
    statusEl.className = "status-msg err";
  }

  input.value = "";
}

function addManualRow(){
  const branch = document.getElementById('m_branch').value.trim();
  const movie = document.getElementById('m_movie').value.trim();
  const sound = document.getElementById('m_sound').value.trim() || "-";
  const screens = Number(document.getElementById('m_screens').value)||0;
  const showings = Number(document.getElementById('m_showings').value)||0;
  const revenue = Number(document.getElementById('m_revenue').value)||0;
  const seats = Number(document.getElementById('m_seats').value)||0;
  const statusEl = document.getElementById('manualStatus');
  if(!branch || !movie){ statusEl.textContent="กรุณากรอกชื่อสาขาและชื่อเรื่อง"; statusEl.className="status-msg err"; return; }
  records.push({branch, movie, sound, screens, showings, revenue, seats});
  ['m_branch','m_movie','m_sound','m_screens','m_showings','m_revenue','m_seats'].forEach(id=>document.getElementById(id).value='');
  statusEl.textContent="เพิ่มแล้ว"; statusEl.className="status-msg ok";
  renderAll();
}

function openReview(arr){
  const newItems = (arr||[]).map(r=>({
    branch: r.branch || "", 
    movie: r.movie || r.name || "",
    sound: r.sound || "-",
    screens: Number(r.screens)||0, 
    showings: Number(r.showings || r.rounds)||0,
    revenue: Number(r.revenue || r.money)||0, 
    seats: Number(r.seats || r.people)||0
  }));

  reviewBuffer = reviewBuffer.concat(newItems);

  renderReview();
  document.getElementById('reviewPanel').style.display='block';
  document.getElementById('reviewPanel').scrollIntoView({behavior:'smooth'});
}

function renderReview(){
  const t = document.getElementById('reviewTable');
  let html = \`<tr><th>สาขา</th><th>เรื่อง</th><th>ระบบ</th><th>โรง</th><th>รอบ</th><th>เงิน</th><th>ที่นั่ง</th><th></th></tr>\`;
  reviewBuffer.forEach((r,i)=>{
    html += \`<tr>
      <td><input value="\${escAttr(r.branch)}" onchange="reviewBuffer[\${i}].branch=this.value"></td>
      <td><input value="\${escAttr(r.movie)}" onchange="reviewBuffer[\${i}].movie=this.value"></td>
      <td><input class="snd" value="\${escAttr(r.sound)}" onchange="reviewBuffer[\${i}].sound=this.value"></td>
      <td><input class="num" type="number" value="\${r.screens}" onchange="reviewBuffer[\${i}].screens=Number(this.value)"></td>
      <td><input class="num" type="number" value="\${r.showings}" onchange="reviewBuffer[\${i}].showings=Number(this.value)"></td>
      <td><input class="num" type="number" value="\${r.revenue}" onchange="reviewBuffer[\${i}].revenue=Number(this.value)"></td>
      <td><input class="num" type="number" value="\${r.seats}" onchange="reviewBuffer[\${i}].seats=Number(this.value)"></td>
      <td><button class="del" onclick="removeReviewRow(\${i})">✕</button></td>
    </tr>\`;
  });
  t.innerHTML = html;
}
function escAttr(s){ return String(s).replace(/"/g,'&quot;'); }

function removeReviewRow(i){ reviewBuffer.splice(i,1); renderReview(); }

function confirmReview(){
  records = records.concat(reviewBuffer.filter(r=>r.branch && r.movie));
  reviewBuffer = [];
  document.getElementById('reviewPanel').style.display='none';
  renderAll();
}
function cancelReview(){
  reviewBuffer = [];
  document.getElementById('reviewPanel').style.display='none';
}

function resetAll(){
  if(!confirm("ยืนยันล้างข้อมูลทั้งหมด?")) return;
  records = [];
  lastSavedFileName = "";
  document.getElementById('btnExportPDF').style.display = 'none';
  renderAll();
}

function exportPDF() {
  if (!lastSavedFileName) {
    alert("ยังไม่มีไฟล์รายงานล่าสุดจาก Gemini บนระบบ");
    return;
  }
  window.open(\`/export-pdf/\${lastSavedFileName}\`, '_blank');
}

function renderAll(){
  renderSummary();
  renderBranches();
}

function renderSummary(){
  const area = document.getElementById('summaryArea');
  if(records.length===0){ area.innerHTML = \`<div class="empty">ยังไม่มีข้อมูล — เริ่มนำเข้าข้อมูลด้านบน</div>\`; return; }
  const byMovie = {};
  records.forEach(r=>{
    const key = \`\${r.movie}___\${r.sound||'-'}\`;
    if(!byMovie[key]) byMovie[key] = {movie: r.movie, sound: r.sound||'-', screens:0, showings:0, revenue:0, seats:0};
    byMovie[key].screens += r.screens;
    byMovie[key].showings += r.showings;
    byMovie[key].revenue += r.revenue;
    byMovie[key].seats += r.seats;
  });
  const rows = Object.values(byMovie).sort((a,b)=>b.revenue-a.revenue);
  let html = \`<table class="summary"><tr><th>เรื่อง / ระบบ</th><th>โรง</th><th>รอบ</th><th>เงิน (บาท)</th><th>ที่นั่ง</th></tr>\`;
  rows.forEach(v=>{
    html += \`<tr>
      <td>\${v.movie} <span class="sound-badge">\${v.sound}</span></td>
      <td class="num">\${fmt(v.screens)}</td>
      <td class="num">\${fmt(v.showings)}</td>
      <td class="num rev">\${fmt(v.revenue)}</td>
      <td class="num">\${fmt(v.seats)}</td>
    </tr>\`;
  });
  html += \`</table>\`;
  area.innerHTML = html;
}

function renderBranches(){
  const area = document.getElementById('branchArea');
  if(records.length===0){ area.innerHTML = \`<div class="empty">ยังไม่มีข้อมูล</div>\`; return; }
  const byBranch = {};
  records.forEach(r=>{
    if(!byBranch[r.branch]) byBranch[r.branch] = [];
    byBranch[r.branch].push(r);
  });
  const branchNames = Object.keys(byBranch);

  let nav = branchNames.map((b,i)=>\`<button onclick="scrollToBranch('\${cssSafe(b)}',this)" \${i===0?'class="active"':''}>\${b}</button>\`).join("");

  let scrollHtml = branchNames.map(b=>{
    const rows = byBranch[b];
    const total = rows.reduce((acc,r)=>({
      screens:acc.screens+r.screens, showings:acc.showings+r.showings,
      revenue:acc.revenue+r.revenue, seats:acc.seats+r.seats
    }),{screens:0,showings:0,revenue:0,seats:0});
    
    let rowsHtml = rows.map(r=>\`<tr>
      <td>\${r.movie} <span class="sound-badge">\${r.sound||'-'}</span></td>
      <td class="num">\${fmt(r.screens)}</td>
      <td class="num">\${fmt(r.showings)}</td>
      <td class="num rev">\${fmt(r.revenue)}</td>
      <td class="num">\${fmt(r.seats)}</td>
    </tr>\`).join("");

    return \`<div class="ticket" id="branch-\${cssSafe(b)}">
      <h3>\${b}</h3>
      <div class="totalline">รวม \${rows.length} รายการ · \${fmt(total.showings)} รอบ · \${fmt(total.revenue)} บาท · \${fmt(total.seats)} ที่นั่ง</div>
      <div class="ticket-perf"></div>
      <table><tr><th>เรื่อง / ระบบ</th><th>โรง</th><th>รอบ</th><th>เงิน</th><th>ที่นั่ง</th></tr>\${rowsHtml}</table>
    </div>\`;
  }).join("");

  area.innerHTML = \`<div class="branch-layout">
    <div class="branch-nav">\${nav}</div>
    <div class="branch-scroll" id="branchScroll">\${scrollHtml}</div>
  </div>\`;
}

function cssSafe(s){ return s.replace(/[^a-zA-Z0-9ก-๙]/g,'_'); }

function scrollToBranch(id, btn){
  const el = document.getElementById('branch-'+id);
  if(el) el.scrollIntoView({behavior:'smooth', block:'start'});
  document.querySelectorAll('.branch-nav button').forEach(b=>b.classList.remove('active'));
  if(btn) btn.classList.add('active');
}

renderAll();
</script>

</body>
</html>
  `);
});

// ── Start Server ──────────────────────────────────────────────────────────────
app.listen(3000, () => {
  console.log("🔥 Web Dashboard & Server ทำงานเรียบร้อยที่ http://localhost:3000");
});