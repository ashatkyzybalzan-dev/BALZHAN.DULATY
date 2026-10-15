import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const COUNTER_FILE = path.join(DATA_DIR, "visitors.json");
const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.GROQ_API_KEY || "";
const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";
const mime = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon"
};
const rate = new Map();

async function readCounter() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try { return JSON.parse(await fs.readFile(COUNTER_FILE, "utf8")); }
  catch { return { totalVisits: 0 }; }
}
async function saveCounter(data) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(COUNTER_FILE, JSON.stringify(data, null, 2), "utf8");
}
function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(data));
}
async function body(req, max = 12000) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > max) throw new Error("REQUEST_TOO_LARGE");
  }
  return JSON.parse(raw || "{}");
}
function rateAllowed(req) {
  // IP is used only in process memory for a short rate-limit window; it is not written to disk.
  const ip = req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const existing = rate.get(ip) || { start: now, count: 0 };
  if (now - existing.start > 60_000) { existing.start = now; existing.count = 0; }
  existing.count += 1;
  rate.set(ip, existing);
  return existing.count <= 18;
}
async function askAI({ message, mode, language, history = [] }) {
  if (!API_KEY) {
    const error = new Error("AI_NOT_CONFIGURED");
    error.status = 503;
    throw error;
  }
  const modes = {
    tutor: "You are Dulati Lingua AI, a patient multilingual language tutor. Reply in Kazakh unless the user asks otherwise. Explain clearly, give examples, and ask a helpful follow-up when appropriate.",
    dictionary: "You are a careful multilingual dictionary. Explain the queried word in Kazakh. Give all common meanings by part of speech, translations, nuance, 2-4 examples with translations, common phrases, and pronunciation if known. If the word is ambiguous, explain each likely meaning. Mention if a meaning depends on context. Do not claim truly exhaustive coverage.",
    grammar: "You are a friendly grammar teacher. Explain the grammar point in Kazakh, give a simple structure/formula, examples, common mistakes, and a short 3-question practice quiz with answers hidden until requested.",
    speaking: "You are a supportive speaking-practice coach. Simulate a realistic conversation in the target language, one turn at a time. Correct the user's sentence gently: show corrected version, briefly explain in Kazakh, then continue the conversation. Keep the learner talking.",
    wellbeing: "You are a supportive wellbeing check-in assistant, NOT a psychologist, therapist, doctor, or emergency service. Respond empathetically in Kazakh unless the user uses another language. Offer gentle grounding, reflection questions, and practical low-risk coping ideas. Do not diagnose or claim confidentiality. Encourage reaching out to a trusted adult, school counsellor, or qualified professional for persistent distress. If the user suggests immediate danger or self-harm, respond supportively, encourage telling a trusted adult immediately and contacting local emergency services; do not provide harmful details."
  };
  const safeHistory = Array.isArray(history) ? history.slice(-8).filter(x =>
    x && ["user","assistant"].includes(x.role) && typeof x.content === "string"
  ).map(x => ({ role: x.role, content: x.content.slice(0, 1800) })) : [];
  const instructions = `${modes[mode] || modes.tutor}\nTarget language: ${String(language || "English").slice(0, 50)}.\nKeep answers useful and readable. Do not claim to be human.`;
  const input = [...safeHistory, { role: "user", content: String(message || "").slice(0, 3500) }];
  const messages = [
    { role: "system", content: instructions },
    ...safeHistory,
    { role: "user", content: String(message || "").slice(0, 3500) }
  ];
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: 700, temperature: 0.7 })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    // Keep the provider's actual error in Render Logs for debugging, without exposing secrets.
    console.error("Groq API error:", response.status, data?.error?.code || "", data?.error?.message || "Unknown error");
    const error = new Error(data?.error?.message || "GROQ_REQUEST_FAILED");
    error.status = response.status === 429 ? 429 : 502;
    throw error;
  }
  const text = data?.choices?.[0]?.message?.content;
  return (typeof text === "string" && text.trim()) ? text.trim() : "Жауапты алу мүмкін болмады. Қайталап көрші.";
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/api/health") {
      return json(res, 200, { ok: true, aiConfigured: Boolean(API_KEY), provider: "Groq", model: MODEL });
    }
    if (req.method === "GET" && url.pathname === "/api/visitors") {
      const data = await readCounter();
      return json(res, 200, { totalVisits: Number(data.totalVisits) || 0 });
    }
    if (req.method === "POST" && url.pathname === "/api/visit") {
      const data = await readCounter();
      data.totalVisits = (Number(data.totalVisits) || 0) + 1;
      await saveCounter(data);
      return json(res, 200, { totalVisits: data.totalVisits });
    }
    if (req.method === "POST" && url.pathname === "/api/chat") {
      if (!rateAllowed(req)) return json(res, 429, { error: "Өте жиі сұрау жіберілді. Бір минуттан кейін қайта көр." });
      let data;
      try { data = await body(req); }
      catch (e) { return json(res, 400, { error: e.message === "REQUEST_TOO_LARGE" ? "Хабарлама тым ұзын." : "Сұрау пішімі дұрыс емес." }); }
      if (typeof data.message !== "string" || !data.message.trim()) return json(res, 400, { error: "Алдымен хабарлама жаз." });
      if (data.message.length > 3500) return json(res, 413, { error: "Хабарлама 3500 таңбадан аспауы керек." });
      try {
        const answer = await askAI(data);
        return json(res, 200, { answer });
      } catch (e) {
        const status = e.status || 502;
        const msg = e.message === "AI_NOT_CONFIGURED"
          ? "AI әлі қосылмаған. Жоба иесі серверге GROQ_API_KEY орнатуы керек."
          : status === 429 ? "AI сұранысы уақытша шектелді. Біраздан соң қайталап көр."
          : "AI қызметіне қосылу сәтсіз аяқталды. API кілтін, интернетті және есептік жазба баптауларын тексер.";
        return json(res, status, { error: msg });
      }
    }
    const safePath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const filePath = path.resolve(PUBLIC_DIR, "." + safePath);
    if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, "index.html")) {
      return json(res, 403, { error: "Forbidden" });
    }
    const content = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": mime[path.extname(filePath)] || "application/octet-stream", "X-Content-Type-Options": "nosniff" });
    res.end(content);
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: "Сервер қатесі." });
    else res.end();
  }
});
server.listen(PORT, () => console.log(`Dulati Lingua AI running at http://localhost:${PORT}`));
