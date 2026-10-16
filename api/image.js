import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

/* ===== LIMIT IMAGE PER TIER ===== */
const TIER_IMAGE_LIMITS = { free: 1, basic: 3, pro: 7, ultra: 15 };

/* ===== OWNER EMAIL ===== */
const OWNER_EMAIL = "uhuystudio.1@gmail.com";

/* ===== ANTI PROMPT TERLARANG ===== */
const IMAGE_BLOCKED_KEYWORDS = [
  "child","kids","underage","loli","shota","minor",
  "nude","naked","nsfw","porn","sex","xxx","erotic",
  "gore","blood","kill","murder","torture","beheading",
  "hitler","nazi","terrorist","isis","bomb","explosive",
  "drug","cocaine","heroin","meth","weed","marijuana",
  "bestiality","rape","incest"
];

function isBlockedPrompt(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return IMAGE_BLOCKED_KEYWORDS.some(k => lower.includes(k));
}

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

    /* ===== VERIFIKASI TOKEN ===== */
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
    if (!email) return res.status(400).json({ error: "Email tidak ditemukan" });

    const isOwner = email === OWNER_EMAIL;

    /* ===== VALIDASI PROMPT ===== */
    const prompt = (req.body.prompt || "").trim();
    if (!prompt) return res.status(400).json({ error: "Prompt kosong" });
    if (prompt.length > 500) return res.status(400).json({ error: "Prompt maksimal 500 karakter" });
    if (isBlockedPrompt(prompt)) {
      return res.status(403).json({ error: "Prompt mengandung kata yang tidak diizinkan" });
    }

    /* ===== AMBIL DATA USER ===== */
    const userRef = db.collection("users").doc(email);
    const userDoc = await userRef.get();

    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    let user;

    if (!userDoc.exists) {
      user = {
        email, used: 0, limit: 10, start: now,
        premium: false, premiumUntil: 0, tier: "free",
        imageUsed: 0, imageLimit: 1, imageStart: now
      };
      await userRef.set(user);
    } else {
      user = userDoc.data();

      // Reset limit chat harian
      if (now - (user.start || 0) > dayMs) {
        user.used = 0;
        user.start = now;
        await userRef.update({ used: 0, start: now });
      }

      // Reset limit image harian
      if (!user.imageStart || now - user.imageStart > dayMs) {
        user.imageUsed = 0;
        user.imageStart = now;
        await userRef.update({ imageUsed: 0, imageStart: now });
      }

      // Auto-create field image kalau belum ada
      if (typeof user.imageUsed !== "number" || typeof user.imageLimit !== "number") {
        const tierImg = TIER_IMAGE_LIMITS[user.tier || "free"] || 1;
        user.imageUsed = user.imageUsed || 0;
        user.imageLimit = tierImg;
        user.imageStart = user.imageStart || now;
        await userRef.update({
          imageUsed: user.imageUsed,
          imageLimit: tierImg,
          imageStart: user.imageStart
        });
      }

      // Sinkronkan imageLimit dengan tier terbaru
      const currentTierImg = TIER_IMAGE_LIMITS[user.tier || "free"] || 1;
      if (user.imageLimit !== currentTierImg) {
        user.imageLimit = currentTierImg;
        await userRef.update({ imageLimit: currentTierImg });
      }
    }

    /* ===== CEK LIMIT IMAGE (OWNER SKIP) ===== */
    if (!isOwner && user.imageUsed >= user.imageLimit) {
      const reset = new Date(user.imageStart + dayMs);
      const resetStr = String(reset.getHours()).padStart(2, "0") + ":" + String(reset.getMinutes()).padStart(2, "0");
      return res.status(429).json({
        error: "Limit gambar harian habis. Reset jam " + resetStr,
        usage: {
          imageUsed: user.imageUsed,
          imageLimit: user.imageLimit,
          tier: user.tier
        }
      });
    }

    /* ===== CEK ENV VAR ===== */
    const pollinationsKey = process.env.POLLINATIONS_KEY;
    if (!pollinationsKey) {
      return res.status(500).json({ error: "POLLINATIONS_KEY belum di-set di env Vercel" });
    }

    /* ===== BANGUN URL POLLINATIONS ===== */
    const seed = Date.now();
    const encodedPrompt = encodeURIComponent(prompt);
    const imageUrl = "https://image.pollinations.ai/prompt/" + encodedPrompt +
      "?width=1024&height=1024&model=flux&nologo=true&seed=" + seed +
      "&token=" + pollinationsKey;

    /* ===== UPDATE USAGE (OWNER SKIP) ===== */
    if (!isOwner) {
      user.imageUsed++;
      await userRef.update({
        imageUsed: user.imageUsed,
        imageStart: user.imageStart
      });
    }

    return res.status(200).json({
      url: imageUrl,
      prompt: prompt,
      seed: seed,
      usage: {
        imageUsed: user.imageUsed,
        imageLimit: user.imageLimit,
        tier: user.tier,
        isOwner: isOwner
      }
    });

  } catch (err) {
    console.error("Image error:", err);
    return res.status(500).json({ error: err.message });
  }
}
