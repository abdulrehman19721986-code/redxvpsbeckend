const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const axios = require('axios');
const pm2 = require('pm2');
const fs = require('fs');
const path = require('path');
const { execa } = require('execa'); // npm install execa
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // serve frontend

// Environment
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'redx';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN; // optional, for higher rate limits
const BOTS_DIR = path.join(__dirname, 'bots');
const MAIN_REPO = process.env.MAIN_REPO || 'https://github.com/AbdulRehman19721986/redxbot302.git';

// Ensure bots directory exists
if (!fs.existsSync(BOTS_DIR)) fs.mkdirSync(BOTS_DIR, { recursive: true });

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Initialize database tables
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      github_username TEXT PRIMARY KEY,
      is_approved BOOLEAN DEFAULT true,
      max_bots INTEGER DEFAULT 1,
      expiry_date TIMESTAMP,
      subscription_plan TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS bots (
      app_name TEXT PRIMARY KEY,
      github_username TEXT REFERENCES users(github_username) ON DELETE CASCADE,
      server_id INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT NOW(),
      status TEXT DEFAULT 'running'
    );
    CREATE TABLE IF NOT EXISTS plans (
      id SERIAL PRIMARY KEY,
      name TEXT,
      price TEXT,
      duration TEXT,
      max_bots INTEGER,
      features TEXT[],
      is_active BOOLEAN DEFAULT true
    );
    CREATE TABLE IF NOT EXISTS servers (
      id SERIAL PRIMARY KEY,
      name TEXT,
      url TEXT,
      api_key TEXT,
      bot_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'online'
    );
  `);

  // Insert default server (this Railway instance)
  await pool.query(
    `INSERT INTO servers (name, url, api_key, bot_count) 
     VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
    ['Railway Main', 'http://localhost', 'internal', 0]
  );

  // Insert default plans if none exist
  const { rows } = await pool.query('SELECT COUNT(*) FROM plans');
  if (parseInt(rows[0].count) === 0) {
    await pool.query(
      `INSERT INTO plans (name, price, duration, max_bots, features) VALUES 
       ('Free', 'Free', 'Lifetime', 1, ARRAY['1 Bot', 'Basic Support']),
       ('Pro', '$5/month', '30 days', 3, ARRAY['3 Bots', 'Priority Support', 'Advanced Features']),
       ('Premium', '$10/month', '30 days', 10, ARRAY['10 Bots', 'VIP Support', 'All Features'])`
    );
  }
}
initDb().catch(console.error);

// Helper: check GitHub fork
async function checkFork(username) {
  try {
    const headers = GITHUB_TOKEN ? { Authorization: `token ${GITHUB_TOKEN}` } : {};
    const url = `https://api.github.com/repos/AbdulRehman19721986/redxbot302/forks?per_page=100`;
    const resp = await axios.get(url, { headers, timeout: 10000 });
    const forks = resp.data;
    const userFork = forks.find(fork => fork.owner.login.toLowerCase() === username.toLowerCase());
    return { hasFork: !!userFork, forkUrl: userFork?.html_url };
  } catch (e) {
    console.error('GitHub API error:', e.message);
    return { hasFork: false, error: e.message };
  }
}

// Clone user's fork using git
async function cloneRepo(githubUsername, appName) {
  const repoUrl = `https://github.com/${githubUsername}/redxbot302.git`;
  const dest = path.join(BOTS_DIR, appName);
  try {
    await execa('git', ['clone', repoUrl, dest]);
    return { success: true };
  } catch (err) {
    console.error('Clone failed:', err.message);
    return { success: false, error: err.message };
  }
}

// -------------------- API Routes --------------------

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Get all plans (public)
app.get('/api/plans', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM plans WHERE is_active = true');
  res.json({ plans: rows });
});

// Check fork and return user data
app.post('/check-fork', async (req, res) => {
  const { githubUsername } = req.body;
  if (!githubUsername) return res.status(400).json({ error: 'Username required' });

  const forkInfo = await checkFork(githubUsername);
  const user = await pool.query(
    'SELECT * FROM users WHERE github_username = $1',
    [githubUsername.toLowerCase()]
  );
  let userData = user.rows[0];
  if (!userData) {
    await pool.query(
      'INSERT INTO users (github_username) VALUES ($1)',
      [githubUsername.toLowerCase()]
    );
    userData = { github_username: githubUsername.toLowerCase(), is_approved: true, max_bots: 1 };
  }

  const bots = await pool.query(
    'SELECT app_name, created_at FROM bots WHERE github_username = $1',
    [githubUsername.toLowerCase()]
  );

  res.json({
    hasFork: forkInfo.hasFork,
    forkUrl: forkInfo.forkUrl,
    isApproved: userData.is_approved,
    maxBots: userData.max_bots,
    expiryDate: userData.expiry_date,
    subscriptionPlan: userData.subscription_plan,
    deployedBots: bots.rows,
    currentBots: bots.rows.length
  });
});

