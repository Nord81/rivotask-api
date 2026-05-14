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
    price: 15,
    min_withdraw: 3,
    reward: 1.2,
    rank: 1
  },
  Plus: {
    price: 60,
    min_withdraw: 20,
    reward: 8.2,
    rank: 2
  },
  Pro: {
    price: 100,
    min_withdraw: 35,
    reward: 12,
    rank: 3
  }
};

const DEPOSIT_NETWORKS = {
  ERC20: {
    label: "Ethereum ERC20",
    address: "0x9cd168333d6c0ce4b04b08ff857aa84a4ea007a9"
  },
  POLYGON: {
    label: "Polygon USDT",
    address: "0x9cd168333d6c0ce4b04b08ff857aa84a4ea007a9"
  },
  TRC20: {
    label: "TRON TRC20",
    address: "TE7eCxxD7GGvw1MDyfYLUfHuAx4vbRmNSp"
  }
};

function getPlanRank(plan) {
  return PLANS[plan]?.rank || 0;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

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
      tx_hash TEXT,
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

  await pool.query(`
    ALTER TABLE deposits
    ADD COLUMN IF NOT EXISTS deposit_network TEXT DEFAULT 'unknown'
  `);

  await pool.query(`
    ALTER TABLE deposits
    ADD COLUMN IF NOT EXISTS required_amount NUMERIC(12,3) DEFAULT 0
  `);

  await pool.query(`
    ALTER TABLE deposits
    ADD COLUMN IF NOT EXISTS deposit_address TEXT DEFAULT ''
  `);

  await pool.query(`
    ALTER TABLE deposits
    ALTER COLUMN tx_hash DROP NOT NULL
  `).catch(() => {});

  await pool.query(`
    UPDATE users
    SET min_withdraw = 3
    WHERE plan = 'Basic'
  `);

  await pool.query(`
    UPDATE users
    SET pending_min_withdraw = 3
    WHERE pending_plan = 'Basic'
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

async function notifyAdmin(message) {
  try {
    const botToken = process.env.BOT_TOKEN;
    const adminId = process.env.ADMIN_TELEGRAM_ID;

    if (!botToken || !adminId) {
      console.log("Telegram notification skipped: BOT_TOKEN or ADMIN_TELEGRAM_ID missing");
      return;
    }

    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: adminId,
        text: message,
        parse_mode: "HTML"
      })
    });

    const data = await res.json();

    if (!data.ok) {
      console.error("Telegram notification failed:", data);
    }
  } catch (err) {
    console.error("Failed to send Telegram notification:", err.message);
  }
}

async function withTransaction(callback) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "RivoTask API is running with PostgreSQL"
  });
});

app.get("/api/deposit-networks", (req, res) => {
  res.json({
    ok: true,
    networks: DEPOSIT_NETWORKS
  });
});

app.get("/api/plans", (req, res) => {
  res.json({
    ok: true,
    plans: PLANS
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

    const currentRank = getPlanRank(user.plan);
    const requestedRank = getPlanRank(plan);

    if (requestedRank <= currentRank) {
      return res.status(400).json({
        ok: false,
        message: "You can only upgrade to a higher plan"
      });
    }

    const pendingDeposit = await pool.query(
      `SELECT id FROM deposits
       WHERE telegram_id = $1 AND status = 'pending'
       LIMIT 1`,
      [String(telegram_id)]
    );

    if (pendingDeposit.rows[0]) {
      return res.status(400).json({
        ok: false,
        message: "You already have a pending subscription request"
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

    res.json({
      ok: true,
      message: "Plan selected. Subscription request required.",
      user: result.rows[0],
      required_amount: PLANS[plan].price
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
    const { telegram_id, deposit_network } = req.body;

    if (!telegram_id || !deposit_network) {
      return res.status(400).json({
        ok: false,
        message: "telegram_id and deposit_network are required"
      });
    }

    if (!DEPOSIT_NETWORKS[deposit_network]) {
      return res.status(400).json({
        ok: false,
        message: "Invalid deposit network"
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
        message: "Select a plan before submitting subscription request"
      });
    }

    const currentRank = getPlanRank(user.plan);
    const requestedRank = getPlanRank(user.pending_plan);

    if (requestedRank <= currentRank) {
      return res.status(400).json({
        ok: false,
        message: "You can only upgrade to a higher plan"
      });
    }

    const pendingDeposit = await pool.query(
      `SELECT id FROM deposits
       WHERE telegram_id = $1 AND status = 'pending'
       LIMIT 1`,
      [String(telegram_id)]
    );

    if (pendingDeposit.rows[0]) {
      return res.status(400).json({
        ok: false,
        message: "You already have a pending subscription request"
      });
    }

    const planData = PLANS[user.pending_plan];
    const networkData = DEPOSIT_NETWORKS[deposit_network];

    const result = await pool.query(
      `INSERT INTO deposits (
        telegram_id,
        requested_plan,
        deposit_network,
        required_amount,
        deposit_address,
        status
      )
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING *`,
      [
        String(telegram_id),
        user.pending_plan,
        deposit_network,
        planData.price,
        networkData.address
      ]
    );

    await notifyAdmin(
      `🔔 <b>طلب اشتراك جديد</b>\n\n` +
      `👤 الاسم: <b>${escapeHtml(user.first_name || "-")}</b>\n` +
      `🔗 Username: <b>@${escapeHtml(user.username || "-")}</b>\n` +
      `🆔 Telegram ID: <code>${escapeHtml(telegram_id)}</code>\n\n` +
      `📦 الباقة المطلوبة: <b>${escapeHtml(user.pending_plan)}</b>\n` +
      `💰 المبلغ المطلوب: <b>${escapeHtml(planData.price)} USDT</b>\n` +
      `🌐 الشبكة: <b>${escapeHtml(networkData.label)}</b>\n` +
      `🏦 عنوان الإيداع:\n<code>${escapeHtml(networkData.address)}</code>\n\n` +
      `افتح لوحة الأدمن للقبول أو الرفض.`
    );

    res.json({
      ok: true,
      deposit: result.rows[0],
      required_amount: planData.price,
      deposit_address: networkData.address,
      deposit_network,
      requested_plan: user.pending_plan
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

    if (numericAmount > Number(user.balance)) {
      return res.status(400).json({
        ok: false,
        message: "Insufficient balance"
      });
    }

    const isFirstWithdrawal = !user.last_withdrawal_at;

    if (!isFirstWithdrawal && numericAmount < Number(user.min_withdraw)) {
      return res.status(400).json({
        ok: false,
        message: "Amount below minimum withdrawal"
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

    if (!isFirstWithdrawal) {
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

    const data = await withTransaction(async (client) => {
      const withdrawal = await client.query(
        `INSERT INTO withdrawals (telegram_id, amount, address)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [String(telegram_id), numericAmount, address]
      );

      const updatedUser = await client.query(
        `UPDATE users
         SET balance = balance - $1
         WHERE telegram_id = $2
         RETURNING *`,
        [numericAmount, String(telegram_id)]
      );

      return {
        withdrawal: withdrawal.rows[0],
        user: updatedUser.rows[0]
      };
    });

    await notifyAdmin(
      `💸 <b>طلب سحب جديد</b>\n\n` +
      `👤 الاسم: <b>${escapeHtml(user.first_name || "-")}</b>\n` +
      `🔗 Username: <b>@${escapeHtml(user.username || "-")}</b>\n` +
      `🆔 Telegram ID: <code>${escapeHtml(telegram_id)}</code>\n\n` +
      `📦 الباقة: <b>${escapeHtml(user.plan)}</b>\n` +
      `💰 المبلغ: <b>${escapeHtml(numericAmount)} USDT</b>\n` +
      `🏦 عنوان السحب:\n<code>${escapeHtml(address)}</code>\n\n` +
      `افتح لوحة الأدمن وتأكد قبل القبول.`
    );

    res.json({
      ok: true,
      withdrawal: data.withdrawal,
      user: data.user
    });
  } catch (err) {
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

    const data = await withTransaction(async (client) => {
      const depositResult = await client.query(
        `UPDATE deposits
         SET status = 'approved'
         WHERE id = $1 AND status = 'pending'
         RETURNING *`,
        [id]
      );

      const deposit = depositResult.rows[0];

      if (!deposit) {
        const error = new Error("Deposit not found or already processed");
        error.statusCode = 404;
        throw error;
      }

      const planName = deposit.requested_plan;

      if (!PLANS[planName]) {
        const error = new Error("Invalid requested plan");
        error.statusCode = 400;
        throw error;
      }

      const userBefore = await client.query(
        `SELECT * FROM users WHERE telegram_id = $1`,
        [deposit.telegram_id]
      );

      const user = userBefore.rows[0];

      if (!user) {
        const error = new Error("User not found");
        error.statusCode = 404;
        throw error;
      }

      if (getPlanRank(planName) <= getPlanRank(user.plan)) {
        const error = new Error("User can only upgrade to a higher plan");
        error.statusCode = 400;
        throw error;
      }

      const userResult = await client.query(
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

      return {
        deposit,
        user: userResult.rows[0]
      };
    });

    res.json({
      ok: true,
      deposit: data.deposit,
      user: data.user
    });
  } catch (err) {
    console.error(err);

    res.status(err.statusCode || 500).json({
      ok: false,
      message: err.message || "Server error"
    });
  }
});

