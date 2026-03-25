const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());
app.use(express.static('public'));

// -------------------- CONFIG --------------------
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'redx';
const HEROKU_API_KEY = process.env.HEROKU_API_KEY || 'HRKU-AAtfI59r2pRGW6gAak5c10g-tYCS_URvC4Oy9Sks5nYw_____wAVUH6n-BJG';
const HEROKU_API = 'https://api.heroku.com';
const BOT_REPO_NAME = process.env.BOT_REPO_NAME || 'redxbot302';
const FORK_CHECK_REPO = process.env.FORK_CHECK_REPO || 'AbdulRehman19721986/redxbot302';

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// -------------------- DATABASE MIGRATION --------------------
async function migrateDb() {
  const client = await pool.connect();
  try {
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
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned BOOLEAN DEFAULT false`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS deployment_count INTEGER DEFAULT 0`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS bots (
        app_name TEXT PRIMARY KEY,
        heroku_app_name TEXT,
        github_username TEXT REFERENCES users(github_username) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW(),
        status TEXT DEFAULT 'deploying'
      );
    `);
    await client.query(`ALTER TABLE bots ADD COLUMN IF NOT EXISTS heroku_app_name TEXT`);

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

    const { rows } = await client.query('SELECT COUNT(*) FROM plans');
    if (parseInt(rows[0].count) === 0) {
      await client.query(`
        INSERT INTO plans (name, price, duration_days, max_bots, features) VALUES 
        ('free', 'Free', 36500, 2, ARRAY['2 bots', 'Basic features', 'Community support']),
        ('pro', '$5/month', 30, 5, ARRAY['5 bots', 'Advanced features', 'Priority support']),
        ('premium', '$10/month', 30, 10, ARRAY['10 bots', 'All features', 'VIP support', 'Early access'])
      `);
    }
  } catch (err) {
    console.error('Migration error:', err);
  } finally {
    client.release();
  }
}
migrateDb().catch(console.error);

// -------------------- HEROKU HELPERS --------------------
function herokuHeaders(extra = {}) {
  return {
    'Authorization': `Bearer ${HEROKU_API_KEY}`,
    'Content-Type': 'application/json',
    'Accept': 'application/vnd.heroku+json; version=3',
    ...extra
  };
}

async function herokuRequest(method, path, data = null) {
  try {
    const cfg = { method, url: `${HEROKU_API}${path}`, headers: herokuHeaders() };
    if (data) cfg.data = data;
    const resp = await axios(cfg);
    return resp.data;
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    throw new Error(msg);
  }
}

async function createHerokuApp(appName) {
  return herokuRequest('POST', '/apps', { name: appName, region: 'us', stack: 'heroku-24' });
}

async function setHerokuConfigVars(appName, envVars) {
  return herokuRequest('PATCH', `/apps/${appName}/config-vars`, envVars);
}

async function deployFromGitHub(appName, githubUsername) {
  const sourceUrl = `https://github.com/${githubUsername}/${BOT_REPO_NAME}/archive/refs/heads/main.tar.gz`;
  return herokuRequest('POST', `/apps/${appName}/builds`, {
    source_blob: { url: sourceUrl, version: 'main' }
  });
}

async function deleteHerokuApp(appName) {
  try { await herokuRequest('DELETE', `/apps/${appName}`); return true; }
  catch { return false; }
}

async function restartHerokuDynos(appName) {
  return herokuRequest('DELETE', `/apps/${appName}/dynos`);
}

async function getHerokuAppInfo(appName) {
  try { return await herokuRequest('GET', `/apps/${appName}`); }
  catch { return null; }
}

// -------------------- GITHUB FORK CHECK --------------------
async function checkFork(username) {
  try {
    const url = `https://api.github.com/repos/${FORK_CHECK_REPO}/forks?per_page=100`;
    const resp = await axios.get(url, { timeout: 10000 });
    const userFork = resp.data.find(f => f.owner.login.toLowerCase() === username.toLowerCase());
    return { hasFork: !!userFork, forkUrl: userFork?.html_url };
  } catch (e) {
    return { hasFork: false, error: e.message };
  }
}

// -------------------- ROUTES --------------------
app.get('/', (req, res) => res.json({
  message: 'REDX Bot Deployer Backend (Heroku)',
  status: 'running',
  platform: 'heroku'
}));

app.get('/api/health', (req, res) => res.json({ status: 'ok', platform: 'heroku' }));

app.get('/api/plans', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM plans WHERE is_active = true ORDER BY id');
    res.json({ plans: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/check-fork', async (req, res) => {
  const { githubUsername } = req.body;
  if (!githubUsername) return res.status(400).json({ error: 'Username required' });

  const forkInfo = await checkFork(githubUsername);
  let user = await pool.query('SELECT * FROM users WHERE github_username = $1', [githubUsername.toLowerCase()]);
  let userData = user.rows[0];

  if (!userData) {
    await pool.query(
      'INSERT INTO users (github_username, max_bots, subscription_plan) VALUES ($1, 2, $2)',
      [githubUsername.toLowerCase(), 'free']
    );
    userData = { github_username: githubUsername.toLowerCase(), is_approved: true, is_banned: false, max_bots: 2, deployment_count: 0, subscription_plan: 'free' };
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
  if (!githubUsername || !sessionId) return res.status(400).json({ error: 'GitHub username and Session ID are required' });

  const user = await pool.query('SELECT * FROM users WHERE github_username = $1', [githubUsername.toLowerCase()]);
  if (!user.rows.length) return res.status(403).json({ error: 'User not found. Please check your fork first.' });
  const ud = user.rows[0];

  if (ud.is_banned) return res.status(403).json({ error: 'Your account is banned. Contact admin.' });
  if (!ud.is_approved) return res.status(403).json({ error: 'Your account is not approved yet.' });

  const botCount = await pool.query('SELECT COUNT(*) FROM bots WHERE github_username = $1', [githubUsername.toLowerCase()]);
  if (parseInt(botCount.rows[0].count) >= ud.max_bots) {
    return res.status(403).json({ error: `Bot limit reached (max ${ud.max_bots}). Upgrade your plan!` });
  }

  // Generate unique Heroku app name (max 30 chars)
  const safeUser = githubUsername.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
  const suffix = crypto.randomBytes(3).toString('hex');
  const herokuAppName = customAppName
    ? customAppName.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 22) + '-' + suffix
    : `redx-${safeUser}-${suffix}`;

  try {
    console.log(`[Deploy] Creating Heroku app: ${herokuAppName} for ${githubUsername}`);
    await createHerokuApp(herokuAppName);

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
    await setHerokuConfigVars(herokuAppName, envVars);

    // Attempt auto-deploy from user's GitHub fork
    let build = null;
    let deployNote = '';
    try {
      build = await deployFromGitHub(herokuAppName, githubUsername);
      deployNote = 'Build started! Bot will be live in ~2 minutes.';
    } catch (buildErr) {
      console.warn(`[Deploy] Auto-build failed for ${herokuAppName}:`, buildErr.message);
      deployNote = 'App created. Please connect GitHub in Heroku dashboard to finish deploy.';
    }

    await pool.query(
      'INSERT INTO bots (app_name, heroku_app_name, github_username, status) VALUES ($1, $2, $3, $4)',
      [herokuAppName, herokuAppName, githubUsername.toLowerCase(), build ? 'deploying' : 'pending']
    );
    await pool.query(
      'UPDATE users SET deployment_count = deployment_count + 1 WHERE github_username = $1',
      [githubUsername.toLowerCase()]
    );

    res.json({
      success: true,
      appName: herokuAppName,
      herokuUrl: `https://${herokuAppName}.herokuapp.com`,
      dashboardUrl: `https://dashboard.heroku.com/apps/${herokuAppName}`,
      buildId: build?.id,
      message: deployNote
    });

  } catch (error) {
    console.error('[Deploy] Error:', error.message);
    try { await deleteHerokuApp(herokuAppName); } catch {}
    res.status(500).json({ error: 'Deployment failed: ' + error.message });
  }
});

app.post('/bot-logs', async (req, res) => {
  const { appName } = req.body;
  res.json({
    success: true,
    logs: `View live logs at: https://dashboard.heroku.com/apps/${appName}/logs`,
    dashboardUrl: `https://dashboard.heroku.com/apps/${appName}/logs`
  });
});

app.post('/restart-app', async (req, res) => {
  const { appName } = req.body;
  try {
    const bot = await pool.query('SELECT heroku_app_name FROM bots WHERE app_name = $1', [appName]);
    if (!bot.rows.length) return res.status(404).json({ error: 'Bot not found' });
    await restartHerokuDynos(bot.rows[0].heroku_app_name || appName);
    res.json({ success: true, message: 'Bot dynos restarted!' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/delete-app', async (req, res) => {
  const { appName } = req.body;
  try {
    const bot = await pool.query('SELECT heroku_app_name FROM bots WHERE app_name = $1', [appName]);
    if (!bot.rows.length) return res.status(404).json({ error: 'Bot not found' });
    await deleteHerokuApp(bot.rows[0].heroku_app_name || appName);
    await pool.query('DELETE FROM bots WHERE app_name = $1', [appName]);
    res.json({ success: true, message: 'Bot deleted from Heroku and database.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/app-status', async (req, res) => {
  const { appName } = req.body;
  try {
    const info = await getHerokuAppInfo(appName);
    if (!info) return res.json({ status: 'unknown' });
    res.json({
      status: info.maintenance ? 'maintenance' : 'running',
      webUrl: info.web_url,
      updatedAt: info.updated_at
    });
  } catch (e) { res.json({ status: 'error', error: e.message }); }
});

app.post('/api/buy-plan', (req, res) => {
  const { planName, price, githubUsername } = req.body;
  const msg = `I want to buy the ${planName} plan (${price}). My GitHub: ${githubUsername}`;
  res.json({ whatsappLink: `https://wa.me/923009842133?text=${encodeURIComponent(msg)}` });
});

// -------------------- ADMIN --------------------
app.post('/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) return res.json({ success: true });
  res.status(401).json({ error: 'Invalid password' });
});

app.post('/admin/update-password', (req, res) => {
  if (req.body.currentPassword !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Current password incorrect' });
  ADMIN_PASSWORD = req.body.newPassword;
  res.json({ success: true });
});

app.post('/admin/users', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { rows } = await pool.query(`
    SELECT u.*, COUNT(b.app_name) as active_bots 
    FROM users u LEFT JOIN bots b ON u.github_username = b.github_username 
    GROUP BY u.github_username ORDER BY u.created_at DESC
  `);
  res.json({ users: rows });
});

app.post('/admin/update-user', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { githubUsername, isApproved, isBanned, maxBots, expiryDate, subscriptionPlan } = req.body;
  await pool.query(
    `UPDATE users SET is_approved=COALESCE($2,is_approved), is_banned=COALESCE($3,is_banned),
     max_bots=COALESCE($4,max_bots), expiry_date=COALESCE($5::TIMESTAMP,expiry_date),
     subscription_plan=COALESCE($6,subscription_plan) WHERE github_username=$1`,
    [githubUsername.toLowerCase(), isApproved, isBanned, maxBots, expiryDate || null, subscriptionPlan]
  );
  res.json({ success: true });
});

app.post('/admin/delete-user', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const bots = await pool.query('SELECT heroku_app_name FROM bots WHERE github_username = $1', [req.body.githubUsername.toLowerCase()]);
  for (const b of bots.rows) if (b.heroku_app_name) await deleteHerokuApp(b.heroku_app_name).catch(() => {});
  await pool.query('DELETE FROM users WHERE github_username = $1', [req.body.githubUsername.toLowerCase()]);
  res.json({ success: true });
});

app.post('/admin/plans', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { rows } = await pool.query('SELECT * FROM plans ORDER BY id');
  res.json({ plans: rows });
});

app.post('/admin/create-plan', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { name, price, duration_days, max_bots, features } = req.body;
  await pool.query('INSERT INTO plans (name, price, duration_days, max_bots, features) VALUES ($1,$2,$3,$4,$5)', [name, price, duration_days, max_bots, features]);
  res.json({ success: true });
});

app.post('/admin/update-plan', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { id, name, price, duration_days, max_bots, features, is_active } = req.body;
  await pool.query('UPDATE plans SET name=$1,price=$2,duration_days=$3,max_bots=$4,features=$5,is_active=$6 WHERE id=$7', [name, price, duration_days, max_bots, features, is_active, id]);
  res.json({ success: true });
});

app.post('/admin/delete-plan', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  await pool.query('DELETE FROM plans WHERE id=$1', [req.body.id]);
  res.json({ success: true });
});

app.post('/get-all-apps', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { rows } = await pool.query('SELECT * FROM bots ORDER BY created_at DESC');
  res.json({ apps: rows });
});

app.post('/delete-multiple-apps', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const results = { success: [], failed: [] };
  for (const { name } of (req.body.apps || [])) {
    try {
      const bot = await pool.query('SELECT heroku_app_name FROM bots WHERE app_name=$1', [name]);
      if (bot.rows[0]?.heroku_app_name) await deleteHerokuApp(bot.rows[0].heroku_app_name).catch(() => {});
      await pool.query('DELETE FROM bots WHERE app_name=$1', [name]);
      results.success.push(name);
    } catch { results.failed.push(name); }
  }
  res.json({ success: true, results });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`REDX Backend (Heroku) on port ${PORT}`));