// Deploy bot
app.post('/deploy', async (req, res) => {
  const { githubUsername, sessionId, appName: customAppName, ...config } = req.body;
  if (!githubUsername || !sessionId) return res.status(400).json({ error: 'Missing fields' });

  const user = await pool.query('SELECT * FROM users WHERE github_username = $1', [githubUsername.toLowerCase()]);
  if (user.rows.length === 0) return res.status(403).json({ error: 'User not found' });
  const userData = user.rows[0];
  if (!userData.is_approved) return res.status(403).json({ error: 'User not approved' });

  const botCount = await pool.query('SELECT COUNT(*) FROM bots WHERE github_username = $1', [githubUsername.toLowerCase()]);
  if (parseInt(botCount.rows[0].count) >= userData.max_bots) {
    return res.status(403).json({ error: 'Bot limit reached' });
  }

  const appName = customAppName || `${githubUsername}-${Date.now()}`.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const botPath = path.join(BOTS_DIR, appName);

  // Clone the user's fork
  const cloneResult = await cloneRepo(githubUsername, appName);
  if (!cloneResult.success) {
    return res.status(500).json({ error: 'Clone failed: ' + cloneResult.error });
  }

  // Create .env
  const envContent = Object.entries({
    SESSION_ID: sessionId,
    GITHUB_USERNAME: githubUsername,
    ...config
  }).map(([k, v]) => `${k}=${v}`).join('\n');
  fs.writeFileSync(path.join(botPath, '.env'), envContent);

  // Install dependencies and start with PM2
  try {
    await execa('npm', ['install'], { cwd: botPath });
  } catch (err) {
    return res.status(500).json({ error: 'npm install failed: ' + err.message });
  }

  pm2.connect((err) => {
    if (err) return res.status(500).json({ error: 'PM2 connect failed' });
    pm2.start({
      script: 'index.js',
      name: appName,
      cwd: botPath,
      env: process.env
    }, async (err2, proc) => {
      pm2.disconnect();
      if (err2) return res.status(500).json({ error: 'PM2 start failed: ' + err2.message });

      // Save to database
      await pool.query(
        'INSERT INTO bots (app_name, github_username) VALUES ($1, $2)',
        [appName, githubUsername.toLowerCase()]
      );
      await pool.query('UPDATE servers SET bot_count = bot_count + 1 WHERE id = 1');
      res.json({ success: true, appName });
    });
  });
});

// Restart bot
app.post('/restart-app', (req, res) => {
  const { appName } = req.body;
  pm2.connect((err) => {
    if (err) return res.status(500).json({ error: 'PM2 connect failed' });
    pm2.restart(appName, (err2, proc) => {
      pm2.disconnect();
      if (err2) return res.status(500).json({ error: 'Restart failed' });
      res.json({ success: true, message: 'Restarted' });
    });
  });
});

// Delete bot
app.post('/delete-app', async (req, res) => {
  const { appName, githubUsername } = req.body;
  const botPath = path.join(BOTS_DIR, appName);

  pm2.connect((err) => {
    if (err) return res.status(500).json({ error: 'PM2 connect failed' });
    pm2.delete(appName, async (err2) => {
      pm2.disconnect();
      // Remove folder
      fs.rm(botPath, { recursive: true, force: true }, async (err3) => {
        if (err3) return res.status(500).json({ error: 'Folder deletion failed' });
        await pool.query('DELETE FROM bots WHERE app_name = $1', [appName]);
        await pool.query('UPDATE servers SET bot_count = bot_count - 1 WHERE id = 1');
        res.json({ success: true, message: 'Bot deleted' });
      });
    });
  });
});

// Get bot config (for editing)
app.post('/get-config', (req, res) => {
  const { appName } = req.body;
  const botPath = path.join(BOTS_DIR, appName);
  const envFile = path.join(botPath, '.env');
  if (!fs.existsSync(envFile)) return res.status(404).json({ error: 'Config not found' });
  const env = fs.readFileSync(envFile, 'utf8').split('\n').reduce((acc, line) => {
    const [key, ...valArr] = line.split('=');
    if (key) acc[key] = valArr.join('=');
    return acc;
  }, {});
  res.json({ success: true, config: env });
});

