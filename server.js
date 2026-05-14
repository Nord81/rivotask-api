require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      telegram_id TEXT UNIQUE NOT NULL,
      first_name TEXT DEFAULT '',
      username TEXT DEFAULT '',
      plan TEXT DEFAULT 'none',
      balance NUMERIC(12,2) DEFAULT 0,
      min_withdraw NUMERIC(12,2) DEFAULT 0,
      plan_started_at TIMESTAMPTZ,
      last_task_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS deposits (
      id SERIAL PRIMARY KEY,
      telegram_id TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS withdrawals (
      id SERIAL PRIMARY KEY,
      telegram_id TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      address TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  console.log("Database ready");
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "RivoTask API is running with PostgreSQL"
  });
});

app.post("/api/user", async (req, res) => {
  try {
    const { telegram_id, first_name, username } = req.body;

    if (!telegram_id) {
      return res.status(400).json({ ok: false, message: "telegram_id is required" });
    }

    let result = await pool.query(
      "SELECT * FROM users WHERE telegram_id=$1",
      [String(telegram_id)]
    );

    let user = result.rows[0];

    if (!user) {
      result = await pool.query(
        `INSERT INTO users (telegram_id, first_name, username)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [String(telegram_id), first_name || "", username || ""]
      );

      user = result.rows[0];
    }

    res.json({ ok: true, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Server error" });
  }
});

app.post("/api/select-plan", async (req, res) => {
  try {
    const { telegram_id, plan } = req.body;

    const plans = {
      Basic: 5,
      Plus: 20,
      Pro: 35
    };

    if (!telegram_id || !plans[plan]) {
      return res.status(400).json({ ok: false, message: "Invalid plan" });
    }

    const result = await pool.query(
      `UPDATE users
       SET plan=$1, min_withdraw=$2, plan_started_at=NOW()
       WHERE telegram_id=$3
       RETURNING *`,
      [plan, plans[plan], String(telegram_id)]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ ok: false, message: "User not found" });
    }

    res.json({ ok: true, user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Server error" });
  }
});

app.post("/api/complete-task", async (req, res) => {
  try {
    const { telegram_id } = req.body;

    if (!telegram_id) {
      return res.status(400).json({ ok: false, message: "telegram_id is required" });
    }

    const userResult = await pool.query(
      "SELECT * FROM users WHERE telegram_id=$1",
      [String(telegram_id)]
    );

    const user = userResult.rows[0];

    if (!user) {
      return res.status(404).json({ ok: false, message: "User not found" });
    }

    if (user.last_task_at) {
      const last = new Date(user.last_task_at).toISOString().slice(0, 10);
      const today = new Date().toISOString().slice(0, 10);

      if (last === today) {
        return res.status(400).json({
          ok: false,
          message: "Task already completed today"
        });
      }
    }

    let reward = 0.2;
    if (user.plan === "Basic") reward = 1.2;
    if (user.plan === "Plus") reward = 8.2;
    if (user.plan === "Pro") reward = 12;

    const updated = await pool.query(
      `UPDATE users
       SET balance = balance + $1, last_task_at = NOW()
       WHERE telegram_id=$2
       RETURNING *`,
      [reward, String(telegram_id)]
    );

    res.json({
      ok: true,
      reward,
      user: updated.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Server error" });
  }
});

app.post("/api/deposit", async (req, res) => {
  try {
    const { telegram_id, tx_hash } = req.body;

    if (!telegram_id || !tx_hash) {
      return res.status(400).json({
        ok: false,
        message: "telegram_id and tx_hash are required"
      });
    }

    const result = await pool.query(
      `INSERT INTO deposits (telegram_id, tx_hash)
       VALUES ($1, $2)
       RETURNING *`,
      [String(telegram_id), tx_hash]
    );

    res.json({
      ok: true,
      deposit: result.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Server error" });
  }
});

app.post("/api/withdraw", async (req, res) => {
  try {
    const { telegram_id, amount, address } = req.body;
    const numericAmount = Number(amount);

    if (!telegram_id || !numericAmount || !address) {
      return res.status(400).json({
        ok: false,
        message: "telegram_id, amount and address are required"
      });
    }

    const userResult = await pool.query(
      "SELECT * FROM users WHERE telegram_id=$1",
      [String(telegram_id)]
    );

    const user = userResult.rows[0];

    if (!user) {
      return res.status(404).json({ ok: false, message: "User not found" });
    }

    if (user.plan === "none") {
      return res.status(400).json({ ok: false, message: "Select a plan first" });
    }

    if (numericAmount < Number(user.min_withdraw)) {
      return res.status(400).json({
        ok: false,
        message: "Amount below minimum withdrawal"
      });
    }

    if (numericAmount > Number(user.balance)) {
      return res.status(400).json({
        ok: false,
        message: "Insufficient balance"
      });
    }

    await pool.query("BEGIN");

    const withdrawal = await pool.query(
      `INSERT INTO withdrawals (telegram_id, amount, address)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [String(telegram_id), numericAmount, address]
    );

    const updatedUser = await pool.query(
      `UPDATE users
       SET balance = balance - $1
       WHERE telegram_id=$2
       RETURNING *`,
      [numericAmount, String(telegram_id)]
    );

    await pool.query("COMMIT");

    res.json({
      ok: true,
      withdrawal: withdrawal.rows[0],
      user: updatedUser.rows[0]
    });
  } catch (err) {
    await pool.query("ROLLBACK").catch(() => {});
    console.error(err);
    res.status(500).json({ ok: false, message: "Server error" });
  }
});

app.get("/api/admin", async (req, res) => {
  try {
    const users = await pool.query("SELECT * FROM users ORDER BY id ASC");
    const deposits = await pool.query("SELECT * FROM deposits ORDER BY id DESC");
    const withdrawals = await pool.query("SELECT * FROM withdrawals ORDER BY id DESC");

    res.json({
      ok: true,
      data: {
        users: users.rows,
        deposits: deposits.rows,
        withdrawals: withdrawals.rows
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Server error" });
  }
});

initDB()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`RivoTask API running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Database init failed:", err);
    process.exit(1);
  });