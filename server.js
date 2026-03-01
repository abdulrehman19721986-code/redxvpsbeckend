const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const simpleGit = require('simple-git');
const { exec, spawn } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// -------------------- CONFIG --------------------
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'redx';
const BOTS_DIR = path.join(__dirname, 'bots');
const MAIN_REPO = 'https://github.com/AbdulRehman19721986/redxbot302.git';

if (!fsSync.existsSync(BOTS_DIR)) fsSync.mkdirSync(BOTS_DIR, { recursive: true });

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// -------------------- DATABASE INIT --------------------
async function initDb() {
  await pool.query(`
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

    CREATE TABLE IF NOT EXISTS bots (
      app_name TEXT PRIMARY KEY,
      github_username TEXT REFERENCES users(github_username) ON DELETE CASCADE,
      server_id INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT NOW(),
      status TEXT DEFAULT 'running'
    );

    CREATE TABLE IF NOT EXISTS plans (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE,
      price TEXT,
      duration_days INTEGER,
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

  await pool.query(
    `INSERT INTO servers (name, url, api_key, bot_count) 
     VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
    ['Railway Main', 'http://localhost', 'internal', 0]
  );

  const { rows } = await pool.query('SELECT COUNT(*) FROM plans');
  if (parseInt(rows[0].count) === 0) {
    await pool.query(
      `INSERT INTO plans (name, price, duration_days, max_bots, features) VALUES 
       ('free', 'Free', 36500, 2, ARRAY['2 bots', 'Basic features', 'Community support']),
       ('pro', '$5/month', 30, 5, ARRAY['5 bots', 'Advanced features', 'Priority support']),
       ('premium', '$10/month', 30, 10, ARRAY['10 bots', 'All features', 'VIP support', 'Early access'])`
    );
  }
}
initDb().catch(console.error);

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

// Clone user's fork
async function cloneRepo(githubUsername, appName) {
  const repoUrl = `https://github.com/${githubUsername}/redxbot302.git`;
  const dest = path.join(BOTS_DIR, appName);
  try {
    await simpleGit().clone(repoUrl, dest);
    return { success: true };
  } catch (err) {
    console.error('Clone failed:', err.message);
    return { success: false, error: err.message };
  }
}

// Remove discard-api from package.json (recursive)
async function fixPackageJson(botPath) {
  const pkgPath = path.join(botPath, 'package.json');
  try {
    await fs.access(pkgPath);
  } catch {
    return { success: false, error: 'package.json not found' };
  }

  try {
    const content = await fs.readFile(pkgPath, 'utf8');
    const pkg = JSON.parse(content);
    let modified = false;

    // Remove from dependencies
    if (pkg.dependencies && pkg.dependencies['discard-api']) {
      delete pkg.dependencies['discard-api'];
      modified = true;
      console.log(`Removed discard-api from dependencies of ${botPath}`);
    }
    // Remove from devDependencies
    if (pkg.devDependencies && pkg.devDependencies['discard-api']) {
      delete pkg.devDependencies['discard-api'];
      modified = true;
      console.log(`Removed discard-api from devDependencies of ${botPath}`);
    }

    if (modified) {
      await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2));
      return { success: true, fixed: true };
    }
    return { success: true, fixed: false };
  } catch (err) {
    console.error('Error fixing package.json:', err.message);
    return { success: false, error: 'Invalid package.json: ' + err.message };
  }
}

// Install dependencies with fallback
async function installDependencies(botPath) {
  // First fix package.json
  const fixResult = await fixPackageJson(botPath);
  if (!fixResult.success) {
    return { success: false, error: fixResult.error };
  }

  try {
    console.log(`Running npm install in ${botPath}...`);
    await execPromise('npm install --no-audit --no-fund', { cwd: botPath, timeout: 300000 }); // 5 min timeout
    return { success: true, fixed: fixResult.fixed };
  } catch (err) {
    console.error('npm install error:', err.message);
    // Attempt to read npm-debug.log if exists
    let debugLog = '';
    try {
      const logPath = path.join(botPath, 'npm-debug.log');
      debugLog = await fs.readFile(logPath, 'utf8');
    } catch {}
    return { 
      success: false, 
      error: 'npm install failed: ' + err.message,
      details: debugLog.slice(0, 500)
    };
  }
}

