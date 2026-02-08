import express from "express";
import crypto from "crypto";
import cors from "cors";
import dotenv from "dotenv";
import pkg from "pg";
import { Parser } from "json2csv"; // Imported once at the top

// Load environment variables from .env file (for local development)
dotenv.config();

const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 🔹 Postgres connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.get("/", (req, res) => {
  res.send("Backend running");
});

/* Create PayU payment + SAVE DATA */
app.post("/create-payment", async (req, res) => {
  const key = process.env.PAYU_MERCHANT_KEY?.trim();
  const salt = process.env.PAYU_MERCHANT_SALT?.trim();

  // 👇 STRICT: Reads only from environment variables
  const BACKEND_URL = process.env.BACKEND_URL; 
  
  if (!BACKEND_URL) {
    console.error("CRITICAL: BACKEND_URL is not set in environment variables!");
    return res.status(500).json({ error: "Server configuration error" });
  }

 const { name, email, phone, profession, state, batch, language, amount } = req.body;

  if (!name || !email || !phone || !profession || !state || !batch || !language) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const txnid = "TXN" + Date.now();
  const finalAmount = String(amount || "1299.00");
  const productinfo = "ISML Foundation Program";
  const firstname = name;

  try {
    await pool.query(
      `INSERT INTO registrations
       (txnid, name, email, phone, profession, state, batch, language, amount, payment_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [txnid, name, email, phone, profession, state, batch, language, finalAmount, "INITIATED"]
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

/* PayU success callback */
app.all("/payu-success", async (req, res) => {
  const data = { ...req.body, ...req.query };
  const txnid = data.txnid;
  const mihpayid = data.mihpayid;
  const status = data.status;

  const FRONTEND_URL = process.env.FRONTEND_URL;

  if (!FRONTEND_URL) {
    console.error("CRITICAL: FRONTEND_URL is not set!");
    return res.status(500).send("Configuration Error: FRONTEND_URL missing");
  }

  if (txnid && status === "success") {
    await pool.query(
      `UPDATE registrations
       SET payment_status = 'SUCCESS',
           payu_txn_id = $1
       WHERE txnid = $2`,
      [mihpayid || null, txnid]
    );
  }

  res.redirect(`${FRONTEND_URL}/success`);
});

/* PayU failure callback */
app.all("/payu-failure", async (req, res) => {
  const data = { ...req.body, ...req.query };
  const txnid = data.txnid;
  
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


/* -------------------------------------------
   EXPORT REGISTRATIONS AS CSV
   ------------------------------------------- */
app.post("/admin/download-registrations", async (req, res) => {
  const { password } = req.body;

  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized: Wrong Password" });
  }

  try {
    const result = await pool.query(
      `SELECT
        txnid, name, email, phone, profession, state, batch, language, amount,
        payment_status, payu_txn_id, created_at
       FROM registrations
       ORDER BY created_at DESC`
    );

    // Uses the top-level import "Parser"
    const parser = new Parser();
    const csv = parser.parse(result.rows);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=ISML_Registrations.csv"
    );

    res.send(csv);

  } catch (err) {
    console.error("EXPORT ERROR:", err);
    res.status(500).send("Download failed");
  }
});


/* -------------------------------------------
   CREATE INFLUENCER LINK (ADMIN)
------------------------------------------- */
app.post("/admin/create-influencer", async (req, res) => {

  const { password, name, email, phone } = req.body;

  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {

    // ⭐ Generate unique referral code
    const ref_code = "INF" + Date.now();

    await pool.query(
      `INSERT INTO influencers (ref_code, name, email, phone)
       VALUES ($1,$2,$3,$4)`,
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


/* -------------------------------------------
   INFLUENCER ANALYTICS (ADMIN)
------------------------------------------- */
app.post("/admin/influencer-stats", async (req, res) => {

  const { password, ref_code } = req.body;

  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {

    const result = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE payment_status='INITIATED') AS initiated,
        COUNT(*) FILTER (WHERE payment_status='SUCCESS') AS success,
        COALESCE(SUM(amount::numeric) FILTER (WHERE payment_status='SUCCESS'),0) AS revenue
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
