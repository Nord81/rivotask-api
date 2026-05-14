require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is missing");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false }
});

const PLANS = {
  Basic: {
    min_withdraw: 5,
    reward: 1.2
  },
  Plus: {
    min_withdraw: 20,
    reward: 8.2
  },
  Pro: {
    min_withdraw: 35,
    reward: 12
  }
};

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

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS pending_plan TEXT DEFAULT 'none'
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS pending_min_withdraw NUMERIC(12,2) DEFAULT 0
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS last_withdrawal_at TIMESTAMPTZ
  `);

  await pool.query(`
    ALTER TABLE deposits
    ADD COLUMN IF NOT EXISTS requested_plan TEXT DEFAULT 'none'
  `);

  console.log("Database ready");
}

function requireAdmin(req, res, next) {
  const key = req.query.key || req.headers["x-admin-key"];

  if (!process.env.ADMIN_KEY) {
    return res.status(500).json({
      ok: false,
      message: "ADMIN_KEY is missing"
    });
  }

  if (key !== process.env.ADMIN_KEY) {
    return res.status(401).json({
      ok: false,
      message: "Unauthorized"
    });
  }

  next();
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
      return res.status(400).json({
        ok: false,
        message: "telegram_id is required"
      });
    }

    let result = await pool.query(
      "SELECT * FROM users WHERE telegram_id = $1",
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

    res.json({
      ok: true,
      user
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      ok: false,
      message: "Server error"
    });
  }
});

app.post("/api/select-plan", async (req, res) => {
  try {
    const { telegram_id, plan } = req.body;

    if (!telegram_id || !PLANS[plan]) {
      return res.status(400).json({
        ok: false,
        message: "Invalid plan"
      });
    }

    const result = await pool.query(
      `UPDATE users
       SET pending_plan = $1,
           pending_min_withdraw = $2
       WHERE telegram_id = $3
       RETURNING *`,
      [plan, PLANS[plan].min_withdraw, String(telegram_id)]
    );

    if (!result.rows[0]) {
      return res.status(404).json({
        ok: false,
        message: "User not found"
      });
    }

    res.json({
      ok: true,
      message: "Plan selected. Deposit approval required.",
      user: result.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      ok: false,
      message: "Server error"
    });
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

    const userResult = await pool.query(
      "SELECT * FROM users WHERE telegram_id = $1",
      [String(telegram_id)]
    );

    const user = userResult.rows[0];

    if (!user) {
      return res.status(404).json({
        ok: false,
        message: "User not found"
      });
    }

    if (!user.pending_plan || user.pending_plan === "none") {
      return res.status(400).json({
        ok: false,
        message: "Select a plan before submitting deposit"
      });
    }

    const result = await pool.query(
      `INSERT INTO deposits (telegram_id, tx_hash, requested_plan)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [String(telegram_id), tx_hash, user.pending_plan]
    );

    res.json({
      ok: true,
      deposit: result.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      ok: false,
      message: "Server error"
    });
  }
});

