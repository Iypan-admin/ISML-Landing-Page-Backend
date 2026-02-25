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
function verifyPayUHash(data) {
  const salt = process.env.PAYU_MERCHANT_SALT?.trim();
  const key  = process.env.PAYU_MERCHANT_KEY?.trim();

  const format1 =
    `${salt}|${data.status}|${data.udf5 || ""}|${data.udf4 || ""}|${data.udf3 || ""}|` +
    `${data.udf2 || ""}|${data.udf1 || ""}|${data.email}|${data.firstname}|` +
    `${data.productinfo}|${data.amount}|${data.txnid}|${key}`;

  const format2 =
    `${salt}|${data.status}|${data.additionalCharges || ""}|${data.udf5 || ""}|${data.udf4 || ""}|` +
    `${data.udf3 || ""}|${data.udf2 || ""}|${data.udf1 || ""}|${data.email}|${data.firstname}|` +
    `${data.productinfo}|${data.amount}|${data.txnid}|${key}`;

  const format3 =
    `${salt}|${data.status}|${data.udf5 || ""}|${data.udf4 || ""}|${data.udf3 || ""}|` +
    `${data.udf2 || ""}|${data.udf1 || ""}|${data.email}|${data.firstname}|` +
    `${data.productinfo}|${data.amount}|${data.txnid}|${key}|${data.additionalCharges || ""}`;

  const hash1 = crypto.createHash("sha512").update(format1, "utf8").digest("hex");
  const hash2 = crypto.createHash("sha512").update(format2, "utf8").digest("hex");
  const hash3 = crypto.createHash("sha512").update(format3, "utf8").digest("hex");
  const incoming = data.hash?.trim();

  if (incoming === hash1) { console.log("[verifyPayUHash] Matched format1"); return true; }
  if (incoming === hash2) { console.log("[verifyPayUHash] Matched format2"); return true; }
  if (incoming === hash3) { console.log("[verifyPayUHash] Matched format3"); return true; }

  console.error("[verifyPayUHash] No match. Incoming:", incoming);
  return false;
}

// ─── Helper: verify payment with PayU API ────────────────────────────────────
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

// ─── Helper: create payout records for 2-level referral ──────────────────────
// L1 influencer (direct referrer) → ₹200
// L2 influencer (who referred L1) → ₹50
async function createPayoutRecords(txnid, customerEmail, customerName, referralCode) {
  if (!referralCode) return;

  try {
    // Get L1 influencer
    const l1Result = await pool.query(
      `SELECT ref_code, name, referred_by FROM influencers WHERE ref_code = $1`,
      [referralCode]
    );

    if (l1Result.rowCount === 0) return;
    const l1 = l1Result.rows[0];

    // Create L1 payout (₹200)
    await pool.query(
      `INSERT INTO payouts (txnid, customer_email, customer_name, influencer_ref_code, influencer_name, level, amount, status)
       VALUES ($1, $2, $3, $4, $5, 1, 200, 'PENDING')
       ON CONFLICT DO NOTHING`,
      [txnid, customerEmail, customerName, l1.ref_code, l1.name]
    );
    console.log(`[payouts] Created L1 payout ₹200 for ${l1.ref_code}`);

    // If L1 was referred by someone, create L2 payout (₹50)
    if (l1.referred_by) {
      const l2Result = await pool.query(
        `SELECT ref_code, name FROM influencers WHERE ref_code = $1`,
        [l1.referred_by]
      );

      if (l2Result.rowCount > 0) {
        const l2 = l2Result.rows[0];
        await pool.query(
          `INSERT INTO payouts (txnid, customer_email, customer_name, influencer_ref_code, influencer_name, level, amount, status)
           VALUES ($1, $2, $3, $4, $5, 2, 50, 'PENDING')
           ON CONFLICT DO NOTHING`,
          [txnid, customerEmail, customerName, l2.ref_code, l2.name]
        );
        console.log(`[payouts] Created L2 payout ₹50 for ${l2.ref_code}`);
      }
    }
  } catch (err) {
    console.error("[payouts] Error creating payout records:", err);
  }
}