// Start bot with PM2, fallback to node
async function startBot(appName, botPath) {
  // Determine main script
  let mainScript = 'index.js';
  try {
    const pkgPath = path.join(botPath, 'package.json');
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
    if (pkg.main) mainScript = pkg.main;
  } catch (e) {
    console.warn('Could not read package.json, using index.js');
  }

  // Try PM2 first
  try {
    console.log(`Starting ${appName} with PM2...`);
    await execPromise(`npx pm2 start ${mainScript} --name "${appName}"`, { cwd: botPath, timeout: 30000 });
    // Wait a bit and check status
    await new Promise(resolve => setTimeout(resolve, 5000));
    const { stdout } = await execPromise(`npx pm2 show "${appName}"`, { cwd: botPath }).catch(() => ({ stdout: '' }));
    if (stdout.includes('online')) {
      await execPromise(`npx pm2 save`, { cwd: botPath });
      return { success: true, method: 'pm2' };
    } else {
      throw new Error('PM2 process not online');
    }
  } catch (pm2Err) {
    console.log(`PM2 failed, trying node directly: ${pm2Err.message}`);
    // Fallback to node
    try {
      const nodeProcess = spawn('node', [mainScript], {
        cwd: botPath,
        detached: true,
        stdio: 'ignore'
      });
      nodeProcess.unref();
      // Wait a bit to see if it crashes
      await new Promise(resolve => setTimeout(resolve, 5000));
      // Check if process is still running
      const { stdout: psOut } = await execPromise(`ps aux | grep "node ${mainScript}" | grep -v grep`);
      if (psOut.includes(mainScript)) {
        return { success: true, method: 'node' };
      } else {
        // Try to get error output
        let stderr = '';
        try {
          const logPath = path.join(botPath, 'nohup.out');
          stderr = await fs.readFile(logPath, 'utf8');
        } catch {}
        throw new Error(`Node process died. Output: ${stderr.slice(0, 200)}`);
      }
    } catch (nodeErr) {
      return { success: false, error: nodeErr.message };
    }
  }
}

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
    'SELECT app_name, created_at, status FROM bots WHERE github_username = $1',
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

  const appName = customAppName || `${githubUsername}-${Date.now()}`.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const botPath = path.join(BOTS_DIR, appName);

  // Clone
  console.log(`Cloning ${githubUsername}/redxbot302 as ${appName}...`);
  const cloneResult = await cloneRepo(githubUsername, appName);
  if (!cloneResult.success) {
    return res.status(500).json({ error: 'Clone failed: ' + cloneResult.error });
  }

  // Write .env
  const envContent = Object.entries({
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
  }).map(([k, v]) => `${k}=${v}`).join('\n');
  await fs.writeFile(path.join(botPath, '.env'), envContent);

  // Install dependencies
  const installResult = await installDependencies(botPath);
  if (!installResult.success) {
    await fs.rm(botPath, { recursive: true, force: true });
    return res.status(500).json({ error: installResult.error, details: installResult.details });
  }

  // Start bot
  const startResult = await startBot(appName, botPath);
  if (!startResult.success) {
    await fs.rm(botPath, { recursive: true, force: true });
    return res.status(500).json({ error: 'Bot failed to start: ' + startResult.error });
  }

  // Save to DB
  await pool.query(
    'INSERT INTO bots (app_name, github_username, status) VALUES ($1, $2, $3)',
    [appName, githubUsername.toLowerCase(), 'running']
  );
  await pool.query(
    'UPDATE users SET deployment_count = deployment_count + 1 WHERE github_username = $1',
    [githubUsername.toLowerCase()]
  );
  await pool.query('UPDATE servers SET bot_count = bot_count + 1 WHERE id = 1');

  const message = installResult.fixed 
    ? `Bot deployed and running (method: ${startResult.method}, removed discard-api)`
    : `Bot deployed and running (method: ${startResult.method})`;

  res.json({ success: true, appName, message });
});

