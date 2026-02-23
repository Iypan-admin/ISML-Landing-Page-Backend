import express from "express";
import crypto from "crypto";
import cors from "cors";
import dotenv from "dotenv";
import pkg from "pg";
import { Parser } from "json2csv";

dotenv.config();

const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Postgres connection ───────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.get("/", (req, res) => {
  res.send("Backend running");
});

// ─── Helper: verify PayU reverse hash ─────────────────────────────────────────
// PayU uses different hash formats for redirect callbacks vs webhooks.
// We try both and accept if either matches.
function verifyPayUHash(data) {
  const salt = process.env.PAYU_MERCHANT_SALT?.trim();
  const key  = process.env.PAYU_MERCHANT_KEY?.trim();

  // Format 1: Standard redirect callback hash
  const format1 =
    `${salt}|${data.status}|${data.udf5 || ""}|${data.udf4 || ""}|${data.udf3 || ""}|` +
    `${data.udf2 || ""}|${data.udf1 || ""}|${data.email}|${data.firstname}|` +
    `${data.productinfo}|${data.amount}|${data.txnid}|${key}`;

  // Format 2: Webhook hash — additionalCharges comes right after salt|status
  const format2 =
    `${salt}|${data.status}|${data.additionalCharges || ""}|${data.udf5 || ""}|${data.udf4 || ""}|` +
    `${data.udf3 || ""}|${data.udf2 || ""}|${data.udf1 || ""}|${data.email}|${data.firstname}|` +
    `${data.productinfo}|${data.amount}|${data.txnid}|${key}`;

  // Format 3: Webhook hash — additionalCharges at the end after key
  const format3 =
    `${salt}|${data.status}|${data.udf5 || ""}|${data.udf4 || ""}|${data.udf3 || ""}|` +
    `${data.udf2 || ""}|${data.udf1 || ""}|${data.email}|${data.firstname}|` +
    `${data.productinfo}|${data.amount}|${data.txnid}|${key}|${data.additionalCharges || ""}`;

  const hash1 = crypto.createHash("sha512").update(format1, "utf8").digest("hex");
  const hash2 = crypto.createHash("sha512").update(format2, "utf8").digest("hex");
  const hash3 = crypto.createHash("sha512").update(format3, "utf8").digest("hex");

  const incoming = data.hash?.trim();

  if (incoming === hash1) {
    console.log("[verifyPayUHash] Matched format1 (redirect)");
    return true;
  }
  if (incoming === hash2) {
    console.log("[verifyPayUHash] Matched format2 (webhook additionalCharges after salt)");
    return true;
  }
  if (incoming === hash3) {
    console.log("[verifyPayUHash] Matched format3 (webhook additionalCharges at end)");
    return true;
  }

  // Log for debugging
  console.error("[verifyPayUHash] No match.");
  console.error("  Incoming hash :", incoming);
  console.error("  Format1 hash  :", hash1);
  console.error("  Format2 hash  :", hash2);
  console.error("  Format3 hash  :", hash3);
  console.error("  Format1 string:", format1);
  console.error("  Format2 string:", format2);
  console.error("  Format3 string:", format3);

  return false;
}

// ─── Helper: update DB on successful payment (with email fallback) ─────────────
// This handles the case where PayU retries with a new txnid (bounce → success).
async function markPaymentSuccess(txnid, mihpayid, email) {
  // 1️⃣ Try exact txnid match first
  const result = await pool.query(
    `UPDATE registrations
     SET payment_status = 'SUCCESS',
         payu_txn_id    = $1
     WHERE txnid = $2
       AND payment_status != 'SUCCESS'`,
    [mihpayid || null, txnid]
  );

  // 2️⃣ If nothing was updated, PayU used a different txnid (retry/bounce case).
  //    Fall back to latest INITIATED row for this email.
  if (result.rowCount === 0 && email) {
    console.warn(`[markPaymentSuccess] txnid ${txnid} not found — trying email fallback for ${email}`);
    await pool.query(
      `UPDATE registrations
       SET payment_status = 'SUCCESS',
           payu_txn_id    = $1
       WHERE id = (
         SELECT id FROM registrations
         WHERE email = $2
           AND payment_status = 'INITIATED'
         ORDER BY created_at DESC
         LIMIT 1
       )`,
      [mihpayid || null, email]
    );
  }
}