// Update bot config
app.post('/update-config', (req, res) => {
  const { appName, config } = req.body;
  const botPath = path.join(BOTS_DIR, appName);
  const envContent = Object.entries(config).map(([k, v]) => `${k}=${v}`).join('\n');
  fs.writeFileSync(path.join(botPath, '.env'), envContent);
  // Restart to apply new env
  pm2.connect((err) => {
    if (err) return res.status(500).json({ error: 'PM2 connect failed' });
    pm2.restart(appName, (err2) => {
      pm2.disconnect();
      if (err2) return res.status(500).json({ error: 'Restart after config update failed' });
      res.json({ success: true, message: 'Config updated and bot restarted' });
    });
  });
});

// Admin: get all users
app.post('/admin/users', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { rows } = await pool.query('SELECT * FROM users');
  res.json({ users: rows });
});

// Admin: update user
app.post('/admin/update-user', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { githubUsername, isApproved, maxBots, expiryDate, subscriptionPlan } = req.body;
  await pool.query(
    `INSERT INTO users (github_username, is_approved, max_bots, expiry_date, subscription_plan)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (github_username) DO UPDATE SET
       is_approved = EXCLUDED.is_approved,
       max_bots = EXCLUDED.max_bots,
       expiry_date = EXCLUDED.expiry_date,
       subscription_plan = EXCLUDED.subscription_plan`,
    [githubUsername.toLowerCase(), isApproved, maxBots, expiryDate, subscriptionPlan]
  );
  res.json({ success: true });
});

// Admin: delete user
app.post('/admin/delete-user', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  await pool.query('DELETE FROM users WHERE github_username = $1', [req.body.githubUsername.toLowerCase()]);
  res.json({ success: true });
});

// Admin: get plans
app.post('/admin/plans', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { rows } = await pool.query('SELECT * FROM plans');
  res.json({ plans: rows });
});

// Admin: create plan
app.post('/admin/create-plan', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { name, price, duration, maxBots, features } = req.body;
  await pool.query(
    'INSERT INTO plans (name, price, duration, max_bots, features) VALUES ($1, $2, $3, $4, $5)',
    [name, price, duration, maxBots, features]
  );
  res.json({ success: true });
});

// Admin: update plan
app.post('/admin/update-plan', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { id, name, price, duration, maxBots, features } = req.body;
  await pool.query(
    'UPDATE plans SET name=$1, price=$2, duration=$3, max_bots=$4, features=$5 WHERE id=$6',
    [name, price, duration, maxBots, features, id]
  );
  res.json({ success: true });
});

// Admin: delete plan
app.post('/admin/delete-plan', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  await pool.query('DELETE FROM plans WHERE id = $1', [req.body.id]);
  res.json({ success: true });
});

// Admin: get servers
app.post('/admin/servers', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { rows } = await pool.query('SELECT id, name, bot_count, status FROM servers');
  res.json({ servers: rows });
});

// Admin: get all bots
app.post('/get-all-apps', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { rows } = await pool.query(`
    SELECT b.app_name, b.github_username, b.created_at, s.name as server_name
    FROM bots b
    JOIN servers s ON b.server_id = s.id
  `);
  res.json({ apps: rows });
});

// Admin: delete multiple bots
app.post('/delete-multiple-apps', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { apps } = req.body;
  const results = { success: [], failed: [] };
  for (const { name } of apps) {
    try {
      await new Promise((resolve, reject) => {
        pm2.connect((err) => {
          if (err) return reject(err);
          pm2.delete(name, (err2) => {
            pm2.disconnect();
            if (err2) return reject(err2);
            resolve();
          });
        });
      });
      const botPath = path.join(BOTS_DIR, name);
      fs.rmSync(botPath, { recursive: true, force: true });
      await pool.query('DELETE FROM bots WHERE app_name = $1', [name]);
      results.success.push(name);
    } catch {
      results.failed.push(name);
    }
  }
  res.json({ success: true, results });
});

// Buy plan – WhatsApp link generator (uses your number)
app.post('/api/buy-plan', (req, res) => {
  const { planName, price, githubUsername } = req.body;
  const message = `I want to buy the ${planName} plan (${price}). My GitHub: ${githubUsername}`;
  const whatsappLink = `https://wa.me/923009842133?text=${encodeURIComponent(message)}`;
  res.json({ whatsappLink });
});

// Serve frontend for any unmatched route (SPA support)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
