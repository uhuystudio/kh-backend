import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

function initFirebase() {
  if (getApps().length) return;
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  initializeApp({
    credential: cert(serviceAccount)
  });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    initFirebase();
    const db = getFirestore();

    const authHeader = req.headers["authorization"] || "";
    const token = authHeader.replace("Bearer ", "");
    if (!token) return res.status(401).json({ error: "No token" });

    let decoded;
    try {
      decoded = await getAuth().verifyIdToken(token);
    } catch (e) {
      return res.status(401).json({ error: "Invalid token" });
    }

    const email = decoded.email;
    const userRef = db.collection("users").doc(email);
    const userDoc = await userRef.get();

    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    let user;

    if (!userDoc.exists) {
      user = { email: email, used: 0, limit: 10, start: now, premium: false, premiumUntil: 0 };
      await userRef.set(user);
    } else {
      user = userDoc.data();
      if (now - user.start > dayMs) {
        user.used = 0;
        user.start = now;
      }
    }

    if (user.premium && now > user.premiumUntil) {
      user.premium = false;
      user.limit = 10;
    }

    if (user.used >= user.limit) {
      await userRef.update({ used: user.used, start: user.start });
      return res.status(429).json({
        error: "Limit harian habis",
        usage: { used: user.used, limit: user.limit, premium: user.premium }
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
      user.used++;
      await userRef.update({ used: user.used, start: user.start });
    }

    return res.status(response.status).json({
  ...data,
  finish_reason: data.choices && data.choices[0] ? data.choices[0].finish_reason : "stop",
  usage: { used: user.used, limit: user.limit, premium: user.premium }
});
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
