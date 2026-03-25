const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());

// -------------------- CONFIG --------------------
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'redx';
const HEROKU_API_KEY = process.env.HEROKU_API_KEY;
const HEROKU_API = 'https://api.heroku.com';

// PostgreSQL connection – force IPv4
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  family: 4   // ✅ Force IPv4
});

// -------------------- DATABASE MIGRATION --------------------
async function migrateDb() {
  const client = await pool.connect();
  try {
    // Users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        github_username TEXT PRIMARY KEY,
        is_approved BOOLEAN DEFAULT true,
        is_banned BOOLEAN DEFAULT false,
        max_bots INTEGER DEFAULT 2,
        deployment_count INTEGER DEFAULT 0,
        expiry_date TIMESTAMP,
        subscription_plan TEXT DEFAULT 'free',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE users ADD COLUMN is_banned BOOLEAN DEFAULT false;
      EXCEPTION WHEN duplicate_column THEN END; $$;
    `);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE users ADD COLUMN deployment_count INTEGER DEFAULT 0;
      EXCEPTION WHEN duplicate_column THEN END; $$;
    `);

    // Bots table
    await client.query(`
      CREATE TABLE IF NOT EXISTS bots (
        app_name TEXT PRIMARY KEY,
        heroku_app_name TEXT,
        github_username TEXT REFERENCES users(github_username) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW(),
        status TEXT DEFAULT 'running',
        config JSONB
      );
    `);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE bots ADD COLUMN heroku_app_name TEXT;
      EXCEPTION WHEN duplicate_column THEN END; $$;
    `);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE bots ADD COLUMN config JSONB;
      EXCEPTION WHEN duplicate_column THEN END; $$;
    `);

    // Plans table
    await client.query(`
      CREATE TABLE IF NOT EXISTS plans (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE,
        price TEXT,
        duration_days INTEGER,
        max_bots INTEGER,
        features TEXT[],
        is_active BOOLEAN DEFAULT true
      );
    `);

    // Announcements table
    await client.query(`
      CREATE TABLE IF NOT EXISTS announcements (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        priority INTEGER DEFAULT 1,
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    const { rows } = await client.query('SELECT COUNT(*) FROM plans');
    if (parseInt(rows[0].count) === 0) {
      await client.query(
        `INSERT INTO plans (name, price, duration_days, max_bots, features) VALUES 
         ('free', 'Free', 36500, 2, ARRAY['2 bots', 'Basic features', 'Community support']),
         ('pro', '$5/month', 30, 5, ARRAY['5 bots', 'Advanced features', 'Priority support']),
         ('premium', '$10/month', 30, 10, ARRAY['10 bots', 'All features', 'VIP support', 'Early access'])`
      );
    }
  } catch (err) {
    console.error('Migration error:', err);
  } finally {
    client.release();
  }
}

// Run migration immediately
migrateDb().catch(console.error);

// -------------------- HELPER FUNCTIONS --------------------

// Check GitHub fork
async function checkFork(username) {
  try {
    const url = `https://api.github.com/repos/AbdulRehman19721986/redxbot302/forks?per_page=100`;
    const resp = await axios.get(url, { timeout: 10000 });
    const forks = resp.data;
    const userFork = forks.find(fork => fork.owner.login.toLowerCase() === username.toLowerCase());
    return { hasFork: !!userFork, forkUrl: userFork?.html_url };
  } catch (e) {
    console.error('GitHub API error:', e.message);
    return { hasFork: false, error: e.message };
  }
}

// Heroku API helper
async function herokuRequest(method, path, data = null) {
  try {
    const response = await axios({
      method,
      url: `${HEROKU_API}${path}`,
      headers: {
        'Authorization': `Bearer ${HEROKU_API_KEY}`,
        'Accept': 'application/vnd.heroku+json; version=3',
        'Content-Type': 'application/json'
      },
      data
    });
    return response.data;
  } catch (err) {
    if (err.response) {
      console.error('Heroku API error:', err.response.status, err.response.data);
      throw new Error(`Heroku API error: ${err.response.data.message || err.response.statusText}`);
    }
    throw err;
  }
}

// Create Heroku app
async function createHerokuApp(baseName) {
  const safeBase = baseName.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const appName = `${safeBase}-${crypto.randomBytes(4).toString('hex')}`;
  const data = await herokuRequest('POST', '/apps', { name: appName, region: 'us' });
  return { id: data.id, name: data.name };
}

