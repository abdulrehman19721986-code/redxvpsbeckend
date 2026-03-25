const express = require('express');
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

// -------------------- IN-MEMORY STORAGE --------------------
// Data structures
let users = {};          // key: github_username (lowercase)
let bots = {};           // key: app_name
let plans = {};          // key: plan_id (e.g., 'free', 'pro', 'premium')
let announcements = {};  // key: announcement_id

// Initialize default plans
function initPlans() {
  if (Object.keys(plans).length === 0) {
    plans = {
      free: {
        id: 'free',
        name: 'free',
        price: 'Free',
        duration_days: 36500,
        max_bots: 2,
        features: ['2 bots', 'Basic features', 'Community support'],
        is_active: true
      },
      pro: {
        id: 'pro',
        name: 'pro',
        price: '$5/month',
        duration_days: 30,
        max_bots: 5,
        features: ['5 bots', 'Advanced features', 'Priority support'],
        is_active: true
      },
      premium: {
        id: 'premium',
        name: 'premium',
        price: '$10/month',
        duration_days: 30,
        max_bots: 10,
        features: ['10 bots', 'All features', 'VIP support', 'Early access'],
        is_active: true
      }
    };
  }
}
initPlans();

// Initialize a default user for testing (optional)
function initTestUser() {
  if (!users['abdulrehman19721986']) {
    users['abdulrehman19721986'] = {
      github_username: 'abdulrehman19721986',
      is_approved: true,
      is_banned: false,
      max_bots: 2,
      deployment_count: 0,
      subscription_plan: 'free',
      expiry_date: null,
      created_at: Date.now()
    };
  }
}
initTestUser();

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
    message: 'REDX Bot Deployer Backend (Heroku + In-Memory)',
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

app.get('/api/plans', (req, res) => {
  const activePlans = Object.values(plans).filter(p => p.is_active);
  res.json({ plans: activePlans });
});

app.post('/check-fork', async (req, res) => {
  const { githubUsername } = req.body;
  if (!githubUsername) return res.status(400).json({ error: 'Username required' });

  const forkInfo = await checkFork(githubUsername);
  const userKey = githubUsername.toLowerCase();
  let userData = users[userKey];

  if (!userData) {
    userData = {
      github_username: userKey,
      is_approved: true,
      is_banned: false,
      max_bots: 2,
      deployment_count: 0,
      subscription_plan: 'free',
      created_at: Date.now()
    };
    users[userKey] = userData;
  }

  const userBots = Object.values(bots).filter(b => b.github_username === userKey);
  res.json({
    hasFork: forkInfo.hasFork,
    forkUrl: forkInfo.forkUrl,
    isApproved: userData.is_approved,
    isBanned: userData.is_banned,
    maxBots: userData.max_bots,
    deploymentCount: userData.deployment_count,
    expiryDate: userData.expiry_date,
    subscriptionPlan: userData.subscription_plan,
    deployedBots: userBots.map(b => ({
      app_name: b.app_name,
      heroku_app_name: b.heroku_app_name,
      created_at: b.created_at,
      status: b.status
    })),
    currentBots: userBots.length
  });
});