app.post("/api/admin/deposits/:id/reject", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const data = await withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE deposits
         SET status = 'rejected'
         WHERE id = $1 AND status = 'pending'
         RETURNING *`,
        [id]
      );

      const deposit = result.rows[0];

      if (!deposit) {
        const error = new Error("Deposit not found or already processed");
        error.statusCode = 404;
        throw error;
      }

      await client.query(
        `UPDATE users
         SET pending_plan = 'none',
             pending_min_withdraw = 0
         WHERE telegram_id = $1`,
        [deposit.telegram_id]
      );

      return { deposit };
    });

    res.json({
      ok: true,
      deposit: data.deposit
    });
  } catch (err) {
    console.error(err);

    res.status(err.statusCode || 500).json({
      ok: false,
      message: err.message || "Server error"
    });
  }
});

app.post("/api/admin/withdrawals/:id/approve", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const data = await withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE withdrawals
         SET status = 'approved'
         WHERE id = $1 AND status = 'pending'
         RETURNING *`,
        [id]
      );

      const withdrawal = result.rows[0];

      if (!withdrawal) {
        const error = new Error("Withdrawal not found or already processed");
        error.statusCode = 404;
        throw error;
      }

      await client.query(
        `UPDATE users
         SET last_withdrawal_at = NOW()
         WHERE telegram_id = $1`,
        [withdrawal.telegram_id]
      );

      return { withdrawal };
    });

    res.json({
      ok: true,
      withdrawal: data.withdrawal
    });
  } catch (err) {
    console.error(err);

    res.status(err.statusCode || 500).json({
      ok: false,
      message: err.message || "Server error"
    });
  }
});

app.post("/api/admin/withdrawals/:id/reject", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const data = await withTransaction(async (client) => {
      const withdrawalResult = await client.query(
        `UPDATE withdrawals
         SET status = 'rejected'
         WHERE id = $1 AND status = 'pending'
         RETURNING *`,
        [id]
      );

      const withdrawal = withdrawalResult.rows[0];

      if (!withdrawal) {
        const error = new Error("Withdrawal not found or already processed");
        error.statusCode = 404;
        throw error;
      }

      const userResult = await client.query(
        `UPDATE users
         SET balance = balance + $1
         WHERE telegram_id = $2
         RETURNING *`,
        [withdrawal.amount, withdrawal.telegram_id]
      );

      return {
        withdrawal,
        user: userResult.rows[0]
      };
    });

    res.json({
      ok: true,
      withdrawal: data.withdrawal,
      user: data.user
    });
  } catch (err) {
    console.error(err);

    res.status(err.statusCode || 500).json({
      ok: false,
      message: err.message || "Server error"
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