// Set config vars on Heroku app
async function setHerokuConfigVars(appName, envVars) {
  return await herokuRequest('PATCH', `/apps/${appName}/config-vars`, envVars);
}

// Deploy from GitHub tarball
async function deployFromGitHub(appName, repoUrl) {
  const tarballUrl = repoUrl.replace('github.com', 'api.github.com/repos') + '/tarball/main';
  const build = await herokuRequest('POST', `/apps/${appName}/builds`, {
    source_blob: { url: tarballUrl, version: 'main' }
  });
  return build;
}

// Delete Heroku app
async function deleteHerokuApp(appName) {
  try {
    await herokuRequest('DELETE', `/apps/${appName}`);
    return true;
  } catch (err) {
    console.error(`Failed to delete Heroku app ${appName}:`, err.message);
    return false;
  }
}

// -------------------- ROOT ROUTE --------------------
app.get('/', (req, res) => {
  res.json({
    message: 'REDX Bot Deployer Backend (Heroku)',
    status: 'running',
    endpoints: [
      '/api/health', '/api/plans', '/check-fork', '/deploy',
      '/admin/login', '/admin/update-password', '/announcements/list',
      '/admin/announcements', '/get-config', '/update-config'
    ]
  });
});

// -------------------- API ROUTES --------------------

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.get('/api/plans', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM plans WHERE is_active = true');
  res.json({ plans: rows });
});

app.post('/check-fork', async (req, res) => {
  const { githubUsername } = req.body;
  if (!githubUsername) return res.status(400).json({ error: 'Username required' });

  const forkInfo = await checkFork(githubUsername);
  const user = await pool.query('SELECT * FROM users WHERE github_username = $1', [githubUsername.toLowerCase()]);
  let userData = user.rows[0];

  if (!userData) {
    await pool.query(
      'INSERT INTO users (github_username, max_bots, subscription_plan) VALUES ($1, $2, $3)',
      [githubUsername.toLowerCase(), 2, 'free']
    );
    userData = {
      github_username: githubUsername.toLowerCase(),
      is_approved: true,
      is_banned: false,
      max_bots: 2,
      deployment_count: 0,
      subscription_plan: 'free'
    };
  }

  const bots = await pool.query(
    'SELECT app_name, heroku_app_name, created_at, status FROM bots WHERE github_username = $1',
    [githubUsername.toLowerCase()]
  );

  res.json({
    hasFork: forkInfo.hasFork,
    forkUrl: forkInfo.forkUrl,
    isApproved: userData.is_approved,
    isBanned: userData.is_banned,
    maxBots: userData.max_bots,
    deploymentCount: userData.deployment_count,
    expiryDate: userData.expiry_date,
    subscriptionPlan: userData.subscription_plan,
    deployedBots: bots.rows,
    currentBots: bots.rows.length
  });
});

