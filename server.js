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
const RAILWAY_TOKEN = process.env.RAILWAY_TOKEN || 'ac073eb8-36dd-4bf6-a4d2-d83445367615';
const RAILWAY_API = 'https://backboard.railway.app/graphql/v2';

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
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

    await client.query(`
      CREATE TABLE IF NOT EXISTS bots (
        app_name TEXT PRIMARY KEY,
        railway_project_id TEXT,
        github_username TEXT REFERENCES users(github_username) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW(),
        status TEXT DEFAULT 'running'
      );
    `);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE bots ADD COLUMN railway_project_id TEXT;
      EXCEPTION WHEN duplicate_column THEN END; $$;
    `);

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

// Railway GraphQL helper with detailed error
async function railwayGraphQL(query, variables = {}) {
  try {
    const response = await axios.post(RAILWAY_API, {
      query,
      variables
    }, {
      headers: {
        'Authorization': `Bearer ${RAILWAY_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    if (response.data.errors) {
      const errorMessages = response.data.errors.map(e => e.message).join('; ');
      throw new Error(`GraphQL errors: ${errorMessages}`);
    }
    return response.data.data;
  } catch (err) {
    if (err.response) {
      // The request was made and the server responded with a status code outside 2xx
      console.error('Railway API response error:', {
        status: err.response.status,
        data: err.response.data
      });
    } else if (err.request) {
      console.error('Railway API no response:', err.request);
    } else {
      console.error('Railway API error:', err.message);
    }
    throw err;
  }
}

// Create Railway project with unique name
async function createRailwayProject(baseName) {
  // Ensure name is valid: lowercase, alphanumeric and hyphens only
  const safeBase = baseName.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const projectName = `${safeBase}-${crypto.randomBytes(4).toString('hex')}`;

  const query = `
    mutation CreateProject($name: String!) {
      projectCreate(input: { name: $name }) {
        project {
          id
          name
        }
      }
    }
  `;
  const data = await railwayGraphQL(query, { name: projectName });
  return data.projectCreate.project;
}

// Set environment variables in Railway project
async function setRailwayVariables(projectId, envVars) {
  const query = `
    mutation VariableCollectionUpsert($projectId: String!, $variables: [VariableInput!]!) {
      variableCollectionUpsert(input: { projectId: $projectId, variables: $variables }) {
        variables {
          name
          value
        }
      }
    }
  `;
  const variables = Object.entries(envVars).map(([key, value]) => ({
    name: key,
    value: String(value)
  }));
  const data = await railwayGraphQL(query, { projectId, variables });
  return data.variableCollectionUpsert;
}

// -------------------- ROOT ROUTE --------------------
app.get('/', (req, res) => {
  res.json({ 
    message: 'REDX Bot Deployer Backend (Railway)',
    status: 'running',
    endpoints: ['/api/health', '/api/plans', '/check-fork', '/deploy', '/admin/login', '/admin/update-password']
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
    'SELECT app_name, railway_project_id, created_at, status FROM bots WHERE github_username = $1',
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
    // 1. Create Railway project with unique name
    const project = await createRailwayProject(baseName);

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
    await setRailwayVariables(project.id, envVars);

    // 3. Save to DB
    await pool.query(
      'INSERT INTO bots (app_name, railway_project_id, github_username, status) VALUES ($1, $2, $3, $4)',
      [baseName, project.id, githubUsername.toLowerCase(), 'running']
    );
    await pool.query(
      'UPDATE users SET deployment_count = deployment_count + 1 WHERE github_username = $1',
      [githubUsername.toLowerCase()]
    );

    res.json({ 
      success: true, 
      appName: baseName,
      railwayProjectId: project.id,
      message: 'Bot deployed to Railway successfully! It may take a few minutes to start.'
    });

  } catch (error) {
    console.error('Deployment error:', error);
    // Send detailed error to frontend
    res.status(500).json({ 
      error: 'Failed to deploy to Railway', 
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Get bot logs – placeholder
app.post('/bot-logs', async (req, res) => {
  const { appName } = req.body;
  res.json({ success: true, logs: 'Logs feature not yet implemented. Check Railway dashboard.' });
});

app.post('/restart-app', async (req, res) => {
  const { appName } = req.body;
  const bot = await pool.query('SELECT railway_project_id FROM bots WHERE app_name = $1', [appName]);
  if (bot.rows.length === 0) return res.status(404).json({ error: 'Bot not found' });
  // Call Railway API to restart (deploy again)
  res.json({ success: false, error: 'Restart not implemented yet.' });
});

app.post('/delete-app', async (req, res) => {
  const { appName, githubUsername } = req.body;
  const bot = await pool.query('SELECT railway_project_id FROM bots WHERE app_name = $1', [appName]);
  if (bot.rows.length === 0) return res.status(404).json({ error: 'Bot not found' });
  const projectId = bot.rows[0].railway_project_id;
  // Call Railway API to delete project (if available)
  await pool.query('DELETE FROM bots WHERE app_name = $1', [appName]);
  res.json({ success: true, message: 'Bot deleted (Railway cleanup not implemented).' });
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

  const bots = await pool.query('SELECT railway_project_id FROM bots WHERE github_username = $1', [githubUsername.toLowerCase()]);
  for (const bot of bots.rows) {
    if (bot.railway_project_id) {
      // Call Railway API to delete project
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
      const bot = await pool.query('SELECT railway_project_id FROM bots WHERE app_name = $1', [name]);
      if (bot.rows.length) {
        // Call Railway API to delete project
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