// ─── Helper: mark payment success + create payouts ───────────────────────────
async function markPaymentSuccess(txnid, mihpayid, email) {
  // Try exact txnid match first
  const result = await pool.query(
    `UPDATE registrations
     SET payment_status = 'SUCCESS', payu_txn_id = $1
     WHERE txnid = $2 AND payment_status != 'SUCCESS'
     RETURNING name, referral`,
    [mihpayid || null, txnid]
  );

  let customerName = null;
  let referralCode = null;

  if (result.rowCount > 0) {
    customerName = result.rows[0].name;
    referralCode = result.rows[0].referral;
  } else if (email) {
    // Email fallback for retry/bounce case
    console.warn(`[markPaymentSuccess] txnid ${txnid} not found — trying email fallback for ${email}`);
    const fallback = await pool.query(
      `UPDATE registrations
       SET payment_status = 'SUCCESS', payu_txn_id = $1
       WHERE id = (
         SELECT id FROM registrations
         WHERE email = $2 AND payment_status = 'INITIATED'
         ORDER BY created_at DESC LIMIT 1
       )
       RETURNING name, referral`,
      [mihpayid || null, email]
    );
    if (fallback.rowCount > 0) {
      customerName = fallback.rows[0].name;
      referralCode = fallback.rows[0].referral;
    }
  }

  // Create payout records if payment was via referral
  if (referralCode) {
    await createPayoutRecords(txnid, email, customerName, referralCode);
  }
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

  const hash = crypto.createHash("sha512").update(hashString, "utf8").digest("hex");

  res.json({
    key, txnid, amount: finalAmount, productinfo, firstname, email, phone,
    surl: `${BACKEND_URL}/payu-success`,
    furl: `${BACKEND_URL}/payu-failure`,
    hash
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   PAYU SUCCESS CALLBACK
───────────────────────────────────────────────────────────────────────────── */
app.all("/payu-success", async (req, res) => {
  const data     = { ...req.body, ...req.query };
  const txnid    = data.txnid;
  const mihpayid = data.mihpayid;
  const email    = data.email;

  const FRONTEND_URL = process.env.FRONTEND_URL;
  if (!FRONTEND_URL) return res.status(500).send("FRONTEND_URL missing");

  try {
    if (!verifyPayUHash(data)) {
      console.error(`[payu-success] Hash mismatch for txnid ${txnid}`);
      return res.redirect(`${FRONTEND_URL}/failure`);
    }

    let verifiedTxnid    = txnid;
    let verifiedMihpayid = mihpayid;
    let verifiedEmail    = email;

    try {
      const txnInfo = await verifyWithPayUAPI(txnid);
      if (!txnInfo || txnInfo.status !== "success") {
        console.warn(`[payu-success] PayU API says NOT successful for txnid ${txnid}`);
        return res.redirect(`${FRONTEND_URL}/failure`);
      }
      verifiedMihpayid = txnInfo.mihpayid || mihpayid;
      verifiedEmail    = txnInfo.email    || email;
    } catch (apiErr) {
      console.error("[payu-success] PayU verify API failed:", apiErr.message);
    }

    await markPaymentSuccess(verifiedTxnid, verifiedMihpayid, verifiedEmail);
  } catch (err) {
    console.error("[payu-success] Error:", err);
  }

  res.redirect(`${FRONTEND_URL}/success`);
});

/* ─────────────────────────────────────────────────────────────────────────────
   PAYU FAILURE CALLBACK
───────────────────────────────────────────────────────────────────────────── */
app.all("/payu-failure", async (req, res) => {
  const data  = { ...req.body, ...req.query };
  const txnid = data.txnid;
  const FRONTEND_URL = process.env.FRONTEND_URL;

  if (txnid) {
    await pool.query(
      `UPDATE registrations SET payment_status = 'FAILED' WHERE txnid = $1`,
      [txnid]
    );
  }

  res.redirect(FRONTEND_URL ? `${FRONTEND_URL}/failure` : "/");
});

/* ─────────────────────────────────────────────────────────────────────────────
   PAYU WEBHOOK (server-to-server)
───────────────────────────────────────────────────────────────────────────── */
app.post("/payu-webhook", async (req, res) => {
  const data     = { ...req.body };
  const txnid    = data.txnid;
  const mihpayid = data.mihpayid;
  const email    = data.email;
  const status   = data.status;

  console.log(`[payu-webhook] Received: txnid=${txnid} status=${status} email=${email}`);

  if (!txnid || !status) {
    return res.status(400).send("Missing fields");
  }

  try {
    if (status === "success") {
      let verifiedMihpayid = mihpayid;
      let verifiedEmail    = email;

      try {
        const txnInfo = await verifyWithPayUAPI(txnid);
        if (!txnInfo || txnInfo.status !== "success") {
          console.warn(`[payu-webhook] PayU API says NOT successful for txnid=${txnid}`);
          return res.status(200).send("OK");
        }
        verifiedMihpayid = txnInfo.mihpayid || mihpayid;
        verifiedEmail    = txnInfo.email    || email;
        console.log(`[payu-webhook] PayU API verified for txnid=${txnid}`);
      } catch (apiErr) {
        console.warn(`[payu-webhook] PayU verify API failed: ${apiErr.message}`);
      }

      await markPaymentSuccess(txnid, verifiedMihpayid, verifiedEmail);
      console.log(`[payu-webhook] ✅ Marked SUCCESS for txnid=${txnid} email=${verifiedEmail}`);

    } else if (status === "failure") {
      await pool.query(
        `UPDATE registrations SET payment_status = 'FAILED'
         WHERE txnid = $1 AND payment_status = 'INITIATED'`,
        [txnid]
      );
      console.log(`[payu-webhook] ❌ Marked FAILED for txnid=${txnid}`);
    }
  } catch (err) {
    console.error("[payu-webhook] DB error:", err);
    return res.status(500).send("DB error");
  }

  res.status(200).send("OK");
});

/* ─────────────────────────────────────────────────────────────────────────────
   EXPORT REGISTRATIONS CSV (ADMIN)
───────────────────────────────────────────────────────────────────────────── */
app.post("/admin/download-registrations", async (req, res) => {
  const { password } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });

  try {
    const result = await pool.query(
      `SELECT txnid, name, email, phone, profession, state, batch, language, amount,
              payment_status, payu_txn_id, created_at, referral
       FROM registrations ORDER BY created_at DESC`
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
   GET ALL INFLUENCERS (ADMIN) — used for table view in admin dashboard
───────────────────────────────────────────────────────────────────────────── */
app.post("/admin/get-influencers", async (req, res) => {
  const { password } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });

  try {
    const result = await pool.query(`
      SELECT
        i.ref_code,
        i.name,
        i.email,
        i.phone,
        i.referred_by,
        r2.name AS referred_by_name,
        COUNT(r.*) FILTER (WHERE r.payment_status = 'INITIATED') AS initiated,
        COUNT(r.*) FILTER (WHERE r.payment_status = 'SUCCESS')   AS success,
        COUNT(r.*) FILTER (WHERE r.payment_status = 'FAILED')    AS failed,
        COALESCE(SUM(r.amount::numeric) FILTER (WHERE r.payment_status = 'SUCCESS'), 0) AS revenue,
        COALESCE((SELECT SUM(p.amount) FROM payouts p WHERE p.influencer_ref_code = i.ref_code), 0) AS total_earnings,
        COALESCE((SELECT SUM(p.amount) FROM payouts p WHERE p.influencer_ref_code = i.ref_code AND p.status = 'PENDING'), 0) AS pending_payout,
        COALESCE((SELECT SUM(p.amount) FROM payouts p WHERE p.influencer_ref_code = i.ref_code AND p.status = 'PAID'), 0) AS paid_payout
      FROM influencers i
      LEFT JOIN registrations r ON i.ref_code = r.referral
      LEFT JOIN influencers r2 ON i.referred_by = r2.ref_code
      GROUP BY i.ref_code, i.name, i.email, i.phone, i.referred_by, r2.name
      ORDER BY i.ref_code DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("GET INFLUENCERS ERROR:", err);
    res.status(500).json({ error: "Failed to fetch influencers" });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   EXPORT INFLUENCERS CSV (ADMIN)
───────────────────────────────────────────────────────────────────────────── */
app.post("/admin/download-influencers", async (req, res) => {
  const { password } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });

  try {
    const result = await pool.query(`
      SELECT
        i.ref_code, i.name, i.email, i.phone, i.referred_by,
        COUNT(r.*) FILTER (WHERE r.payment_status = 'INITIATED') AS initiated,
        COUNT(r.*) FILTER (WHERE r.payment_status = 'SUCCESS')   AS success,
        COUNT(r.*) FILTER (WHERE r.payment_status = 'FAILED')    AS failed,
        COALESCE(SUM(r.amount::numeric) FILTER (WHERE r.payment_status = 'SUCCESS'), 0) AS revenue,
        COALESCE((SELECT SUM(p.amount) FROM payouts p WHERE p.influencer_ref_code = i.ref_code), 0) AS total_earnings,
        COALESCE((SELECT SUM(p.amount) FROM payouts p WHERE p.influencer_ref_code = i.ref_code AND p.status = 'PENDING'), 0) AS pending_payout,
        COALESCE((SELECT SUM(p.amount) FROM payouts p WHERE p.influencer_ref_code = i.ref_code AND p.status = 'PAID'), 0) AS paid_payout
      FROM influencers i
      LEFT JOIN registrations r ON i.ref_code = r.referral
      GROUP BY i.ref_code, i.name, i.email, i.phone, i.referred_by
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
   CREATE INFLUENCER (ADMIN) — now supports referred_by
───────────────────────────────────────────────────────────────────────────── */
app.post("/admin/create-influencer", async (req, res) => {
  const { password, name, email, phone, referred_by } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });

  try {
    // Validate referred_by exists if provided
    if (referred_by) {
      const check = await pool.query(`SELECT ref_code FROM influencers WHERE ref_code = $1`, [referred_by]);
      if (check.rowCount === 0) return res.status(400).json({ error: `Referrer ref_code '${referred_by}' not found` });
    }

    const ref_code = "INF" + Date.now();
    await pool.query(
      `INSERT INTO influencers (ref_code, name, email, phone, referred_by) VALUES ($1,$2,$3,$4,$5)`,
      [ref_code, name, email, phone, referred_by || null]
    );

    res.json({ ref_code, link: `${process.env.FRONTEND_URL}/?ref=${ref_code}` });
  } catch (err) {
    console.error("CREATE INFLUENCER ERROR:", err);
    res.status(500).json({ error: "Failed to create influencer" });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   EDIT INFLUENCER (ADMIN)
───────────────────────────────────────────────────────────────────────────── */
app.post("/admin/edit-influencer", async (req, res) => {
  const { password, ref_code, name, email, phone, referred_by } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });

  try {
    if (referred_by) {
      const check = await pool.query(`SELECT ref_code FROM influencers WHERE ref_code = $1`, [referred_by]);
      if (check.rowCount === 0) return res.status(400).json({ error: `Referrer ref_code '${referred_by}' not found` });
    }

    await pool.query(
      `UPDATE influencers SET name=$1, email=$2, phone=$3, referred_by=$4 WHERE ref_code=$5`,
      [name, email, phone, referred_by || null, ref_code]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("EDIT INFLUENCER ERROR:", err);
    res.status(500).json({ error: "Failed to update influencer" });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   GET PAYOUTS (ADMIN)
───────────────────────────────────────────────────────────────────────────── */
app.post("/admin/get-payouts", async (req, res) => {
  const { password, ref_code, status } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });

  try {
    let query = `SELECT * FROM payouts WHERE 1=1`;
    const params = [];

    if (ref_code) {
      params.push(ref_code);
      query += ` AND influencer_ref_code = $${params.length}`;
    }
    if (status) {
      params.push(status);
      query += ` AND status = $${params.length}`;
    }

    query += ` ORDER BY created_at DESC`;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error("GET PAYOUTS ERROR:", err);
    res.status(500).json({ error: "Failed to fetch payouts" });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   MARK PAYOUT AS PAID (ADMIN)
───────────────────────────────────────────────────────────────────────────── */
app.post("/admin/mark-payout-paid", async (req, res) => {
  const { password, payout_id } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });

  try {
    await pool.query(
      `UPDATE payouts SET status = 'PAID', paid_at = NOW() WHERE id = $1`,
      [payout_id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("MARK PAID ERROR:", err);
    res.status(500).json({ error: "Failed to mark as paid" });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   MARK ALL PAYOUTS PAID FOR AN INFLUENCER (ADMIN)
───────────────────────────────────────────────────────────────────────────── */
app.post("/admin/mark-all-paid", async (req, res) => {
  const { password, ref_code } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });

  try {
    const result = await pool.query(
      `UPDATE payouts SET status = 'PAID', paid_at = NOW()
       WHERE influencer_ref_code = $1 AND status = 'PENDING'`,
      [ref_code]
    );
    res.json({ success: true, updated: result.rowCount });
  } catch (err) {
    console.error("MARK ALL PAID ERROR:", err);
    res.status(500).json({ error: "Failed to mark payouts as paid" });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   EXPORT PAYOUTS CSV (ADMIN)
───────────────────────────────────────────────────────────────────────────── */
app.post("/admin/download-payouts", async (req, res) => {
  const { password } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });

  try {
    const result = await pool.query(
      `SELECT id, txnid, customer_name, customer_email, influencer_ref_code, influencer_name,
              level, amount, status, paid_at, created_at
       FROM payouts ORDER BY created_at DESC`
    );
    const parser = new Parser();
    const csv    = parser.parse(result.rows);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=ISML_Payouts.csv");
    res.send(csv);
  } catch (err) {
    console.error("PAYOUTS EXPORT ERROR:", err);
    res.status(500).send("Download failed");
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   INFLUENCER ANALYTICS (ADMIN)
───────────────────────────────────────────────────────────────────────────── */
app.post("/admin/influencer-stats", async (req, res) => {
  const { password, ref_code } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });

  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE payment_status = 'INITIATED') AS initiated,
        COUNT(*) FILTER (WHERE payment_status = 'SUCCESS')   AS success,
        COUNT(*) FILTER (WHERE payment_status = 'FAILED')    AS failed,
        COALESCE(SUM(amount::numeric) FILTER (WHERE payment_status = 'SUCCESS'), 0) AS revenue
      FROM registrations WHERE referral = $1
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