app.post('/deploy', async (req, res) => {
  const { githubUsername, sessionId, appName: customAppName, ...config } = req.body;
  if (!githubUsername || !sessionId) return res.status(400).json({ error: 'Missing fields' });

  const user = await pool.query('SELECT * FROM users WHERE github_username = $1', [githubUsername.toLowerCase()]);
  if (user.rows.length === 0) return res.status(403).json({ error: 'User not found' });
  const userData = user.rows[0];

  if (userData.is_banned) return res.status(403).json({ error: 'User is banned' });
  if (!userData.is_approved) return res.status(403).json({ error: 'User not approved' });

  const botCount = await pool.query('SELECT COUNT(*) FROM bots WHERE github_username = $1', [githubUsername.toLowerCase()]);
  if (parseInt(botCount.rows[0].count) >= userData.max_bots) {
    return res.status(403).json({ error: `Bot limit reached (max ${userData.max_bots} bots)` });
  }

  const baseName = customAppName || `redx-${githubUsername}`;

  try {
    // 1. Create Heroku app
    const app = await createHerokuApp(baseName);

    // 2. Set environment variables
    const envVars = {
      SESSION_ID: sessionId,
      OWNER_NUMBER: config.OWNER_NUMBER || '923009842133',
      BOT_NAME: config.BOT_NAME || 'REDXBOT302',
      PREFIX: config.PREFIX || '.',
      AUTO_STATUS_SEEN: config.AUTO_STATUS_SEEN || 'true',
      AUTO_STATUS_REACT: config.AUTO_STATUS_REACT || 'true',
      ANTI_DELETE: config.ANTI_DELETE || 'true',
      ANTI_LINK: config.ANTI_LINK || 'false',
      ALWAYS_ONLINE: config.ALWAYS_ONLINE || 'false',
      AUTO_REPLY: config.AUTO_REPLY || 'false',
      AUTO_STICKER: config.AUTO_STICKER || 'false',
      WELCOME: config.WELCOME || 'false',
      READ_MESSAGE: config.READ_MESSAGE || 'false',
      AUTO_TYPING: config.AUTO_TYPING || 'false',
      GITHUB_USERNAME: githubUsername
    };
    await setHerokuConfigVars(app.name, envVars);

    // 3. Get fork URL
    const forkInfo = await checkFork(githubUsername);
    if (!forkInfo.hasFork) {
      throw new Error('User does not have a fork');
    }
    const repoUrl = forkInfo.forkUrl;

    // 4. Deploy from GitHub fork
    await deployFromGitHub(app.name, repoUrl);

    // 5. Save to DB
    await pool.query(
      'INSERT INTO bots (app_name, heroku_app_name, github_username, status, config) VALUES ($1, $2, $3, $4, $5)',
      [baseName, app.name, githubUsername.toLowerCase(), 'deploying', JSON.stringify(envVars)]
    );
    await pool.query(
      'UPDATE users SET deployment_count = deployment_count + 1 WHERE github_username = $1',
      [githubUsername.toLowerCase()]
    );

    res.json({
      success: true,
      appName: baseName,
      herokuAppName: app.name,
      message: `Bot deployed to Heroku successfully! It may take a few minutes to start. Access at https://${app.name}.herokuapp.com`
    });

  } catch (error) {
    console.error('Deployment error:', error);
    res.status(500).json({
      error: 'Failed to deploy to Heroku',
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Bot configuration endpoints
app.post('/get-config', async (req, res) => {
  const { appName } = req.body;
  const bot = await pool.query('SELECT config FROM bots WHERE app_name = $1', [appName]);
  if (bot.rows.length === 0) return res.status(404).json({ error: 'Bot not found' });
  res.json({ success: true, config: bot.rows[0].config || {} });
});

app.post('/update-config', async (req, res) => {
  const { appName, config } = req.body;
  const bot = await pool.query('SELECT heroku_app_name FROM bots WHERE app_name = $1', [appName]);
  if (bot.rows.length === 0) return res.status(404).json({ error: 'Bot not found' });
  const herokuAppName = bot.rows[0].heroku_app_name;

  try {
    await setHerokuConfigVars(herokuAppName, config);
    await pool.query('UPDATE bots SET config = $1 WHERE app_name = $2', [JSON.stringify(config), appName]);
    res.json({ success: true, message: 'Config updated' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/bot-logs', async (req, res) => {
  const { appName } = req.body;
  const bot = await pool.query('SELECT heroku_app_name FROM bots WHERE app_name = $1', [appName]);
  if (bot.rows.length === 0) return res.status(404).json({ error: 'Bot not found' });
  res.json({ success: true, logs: 'Logs feature not yet implemented. Check Heroku dashboard.' });
});

app.post('/restart-app', async (req, res) => {
  const { appName } = req.body;
  const bot = await pool.query('SELECT heroku_app_name FROM bots WHERE app_name = $1', [appName]);
  if (bot.rows.length === 0) return res.status(404).json({ error: 'Bot not found' });
  const herokuAppName = bot.rows[0].heroku_app_name;
  try {
    await herokuRequest('DELETE', `/apps/${herokuAppName}/dynos`);
    res.json({ success: true, message: 'Restart initiated' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/delete-app', async (req, res) => {
  const { appName, githubUsername } = req.body;
  const bot = await pool.query('SELECT heroku_app_name FROM bots WHERE app_name = $1', [appName]);
  if (bot.rows.length === 0) return res.status(404).json({ error: 'Bot not found' });
  const herokuAppName = bot.rows[0].heroku_app_name;
  try {
    await deleteHerokuApp(herokuAppName);
    await pool.query('DELETE FROM bots WHERE app_name = $1', [appName]);
    res.json({ success: true, message: 'Bot deleted from Heroku' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/buy-plan', (req, res) => {
  const { planName, price, githubUsername } = req.body;
  const message = `I want to buy the ${planName} plan (${price}). My GitHub: ${githubUsername}`;
  const whatsappLink = `https://wa.me/923009842133?text=${encodeURIComponent(message)}`;
  res.json({ whatsappLink });
});

// Announcements - Public
app.post('/announcements/list', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM announcements WHERE active = true ORDER BY priority ASC, created_at DESC');
  res.json({ announcements: rows });
});

// -------------------- ADMIN ROUTES --------------------

app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) return res.json({ success: true });
  res.status(401).json({ error: 'Invalid password' });
});

app.post('/admin/update-password', (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (currentPassword !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  ADMIN_PASSWORD = newPassword;
  res.json({ success: true, message: 'Password updated (memory only).' });
});

app.post('/admin/users', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { rows } = await pool.query(`
    SELECT u.*, COUNT(b.app_name) as active_bots 
    FROM users u 
    LEFT JOIN bots b ON u.github_username = b.github_username 
    GROUP BY u.github_username
  `);
  res.json({ users: rows });
});

app.post('/admin/update-user', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { githubUsername, isApproved, isBanned, maxBots, expiryDate, subscriptionPlan } = req.body;
  await pool.query(
    `UPDATE users SET 
      is_approved = COALESCE($2, is_approved),
      is_banned = COALESCE($3, is_banned),
      max_bots = COALESCE($4, max_bots),
      expiry_date = COALESCE($5, expiry_date),
      subscription_plan = COALESCE($6, subscription_plan)
     WHERE github_username = $1`,
    [githubUsername.toLowerCase(), isApproved, isBanned, maxBots, expiryDate, subscriptionPlan]
  );
  res.json({ success: true });
});

app.post('/admin/delete-user', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { githubUsername } = req.body;

  const bots = await pool.query('SELECT heroku_app_name FROM bots WHERE github_username = $1', [githubUsername.toLowerCase()]);
  for (const bot of bots.rows) {
    if (bot.heroku_app_name) {
      await deleteHerokuApp(bot.heroku_app_name).catch(console.error);
    }
  }
  await pool.query('DELETE FROM users WHERE github_username = $1', [githubUsername.toLowerCase()]);
  res.json({ success: true });
});

app.post('/admin/plans', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { rows } = await pool.query('SELECT * FROM plans');
  res.json({ plans: rows });
});

app.post('/admin/create-plan', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { name, price, duration_days, max_bots, features } = req.body;
  await pool.query(
    'INSERT INTO plans (name, price, duration_days, max_bots, features) VALUES ($1, $2, $3, $4, $5)',
    [name, price, duration_days, max_bots, features]
  );
  res.json({ success: true });
});

app.post('/admin/update-plan', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { id, name, price, duration_days, max_bots, features, is_active } = req.body;
  await pool.query(
    'UPDATE plans SET name=$1, price=$2, duration_days=$3, max_bots=$4, features=$5, is_active=$6 WHERE id=$7',
    [name, price, duration_days, max_bots, features, is_active, id]
  );
  res.json({ success: true });
});

app.post('/admin/delete-plan', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  await pool.query('DELETE FROM plans WHERE id = $1', [req.body.id]);
  res.json({ success: true });
});

app.post('/admin/announcements', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { rows } = await pool.query('SELECT * FROM announcements ORDER BY priority ASC, created_at DESC');
  res.json({ announcements: rows });
});

app.post('/admin/create-announcement', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { title, content, priority, active } = req.body;
  await pool.query(
    'INSERT INTO announcements (title, content, priority, active) VALUES ($1, $2, $3, $4)',
    [title, content, priority || 1, active !== undefined ? active : true]
  );
  res.json({ success: true });
});

app.post('/admin/update-announcement', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { id, title, content, priority, active } = req.body;
  await pool.query(
    'UPDATE announcements SET title=$1, content=$2, priority=$3, active=$4 WHERE id=$5',
    [title, content, priority, active, id]
  );
  res.json({ success: true });
});

app.post('/admin/delete-announcement', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  await pool.query('DELETE FROM announcements WHERE id = $1', [req.body.id]);
  res.json({ success: true });
});

app.post('/get-all-apps', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { rows } = await pool.query('SELECT * FROM bots ORDER BY created_at DESC');
  res.json({ apps: rows });
});

app.post('/delete-multiple-apps', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { apps } = req.body;
  const results = { success: [], failed: [] };
  for (const { name } of apps) {
    try {
      const bot = await pool.query('SELECT heroku_app_name FROM bots WHERE app_name = $1', [name]);
      if (bot.rows.length) {
        await deleteHerokuApp(bot.rows[0].heroku_app_name);
      }
      await pool.query('DELETE FROM bots WHERE app_name = $1', [name]);
      results.success.push(name);
    } catch (err) {
      results.failed.push(name);
    }
  }
  res.json({ success: true, results });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
