import express from "express";
import crypto from "crypto";
import cors from "cors";
import dotenv from "dotenv";
import pkg from "pg";
import { Parser } from "json2csv";

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
  
  // Safety check: If variable is missing, warn the developer
  if (!BACKEND_URL) {
    console.error("CRITICAL: BACKEND_URL is not set in environment variables!");
    return res.status(500).json({ error: "Server configuration error" });
  }

  const { name, email, phone, profession, state, batch, amount } = req.body;

  if (!name || !email || !phone || !profession || !state || !batch) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const txnid = "TXN" + Date.now();
  const finalAmount = String(amount || "1.00");
  const productinfo = "ISML Foundation Program";
  const firstname = name;

  try {
    await pool.query(
      `INSERT INTO registrations
       (txnid, name, email, phone, profession, state, batch, amount, payment_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [txnid, name, email, phone, profession, state, batch, finalAmount, "INITIATED"]
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
    // 👇 Uses the variable strictly
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

  // 👇 STRICT: Reads only from environment variables
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
  
  // 👇 STRICT: Reads only from environment variables
  const FRONTEND_URL = process.env.FRONTEND_URL;

  if (txnid) {
    await pool.query(
      `UPDATE registrations
       SET payment_status = 'FAILED'
       WHERE txnid = $1`,
      [txnid]
    );
  }

  // If FRONTEND_URL is missing, this line will fail, so ensure it is set!
  res.redirect(FRONTEND_URL ? `${FRONTEND_URL}/failure` : "/");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});