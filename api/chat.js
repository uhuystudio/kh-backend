const users = new Map();

function getUser(ip) {
  let u = users.get(ip);
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  if (!u) {
    u = { used: 0, limit: 10, start: now };
  }

  if (now - u.start > dayMs) {
    u.used = 0;
    u.start = now;
  }

  return u;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const ip = req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || "unknown";
    const u = getUser(ip);

    if (u.used >= u.limit) {
      return res.status(429).json({
        error: "Limit harian habis",
        usage: { used: u.used, limit: u.limit }
      });
    }

    const messages = req.body.messages || [];
    if (!messages.length) return res.status(400).json({ error: "No messages" });

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + process.env.GROQ_KEY,
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-120b",
        messages: messages,
        stream: false,
        temperature: 1.0,
        max_tokens: 2048,
      }),
    });

    const data = await response.json();

    if (response.ok) {
      u.used++;
      users.set(ip, u);
    }

    return res.status(response.status).json({
      ...data,
      usage: { used: u.used, limit: u.limit }
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