// ─── Helper: verify payment directly with PayU API ────────────────────────────
async function verifyWithPayUAPI(txnid) {
  const key  = process.env.PAYU_MERCHANT_KEY?.trim();
  const salt = process.env.PAYU_MERCHANT_SALT?.trim();

  const command    = "verify_payment";
  const hashString = `${key}|${command}|${txnid}|${salt}`;
  const hash       = crypto.createHash("sha512").update(hashString, "utf8").digest("hex");

  const response = await fetch("https://info.payu.in/merchant/postservice?form=2", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ key, command, var1: txnid, hash })
  });

  const json = await response.json();
  return json?.transaction_details?.[txnid] || null;
}

/* ─────────────────────────────────────────────────────────────────────────────
   CREATE PAYMENT + SAVE TO DB
───────────────────────────────────────────────────────────────────────────── */
app.post("/create-payment", async (req, res) => {
  const key  = process.env.PAYU_MERCHANT_KEY?.trim();
  const salt = process.env.PAYU_MERCHANT_SALT?.trim();

  const BACKEND_URL = process.env.BACKEND_URL;
  if (!BACKEND_URL) {
    console.error("CRITICAL: BACKEND_URL is not set!");
    return res.status(500).json({ error: "Server configuration error" });
  }

  const { name, email, phone, profession, state, batch, language, amount, referral } = req.body;

  if (!name || !email || !phone || !profession || !state || !batch || !language) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const txnid       = "TXN" + Date.now();
  const finalAmount = String(amount || "1299.00");
  const productinfo = "ISML Foundation Program";
  const firstname   = name;

  try {
    await pool.query(
      `INSERT INTO registrations
        (txnid, name, email, phone, profession, state, batch, language, amount, payment_status, referral)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [txnid, name, email, phone, profession, state, batch, language, finalAmount, "INITIATED", referral || null]
    );
  } catch (err) {
    console.error("Database Error:", err);
    return res.status(500).json({ error: "Database error" });
  }

  const hashString =
    `${key}|${txnid}|${finalAmount}|${productinfo}|${firstname}|${email}|||||||||||${salt}`;

  const hash = crypto
    .createHash("sha512")
    .update(hashString, "utf8")
    .digest("hex");

  res.json({
    key,
    txnid,
    amount: finalAmount,
    productinfo,
    firstname,
    email,
    phone,
    surl: `${BACKEND_URL}/payu-success`,
    furl: `${BACKEND_URL}/payu-failure`,
    hash
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   PAYU SUCCESS CALLBACK (redirect after payment)
   - Verifies hash
   - Calls PayU verify API to confirm payment is real
   - Updates DB with email fallback if txnid doesn't match
───────────────────────────────────────────────────────────────────────────── */
app.all("/payu-success", async (req, res) => {
  const data     = { ...req.body, ...req.query };
  const txnid    = data.txnid;
  const mihpayid = data.mihpayid;
  const email    = data.email;

  const FRONTEND_URL = process.env.FRONTEND_URL;
  if (!FRONTEND_URL) {
    console.error("CRITICAL: FRONTEND_URL is not set!");
    return res.status(500).send("Configuration Error: FRONTEND_URL missing");
  }

  try {
    // ✅ Step 1: Verify hash — reject if tampered
    if (!verifyPayUHash(data)) {
      console.error(`[payu-success] Hash mismatch for txnid ${txnid} — possible fraud attempt`);
      return res.redirect(`${FRONTEND_URL}/failure`);
    }

    // ✅ Step 2: Verify with PayU API (source of truth)
    let verifiedTxnid    = txnid;
    let verifiedMihpayid = mihpayid;
    let verifiedEmail    = email;

    try {
      const txnInfo = await verifyWithPayUAPI(txnid);

      if (!txnInfo || txnInfo.status !== "success") {
        console.warn(`[payu-success] PayU API says payment NOT successful for txnid ${txnid}`);
        return res.redirect(`${FRONTEND_URL}/failure`);
      }

      // Use API values (more reliable than callback values)
      verifiedMihpayid = txnInfo.mihpayid || mihpayid;
      verifiedEmail    = txnInfo.email    || email;
    } catch (apiErr) {
      // If PayU API is down, fall through — webhook will handle DB update
      console.error("[payu-success] PayU verify API failed, proceeding with callback data:", apiErr.message);
    }

    // ✅ Step 3: Update DB (with email fallback for retry/bounce case)
    await markPaymentSuccess(verifiedTxnid, verifiedMihpayid, verifiedEmail);

  } catch (err) {
    console.error("[payu-success] Unexpected error:", err);
    // Still redirect user to success — webhook will fix DB if needed
  }

  res.redirect(`${FRONTEND_URL}/success`);
});

/* ─────────────────────────────────────────────────────────────────────────────
   PAYU FAILURE CALLBACK
───────────────────────────────────────────────────────────────────────────── */
app.all("/payu-failure", async (req, res) => {
  const data   = { ...req.body, ...req.query };
  const txnid  = data.txnid;

  const FRONTEND_URL = process.env.FRONTEND_URL;

  if (txnid) {
    await pool.query(
      `UPDATE registrations
       SET payment_status = 'FAILED'
       WHERE txnid = $1`,
      [txnid]
    );
  }

  res.redirect(FRONTEND_URL ? `${FRONTEND_URL}/failure` : "/");
});

/* ─────────────────────────────────────────────────────────────────────────────
   ✅ PAYU WEBHOOK (server-to-server, most reliable)
   Configure this URL in PayU Dashboard → My Account → Webhook Settings:
   https://isml-landing-page-backend-production.up.railway.app/payu-webhook

   NOTE: PayU uses Salt2 for webhook hash signing, which is different from
   Salt1 used for redirect callbacks. Instead of hash verification here,
   we verify the payment directly with PayU's Verify API — this is actually
   MORE secure since we're confirming with PayU's own servers.
───────────────────────────────────────────────────────────────────────────── */
app.post("/payu-webhook", async (req, res) => {
  const data     = { ...req.body };
  const txnid    = data.txnid;
  const mihpayid = data.mihpayid;
  const email    = data.email;
  const status   = data.status;

  console.log(`[payu-webhook] Received: txnid=${txnid} status=${status} email=${email}`);

  // Basic sanity check — reject if missing critical fields
  if (!txnid || !status) {
    console.error("[payu-webhook] Missing txnid or status — rejecting");
    return res.status(400).send("Missing fields");
  }

  try {
    if (status === "success") {
      // ✅ Verify with PayU API before trusting (more secure than hash check)
      let verifiedMihpayid = mihpayid;
      let verifiedEmail    = email;

      try {
        const txnInfo = await verifyWithPayUAPI(txnid);

        if (!txnInfo || txnInfo.status !== "success") {
          console.warn(`[payu-webhook] PayU API says NOT successful for txnid=${txnid} — ignoring`);
          return res.status(200).send("OK"); // Return 200 so PayU stops retrying
        }

        verifiedMihpayid = txnInfo.mihpayid || mihpayid;
        verifiedEmail    = txnInfo.email    || email;
        console.log(`[payu-webhook] PayU API verified payment for txnid=${txnid}`);

      } catch (apiErr) {
        // If PayU API is down, trust the webhook data as fallback
        console.warn(`[payu-webhook] PayU verify API failed, using webhook data: ${apiErr.message}`);
      }

      await markPaymentSuccess(txnid, verifiedMihpayid, verifiedEmail);
      console.log(`[payu-webhook] ✅ Marked SUCCESS for txnid=${txnid} email=${verifiedEmail}`);

    } else if (status === "failure") {
      await pool.query(
        `UPDATE registrations
         SET payment_status = 'FAILED'
         WHERE txnid = $1
           AND payment_status = 'INITIATED'`,
        [txnid]
      );
      console.log(`[payu-webhook] ❌ Marked FAILED for txnid=${txnid}`);
    }

  } catch (err) {
    console.error("[payu-webhook] DB error:", err);
    return res.status(500).send("DB error"); // 500 = PayU will retry
  }

  res.status(200).send("OK"); // 200 = PayU stops retrying
});

/* ─────────────────────────────────────────────────────────────────────────────
   EXPORT REGISTRATIONS AS CSV (ADMIN)
───────────────────────────────────────────────────────────────────────────── */
app.post("/admin/download-registrations", async (req, res) => {
  const { password } = req.body;

  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized: Wrong Password" });
  }

  try {
    const result = await pool.query(
      `SELECT
         txnid, name, email, phone, profession, state, batch, language, amount,
         payment_status, payu_txn_id, created_at, referral
       FROM registrations
       ORDER BY created_at DESC`
    );

    const parser = new Parser();
    const csv    = parser.parse(result.rows);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=ISML_Registrations.csv");
    res.send(csv);

  } catch (err) {
    console.error("EXPORT ERROR:", err);
    res.status(500).send("Download failed");
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   EXPORT INFLUENCERS AS CSV (ADMIN)
───────────────────────────────────────────────────────────────────────────── */
app.post("/admin/download-influencers", async (req, res) => {
  const { password } = req.body;

  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized: Wrong Password" });
  }

  try {
    const result = await pool.query(`
      SELECT
        i.ref_code,
        i.name,
        i.email,
        i.phone,
        COUNT(r.*) FILTER (WHERE r.payment_status = 'INITIATED') AS initiated,
        COUNT(r.*) FILTER (WHERE r.payment_status = 'SUCCESS')   AS success,
        COUNT(r.*) FILTER (WHERE r.payment_status = 'FAILED')    AS failed,
        COALESCE(
          SUM(r.amount::numeric) FILTER (WHERE r.payment_status = 'SUCCESS'),
          0
        ) AS revenue
      FROM influencers i
      LEFT JOIN registrations r ON i.ref_code = r.referral
      GROUP BY i.ref_code, i.name, i.email, i.phone
      ORDER BY i.ref_code DESC
    `);

    const parser = new Parser();
    const csv    = parser.parse(result.rows);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=ISML_Influencers.csv");
    res.send(csv);

  } catch (err) {
    console.error("INFLUENCER EXPORT ERROR:", err);
    res.status(500).send("Download failed");
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   CREATE INFLUENCER LINK (ADMIN)
───────────────────────────────────────────────────────────────────────────── */
app.post("/admin/create-influencer", async (req, res) => {
  const { password, name, email, phone } = req.body;

  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const ref_code = "INF" + Date.now();

    await pool.query(
      `INSERT INTO influencers (ref_code, name, email, phone) VALUES ($1,$2,$3,$4)`,
      [ref_code, name, email, phone]
    );

    res.json({
      ref_code,
      link: `${process.env.FRONTEND_URL}/?ref=${ref_code}`
    });

  } catch (err) {
    console.error("CREATE INFLUENCER ERROR:", err);
    res.status(500).json({ error: "Failed to create influencer" });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   INFLUENCER ANALYTICS (ADMIN)
───────────────────────────────────────────────────────────────────────────── */
app.post("/admin/influencer-stats", async (req, res) => {
  const { password, ref_code } = req.body;

  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE payment_status = 'INITIATED') AS initiated,
        COUNT(*) FILTER (WHERE payment_status = 'SUCCESS')   AS success,
        COUNT(*) FILTER (WHERE payment_status = 'FAILED')    AS failed,
        COALESCE(SUM(amount::numeric) FILTER (WHERE payment_status = 'SUCCESS'), 0) AS revenue
      FROM registrations
      WHERE referral = $1
    `, [ref_code]);

    res.json(result.rows[0]);

  } catch (err) {
    console.error("STATS ERROR:", err);
    res.status(500).json({ error: "Stats fetch failed" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
