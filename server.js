require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const DB_FILE = "database.json";

function readDB() {
  if (!fs.existsSync(DB_FILE)) {
    return {
      users: [],
      deposits: [],
      withdrawals: []
    };
  }

  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function findUser(db, telegram_id) {
  return db.users.find(u => String(u.telegram_id) === String(telegram_id));
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "RivoTask API is running"
  });
});

app.post("/api/user", (req, res) => {
  const { telegram_id, first_name, username } = req.body;

  if (!telegram_id) {
    return res.status(400).json({
      ok: false,
      message: "telegram_id is required"
    });
  }

  const db = readDB();

  let user = findUser(db, telegram_id);

  if (!user) {
    user = {
      id: db.users.length + 1,
      telegram_id: String(telegram_id),
      first_name: first_name || "",
      username: username || "",
      plan: "none",
      balance: 0,
      min_withdraw: 0,
      plan_started_at: null,
      last_task_at: null,
      created_at: new Date().toISOString()
    };

    db.users.push(user);
    writeDB(db);
  }

  res.json({
    ok: true,
    user
  });
});

app.post("/api/select-plan", (req, res) => {
  const { telegram_id, plan } = req.body;

  const plans = {
    Basic: { min_withdraw: 5 },
    Plus: { min_withdraw: 20 },
    Pro: { min_withdraw: 35 }
  };

  if (!telegram_id || !plans[plan]) {
    return res.status(400).json({
      ok: false,
      message: "Invalid telegram_id or plan"
    });
  }

  const db = readDB();
  const user = findUser(db, telegram_id);

  if (!user) {
    return res.status(404).json({
      ok: false,
      message: "User not found"
    });
  }

  user.plan = plan;
  user.min_withdraw = plans[plan].min_withdraw;
  user.plan_started_at = new Date().toISOString();

  writeDB(db);

  res.json({
    ok: true,
    user
  });
});

app.post("/api/complete-task", (req, res) => {
  const { telegram_id } = req.body;

  if (!telegram_id) {
    return res.status(400).json({
      ok: false,
      message: "telegram_id is required"
    });
  }

  const db = readDB();
  const user = findUser(db, telegram_id);

  if (!user) {
    return res.status(404).json({
      ok: false,
      message: "User not found"
    });
  }

  const today = new Date().toISOString().slice(0, 10);
  const lastTaskDay = user.last_task_at
    ? new Date(user.last_task_at).toISOString().slice(0, 10)
    : null;

  if (lastTaskDay === today) {
    return res.status(400).json({
      ok: false,
      message: "Task already completed today"
    });
  }

  let reward = 0.2;

  if (user.plan === "Basic") reward = 1.2;
  if (user.plan === "Plus") reward = 8.2;
  if (user.plan === "Pro") reward = 12;

  user.balance = Number((user.balance + reward).toFixed(2));
  user.last_task_at = new Date().toISOString();

  writeDB(db);

  res.json({
    ok: true,
    reward,
    user
  });
});

app.post("/api/deposit", (req, res) => {
  const { telegram_id, tx_hash } = req.body;

  if (!telegram_id || !tx_hash) {
    return res.status(400).json({
      ok: false,
      message: "telegram_id and tx_hash are required"
    });
  }

  const db = readDB();
  const user = findUser(db, telegram_id);

  if (!user) {
    return res.status(404).json({
      ok: false,
      message: "User not found"
    });
  }

  const deposit = {
    id: db.deposits.length + 1,
    telegram_id: String(telegram_id),
    tx_hash,
    status: "pending",
    created_at: new Date().toISOString()
  };

  db.deposits.push(deposit);
  writeDB(db);

  res.json({
    ok: true,
    deposit
  });
});

app.post("/api/withdraw", (req, res) => {
  const { telegram_id, amount, address } = req.body;

  if (!telegram_id || !amount || !address) {
    return res.status(400).json({
      ok: false,
      message: "telegram_id, amount and address are required"
    });
  }

  const db = readDB();
  const user = findUser(db, telegram_id);

  if (!user) {
    return res.status(404).json({
      ok: false,
      message: "User not found"
    });
  }

  const numericAmount = Number(amount);

  if (user.plan === "none") {
    return res.status(400).json({
      ok: false,
      message: "Select a plan first"
    });
  }

  if (numericAmount < user.min_withdraw) {
    return res.status(400).json({
      ok: false,
      message: "Amount below minimum withdrawal"
    });
  }

  if (numericAmount > user.balance) {
    return res.status(400).json({
      ok: false,
      message: "Insufficient balance"
    });
  }

  const withdrawal = {
    id: db.withdrawals.length + 1,
    telegram_id: String(telegram_id),
    amount: numericAmount,
    address,
    status: "pending",
    created_at: new Date().toISOString()
  };

  db.withdrawals.push(withdrawal);

  user.balance = Number((user.balance - numericAmount).toFixed(2));

  writeDB(db);

  res.json({
    ok: true,
    withdrawal,
    user
  });
});

app.get("/api/admin", (req, res) => {
  const db = readDB();

  res.json({
    ok: true,
    data: db
  });
});

app.listen(PORT, () => {
  console.log(`RivoTask API running on http://localhost:${PORT}`);
});