app.post('/deploy', async (req, res) => {
  const { githubUsername, sessionId, appName: customAppName, ...config } = req.body;
  if (!githubUsername || !sessionId) return res.status(400).json({ error: 'Missing fields' });

  const userKey = githubUsername.toLowerCase();
  const userData = users[userKey];
  if (!userData) return res.status(403).json({ error: 'User not found' });
  if (userData.is_banned) return res.status(403).json({ error: 'User is banned' });
  if (!userData.is_approved) return res.status(403).json({ error: 'User not approved' });

  const currentBotCount = Object.values(bots).filter(b => b.github_username === userKey).length;
  if (currentBotCount >= userData.max_bots) {
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

    // 5. Save bot in memory
    const botId = baseName;
    bots[botId] = {
      app_name: botId,
      heroku_app_name: app.name,
      github_username: userKey,
      created_at: Date.now(),
      status: 'deploying',
      config: envVars
    };

    // Update user deployment count
    userData.deployment_count = (userData.deployment_count || 0) + 1;

    res.json({
      success: true,
      appName: botId,
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
app.post('/get-config', (req, res) => {
  const { appName } = req.body;
  const bot = bots[appName];
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  res.json({ success: true, config: bot.config || {} });
});

app.post('/update-config', async (req, res) => {
  const { appName, config } = req.body;
  const bot = bots[appName];
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  const herokuAppName = bot.heroku_app_name;

  try {
    await setHerokuConfigVars(herokuAppName, config);
    bot.config = config;
    res.json({ success: true, message: 'Config updated' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/bot-logs', (req, res) => {
  const { appName } = req.body;
  const bot = bots[appName];
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  res.json({ success: true, logs: 'Logs feature not yet implemented. Check Heroku dashboard.' });
});

app.post('/restart-app', async (req, res) => {
  const { appName } = req.body;
  const bot = bots[appName];
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  const herokuAppName = bot.heroku_app_name;
  try {
    await herokuRequest('DELETE', `/apps/${herokuAppName}/dynos`);
    res.json({ success: true, message: 'Restart initiated' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/delete-app', async (req, res) => {
  const { appName, githubUsername } = req.body;
  const bot = bots[appName];
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  const herokuAppName = bot.heroku_app_name;
  try {
    await deleteHerokuApp(herokuAppName);
    delete bots[appName];
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
app.post('/announcements/list', (req, res) => {
  const active = Object.values(announcements).filter(a => a.active);
  active.sort((a, b) => (a.priority || 1) - (b.priority || 1));
  res.json({ announcements: active });
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

app.post('/admin/users', (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const usersList = Object.values(users).map(u => {
    const activeBots = Object.values(bots).filter(b => b.github_username === u.github_username).length;
    return { ...u, active_bots: activeBots };
  });
  res.json({ users: usersList });
});

app.post('/admin/update-user', (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { githubUsername, isApproved, isBanned, maxBots, expiryDate, subscriptionPlan } = req.body;
  const userKey = githubUsername.toLowerCase();
  const user = users[userKey];
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (isApproved !== undefined) user.is_approved = isApproved;
  if (isBanned !== undefined) user.is_banned = isBanned;
  if (maxBots !== undefined) user.max_bots = maxBots;
  if (expiryDate !== undefined) user.expiry_date = expiryDate;
  if (subscriptionPlan !== undefined) user.subscription_plan = subscriptionPlan;
  res.json({ success: true });
});

app.post('/admin/delete-user', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { githubUsername } = req.body;
  const userKey = githubUsername.toLowerCase();
  const userBots = Object.values(bots).filter(b => b.github_username === userKey);
  for (const bot of userBots) {
    if (bot.heroku_app_name) {
      await deleteHerokuApp(bot.heroku_app_name).catch(console.error);
    }
    delete bots[bot.app_name];
  }
  delete users[userKey];
  res.json({ success: true });
});

app.post('/admin/plans', (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const plansArray = Object.values(plans).map(p => ({ ...p, id: p.id }));
  res.json({ plans: plansArray });
});

app.post('/admin/create-plan', (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { name, price, duration_days, max_bots, features, is_active } = req.body;
  const id = name.toLowerCase().replace(/[^a-z0-9]/g, '_');
  plans[id] = {
    id,
    name,
    price,
    duration_days,
    max_bots,
    features,
    is_active: is_active !== undefined ? is_active : true
  };
  res.json({ success: true });
});

app.post('/admin/update-plan', (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { id, name, price, duration_days, max_bots, features, is_active } = req.body;
  if (!plans[id]) return res.status(404).json({ error: 'Plan not found' });
  plans[id] = { ...plans[id], name, price, duration_days, max_bots, features, is_active };
  res.json({ success: true });
});

app.post('/admin/delete-plan', (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { id } = req.body;
  delete plans[id];
  res.json({ success: true });
});

app.post('/admin/announcements', (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const annArray = Object.values(announcements).map(a => ({ ...a, id: a.id }));
  annArray.sort((a, b) => (a.priority || 1) - (b.priority || 1));
  res.json({ announcements: annArray });
});

app.post('/admin/create-announcement', (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { title, content, priority, active } = req.body;
  const id = `ann_${Date.now()}`;
  announcements[id] = {
    id,
    title,
    content,
    priority: priority || 1,
    active: active !== undefined ? active : true,
    created_at: Date.now()
  };
  res.json({ success: true });
});

app.post('/admin/update-announcement', (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { id, title, content, priority, active } = req.body;
  if (!announcements[id]) return res.status(404).json({ error: 'Announcement not found' });
  announcements[id] = { ...announcements[id], title, content, priority, active };
  res.json({ success: true });
});

app.post('/admin/delete-announcement', (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { id } = req.body;
  delete announcements[id];
  res.json({ success: true });
});

app.post('/get-all-apps', (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const botsArray = Object.values(bots).map(b => ({ ...b, app_name: b.app_name }));
  botsArray.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  res.json({ apps: botsArray });
});

app.post('/delete-multiple-apps', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { apps } = req.body;
  const results = { success: [], failed: [] };
  for (const { name } of apps) {
    try {
      const bot = bots[name];
      if (bot && bot.heroku_app_name) {
        await deleteHerokuApp(bot.heroku_app_name);
      }
      delete bots[name];
      results.success.push(name);
    } catch (err) {
      results.failed.push(name);
    }
  }
  res.json({ success: true, results });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