app.post("/api/complete-task", async (req, res) => {
  try {
    const { telegram_id } = req.body;

    if (!telegram_id) {
      return res.status(400).json({
        ok: false,
        message: "telegram_id is required"
      });
    }

    const userResult = await pool.query(
      "SELECT * FROM users WHERE telegram_id = $1",
      [String(telegram_id)]
    );

    const user = userResult.rows[0];

    if (!user) {
      return res.status(404).json({
        ok: false,
        message: "User not found"
      });
    }

    if (user.plan === "none") {
      return res.status(400).json({
        ok: false,
        message: "Plan is not active yet"
      });
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

    const reward = PLANS[user.plan]?.reward || 0.2;

    const updated = await pool.query(
      `UPDATE users
       SET balance = balance + $1,
           last_task_at = NOW()
       WHERE telegram_id = $2
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
    res.status(500).json({
      ok: false,
      message: "Server error"
    });
  }
});

app.post("/api/withdraw", async (req, res) => {
  try {
    const { telegram_id, amount, address } = req.body;
    const numericAmount = Number(amount);

    if (!telegram_id || !numericAmount || numericAmount <= 0 || !address) {
      return res.status(400).json({
        ok: false,
        message: "telegram_id, amount and address are required"
      });
    }

    const userResult = await pool.query(
      "SELECT * FROM users WHERE telegram_id = $1",
      [String(telegram_id)]
    );

    const user = userResult.rows[0];

    if (!user) {
      return res.status(404).json({
        ok: false,
        message: "User not found"
      });
    }

    if (user.plan === "none") {
      return res.status(400).json({
        ok: false,
        message: "Select a plan first"
      });
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

    const pendingWithdrawal = await pool.query(
      `SELECT id FROM withdrawals
       WHERE telegram_id = $1 AND status = 'pending'
       LIMIT 1`,
      [String(telegram_id)]
    );

    if (pendingWithdrawal.rows[0]) {
      return res.status(400).json({
        ok: false,
        message: "You already have a pending withdrawal"
      });
    }

    if (user.last_withdrawal_at) {
      const lastWithdrawalTime = new Date(user.last_withdrawal_at).getTime();
      const threeDays = 3 * 24 * 60 * 60 * 1000;
      const nextAllowedTime = lastWithdrawalTime + threeDays;

      if (Date.now() < nextAllowedTime) {
        const remainingMs = nextAllowedTime - Date.now();
        const remainingHours = Math.ceil(remainingMs / (60 * 60 * 1000));

        return res.status(400).json({
          ok: false,
          message: `You can withdraw again after ${remainingHours} hours`
        });
      }
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
       WHERE telegram_id = $2
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

    res.status(500).json({
      ok: false,
      message: "Server error"
    });
  }
});

app.post("/api/admin/deposits/:id/approve", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    await pool.query("BEGIN");

    const depositResult = await pool.query(
      `UPDATE deposits
       SET status = 'approved'
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [id]
    );

    const deposit = depositResult.rows[0];

    if (!deposit) {
      await pool.query("ROLLBACK");

      return res.status(404).json({
        ok: false,
        message: "Deposit not found or already processed"
      });
    }

    const planName = deposit.requested_plan;

    if (!PLANS[planName]) {
      await pool.query("ROLLBACK");

      return res.status(400).json({
        ok: false,
        message: "Invalid requested plan"
      });
    }

    const userResult = await pool.query(
      `UPDATE users
       SET plan = $1,
           min_withdraw = $2,
           plan_started_at = NOW(),
           pending_plan = 'none',
           pending_min_withdraw = 0
       WHERE telegram_id = $3
       RETURNING *`,
      [planName, PLANS[planName].min_withdraw, deposit.telegram_id]
    );

    await pool.query("COMMIT");

    res.json({
      ok: true,
      deposit,
      user: userResult.rows[0]
    });
  } catch (err) {
    await pool.query("ROLLBACK").catch(() => {});
    console.error(err);

    res.status(500).json({
      ok: false,
      message: "Server error"
    });
  }
});

app.post("/api/admin/deposits/:id/reject", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    await pool.query("BEGIN");

    const result = await pool.query(
      `UPDATE deposits
       SET status = 'rejected'
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [id]
    );

    const deposit = result.rows[0];

    if (!deposit) {
      await pool.query("ROLLBACK");

      return res.status(404).json({
        ok: false,
        message: "Deposit not found or already processed"
      });
    }

    await pool.query(
      `UPDATE users
       SET pending_plan = 'none',
           pending_min_withdraw = 0
       WHERE telegram_id = $1`,
      [deposit.telegram_id]
    );

    await pool.query("COMMIT");

    res.json({
      ok: true,
      deposit
    });
  } catch (err) {
    await pool.query("ROLLBACK").catch(() => {});
    console.error(err);

    res.status(500).json({
      ok: false,
      message: "Server error"
    });
  }
});

app.post("/api/admin/withdrawals/:id/approve", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    await pool.query("BEGIN");

    const result = await pool.query(
      `UPDATE withdrawals
       SET status = 'approved'
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [id]
    );

    const withdrawal = result.rows[0];

    if (!withdrawal) {
      await pool.query("ROLLBACK");

      return res.status(404).json({
        ok: false,
        message: "Withdrawal not found or already processed"
      });
    }

    await pool.query(
      `UPDATE users
       SET last_withdrawal_at = NOW()
       WHERE telegram_id = $1`,
      [withdrawal.telegram_id]
    );

    await pool.query("COMMIT");

    res.json({
      ok: true,
      withdrawal
    });
  } catch (err) {
    await pool.query("ROLLBACK").catch(() => {});
    console.error(err);

    res.status(500).json({
      ok: false,
      message: "Server error"
    });
  }
});

app.post("/api/admin/withdrawals/:id/reject", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    await pool.query("BEGIN");

    const withdrawalResult = await pool.query(
      `UPDATE withdrawals
       SET status = 'rejected'
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [id]
    );

    const withdrawal = withdrawalResult.rows[0];

    if (!withdrawal) {
      await pool.query("ROLLBACK");

      return res.status(404).json({
        ok: false,
        message: "Withdrawal not found or already processed"
      });
    }

    await pool.query(
      `UPDATE users
       SET balance = balance + $1
       WHERE telegram_id = $2`,
      [withdrawal.amount, withdrawal.telegram_id]
    );

    await pool.query("COMMIT");

    res.json({
      ok: true,
      withdrawal
    });
  } catch (err) {
    await pool.query("ROLLBACK").catch(() => {});
    console.error(err);

    res.status(500).json({
      ok: false,
      message: "Server error"
    });
  }
});

app.get("/api/admin", requireAdmin, async (req, res) => {
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

    res.status(500).json({
      ok: false,
      message: "Server error"
    });
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