app.post('/bot-logs', async (req, res) => {
  const { appName } = req.body;
  const botPath = path.join(BOTS_DIR, appName);
  try {
    // Try PM2 logs first
    const { stdout } = await execPromise(`npx pm2 logs "${appName}" --lines 50 --nostream`, { cwd: botPath }).catch(() => ({ stdout: '' }));
    if (stdout) {
      return res.json({ success: true, logs: stdout });
    }
    // Fallback to nohup.out or system logs
    const nohupPath = path.join(botPath, 'nohup.out');
    if (fsSync.existsSync(nohupPath)) {
      const logs = await fs.readFile(nohupPath, 'utf8');
      return res.json({ success: true, logs });
    }
    res.json({ success: false, error: 'No logs found' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/restart-app', async (req, res) => {
  const { appName } = req.body;
  try {
    await execPromise(`npx pm2 restart "${appName}"`);
    res.json({ success: true, message: 'Restarted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/delete-app', async (req, res) => {
  const { appName, githubUsername } = req.body;
  const botPath = path.join(BOTS_DIR, appName);

  try {
    await execPromise(`npx pm2 delete "${appName}"`);
  } catch (err) {
    // Ignore
  }

  await fs.rm(botPath, { recursive: true, force: true });
  await pool.query('DELETE FROM bots WHERE app_name = $1', [appName]);
  await pool.query('UPDATE servers SET bot_count = bot_count - 1 WHERE id = 1');
  res.json({ success: true, message: 'Bot deleted' });
});

app.post('/get-config', async (req, res) => {
  const { appName } = req.body;
  const envFile = path.join(BOTS_DIR, appName, '.env');
  try {
    const envContent = await fs.readFile(envFile, 'utf8');
    const config = envContent.split('\n').reduce((acc, line) => {
      const [key, ...valArr] = line.split('=');
      if (key) acc[key] = valArr.join('=');
      return acc;
    }, {});
    res.json({ success: true, config });
  } catch (err) {
    res.status(404).json({ error: 'Config not found' });
  }
});

app.post('/update-config', async (req, res) => {
  const { appName, config } = req.body;
  const botPath = path.join(BOTS_DIR, appName);
  const envContent = Object.entries(config).map(([k, v]) => `${k}=${v}`).join('\n');
  await fs.writeFile(path.join(botPath, '.env'), envContent);
  try {
    await execPromise(`npx pm2 restart "${appName}"`);
    res.json({ success: true, message: 'Config updated and bot restarted' });
  } catch (err) {
    res.status(500).json({ error: 'Restart failed: ' + err.message });
  }
});

app.post('/api/buy-plan', (req, res) => {
  const { planName, price, githubUsername } = req.body;
  const message = `I want to buy the ${planName} plan (${price}). My GitHub: ${githubUsername}`;
  const whatsappLink = `https://wa.me/923009842133?text=${encodeURIComponent(message)}`;
  res.json({ whatsappLink });
});

// -------------------- ADMIN ROUTES --------------------

app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) return res.json({ success: true });
  res.status(401).json({ error: 'Invalid password' });
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

  const bots = await pool.query('SELECT app_name FROM bots WHERE github_username = $1', [githubUsername.toLowerCase()]);
  for (const bot of bots.rows) {
    try {
      await execPromise(`npx pm2 delete "${bot.app_name}"`);
      const botPath = path.join(BOTS_DIR, bot.app_name);
      await fs.rm(botPath, { recursive: true, force: true });
    } catch (e) {}
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

app.post('/admin/servers', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { rows } = await pool.query('SELECT id, name, bot_count, status FROM servers');
  res.json({ servers: rows });
});

app.post('/get-all-apps', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { rows } = await pool.query(`
    SELECT b.app_name, b.github_username, b.created_at, b.status, s.name as server_name
    FROM bots b
    JOIN servers s ON b.server_id = s.id
    ORDER BY b.created_at DESC
  `);
  res.json({ apps: rows });
});

app.post('/delete-multiple-apps', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { apps } = req.body;
  const results = { success: [], failed: [] };
  for (const { name } of apps) {
    try {
      await execPromise(`npx pm2 delete "${name}"`);
      const botPath = path.join(BOTS_DIR, name);
      await fs.rm(botPath, { recursive: true, force: true });
      await pool.query('DELETE FROM bots WHERE app_name = $1', [name]);
      results.success.push(name);
    } catch {
      results.failed.push(name);
    }
  }
  res.json({ success: true, results });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
