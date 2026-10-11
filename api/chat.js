import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

/* ===== BLOKIR EMAIL TEMPORARY ===== */
const BLOCKED_DOMAINS = [
  "mailinator.com","tempmail.com","guerrillamail.com",
  "10minutemail.com","throwawaymail.com","yopmail.com",
  "sharklasers.com","grr.la","guerrillamailblock.com",
  "temp-mail.org","fakeinbox.com","dispostable.com",
  "mailnesia.com","trashmail.com","maildrop.cc",
  "getnada.com","mailcatch.com","tempinbox.com",
  "mintemail.com","spamgourmet.com","trash-mail.com"
];

/* ===== LIMIT PER TIER ===== */
const TIER_LIMITS = { free: 10, basic: 50, pro: 200, ultra: 500 };

/* ===== OWNER EMAIL ===== */
const OWNER_EMAIL = "uhuystudio.1@gmail.com";

/* ===== INIT FIREBASE ===== */
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

    /* ===== OWNER CHECK ===== */
    const isOwner = email === OWNER_EMAIL;

    /* ===== BLOKIR EMAIL TEMPORARY (OWNER SKIP) ===== */
    if (!isOwner) {
      const emailDomain = email.split("@")[1]?.toLowerCase();
      if (BLOCKED_DOMAINS.includes(emailDomain)) {
        return res.status(403).json({
          error: "Email temporary tidak diizinkan. Pakai email asli atau login Google."
        });
      }

      /* ===== CEK BLOCKLIST FIRESTORE ===== */
      const blockedDoc = await db.collection("blocked_emails").doc(email).get();
      if (blockedDoc.exists) {
        const reason = blockedDoc.data().reason || "Tidak disebutkan";
        return res.status(403).json({
          error: "Email kamu diblokir. Alasan: " + reason
        });
      }
    }

    /* ===== AMBIL DATA USER ===== */
    const userRef = db.collection("users").doc(email);
    const userDoc = await userRef.get();

    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    let user;

    if (!userDoc.exists) {
      user = {
        email: email,
        used: 0,
        limit: 10,
        start: now,
        premium: false,
        premiumUntil: 0,
        tier: "free"
      };
      await userRef.set(user);
    } else {
      user = userDoc.data();

      // Reset harian
      if (now - user.start > dayMs) {
        user.used = 0;
        user.start = now;
      }

      // Cek premium expired
      if (user.premium && user.premiumUntil && now > user.premiumUntil) {
        user.premium = false;
        user.tier = "free";
        user.limit = 10;
        await userRef.update({
          premium: false,
          tier: "free",
          limit: 10
        });
      }

      // Update limit sesuai tier
      const currentTier = user.tier || "free";
      const tierLimit = TIER_LIMITS[currentTier] || 10;
      if (user.limit !== tierLimit) {
        user.limit = tierLimit;
        await userRef.update({ limit: tierLimit });
      }
    }

    /* ===== CEK LIMIT (OWNER SKIP) ===== */
    if (!isOwner && user.used >= user.limit) {
      await userRef.update({ used: user.used, start: user.start });
      return res.status(429).json({
        error: "Limit harian habis",
        usage: {
          used: user.used,
          limit: user.limit,
          premium: user.premium,
          tier: user.tier
        }
      });
    }

    /* ===== VALIDASI MESSAGES ===== */
    const messages = req.body.messages || [];
    if (!messages.length) return res.status(400).json({ error: "No messages" });

    /* ===== PANGGIL GROQ ===== */
    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
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
        max_tokens: isOwner ? 8192 : 2048,
      }),
    });

    const data = await groqRes.json();

    /* ===== UPDATE USAGE ===== */
    if (groqRes.ok && !isOwner) {
      user.used++;
      await userRef.update({ used: user.used, start: user.start });
    }

    /* ===== RETURN ===== */
    return res.status(groqRes.status).json({
      ...data,
      finish_reason: data.choices && data.choices[0] ? data.choices[0].finish_reason : "stop",
      usage: {
        used: user.used,
        limit: user.limit,
        premium: user.premium,
        tier: user.tier,
        isOwner: isOwner
      }
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
 }
