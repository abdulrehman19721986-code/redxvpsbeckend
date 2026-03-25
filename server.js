const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());

// -------------------- CONFIG --------------------
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'redx';
const HEROKU_API_KEY = process.env.HEROKU_API_KEY;
const HEROKU_API = 'https://api.heroku.com';

// Initialize Firebase Admin SDK
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
}
const db = admin.database();

// -------------------- DATABASE HELPERS --------------------
const ref = (path) => db.ref(path);

async function getData(path) {
  const snapshot = await ref(path).once('value');
  return snapshot.val();
}

async function setData(path, value) {
  await ref(path).set(value);
}

async function updateData(path, value) {
  await ref(path).update(value);
}

async function pushData(path, value) {
  const newRef = ref(path).push();
  await newRef.set(value);
  return newRef.key;
}

async function deleteData(path) {
  await ref(path).remove();
}

// -------------------- INITIAL DATA --------------------
async function initializeData() {
  // Check if plans exist
  const plans = await getData('plans');
  if (!plans) {
    const defaultPlans = {
      free: {
        name: 'free',
        price: 'Free',
        duration_days: 36500,
        max_bots: 2,
        features: ['2 bots', 'Basic features', 'Community support'],
        is_active: true
      },
      pro: {
        name: 'pro',
        price: '$5/month',
        duration_days: 30,
        max_bots: 5,
        features: ['5 bots', 'Advanced features', 'Priority support'],
        is_active: true
      },
      premium: {
        name: 'premium',
        price: '$10/month',
        duration_days: 30,
        max_bots: 10,
        features: ['10 bots', 'All features', 'VIP support', 'Early access'],
        is_active: true
      }
    };
    await setData('plans', defaultPlans);
  }
}
initializeData().catch(console.error);

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
    message: 'REDX Bot Deployer Backend (Heroku + Firebase)',
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
  const plans = await getData('plans');
  const activePlans = plans ? Object.values(plans).filter(p => p.is_active) : [];
  res.json({ plans: activePlans });
});

app.post('/check-fork', async (req, res) => {
  const { githubUsername } = req.body;
  if (!githubUsername) return res.status(400).json({ error: 'Username required' });

  const forkInfo = await checkFork(githubUsername);
  const userKey = githubUsername.toLowerCase();
  let userData = await getData(`users/${userKey}`);

  if (!userData) {
    const newUser = {
      github_username: userKey,
      is_approved: true,
      is_banned: false,
      max_bots: 2,
      deployment_count: 0,
      subscription_plan: 'free',
      created_at: Date.now()
    };
    await setData(`users/${userKey}`, newUser);
    userData = newUser;
  }

  const botsSnapshot = await ref(`bots`).orderByChild('github_username').equalTo(userKey).once('value');
  const bots = [];
  botsSnapshot.forEach(child => {
    bots.push({
      app_name: child.key,
      heroku_app_name: child.val().heroku_app_name,
      created_at: child.val().created_at,
      status: child.val().status
    });
  });

  res.json({
    hasFork: forkInfo.hasFork,
    forkUrl: forkInfo.forkUrl,
    isApproved: userData.is_approved,
    isBanned: userData.is_banned,
    maxBots: userData.max_bots,
    deploymentCount: userData.deployment_count,
    expiryDate: userData.expiry_date,
    subscriptionPlan: userData.subscription_plan,
    deployedBots: bots,
    currentBots: bots.length
  });
});

app.post('/deploy', async (req, res) => {
  const { githubUsername, sessionId, appName: customAppName, ...config } = req.body;
  if (!githubUsername || !sessionId) return res.status(400).json({ error: 'Missing fields' });

  const userKey = githubUsername.toLowerCase();
  const userData = await getData(`users/${userKey}`);
  if (!userData) return res.status(403).json({ error: 'User not found' });
  if (userData.is_banned) return res.status(403).json({ error: 'User is banned' });
  if (!userData.is_approved) return res.status(403).json({ error: 'User not approved' });

  const botsSnapshot = await ref(`bots`).orderByChild('github_username').equalTo(userKey).once('value');
  const currentBotCount = botsSnapshot.numChildren();
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

    // 5. Save to Firebase
    const botId = baseName; // use app_name as key
    await setData(`bots/${botId}`, {
      app_name: botId,
      heroku_app_name: app.name,
      github_username: userKey,
      created_at: Date.now(),
      status: 'deploying',
      config: envVars
    });

    await updateData(`users/${userKey}`, {
      deployment_count: (userData.deployment_count || 0) + 1
    });

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
app.post('/get-config', async (req, res) => {
  const { appName } = req.body;
  const bot = await getData(`bots/${appName}`);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  res.json({ success: true, config: bot.config || {} });
});

app.post('/update-config', async (req, res) => {
  const { appName, config } = req.body;
  const bot = await getData(`bots/${appName}`);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  const herokuAppName = bot.heroku_app_name;

  try {
    await setHerokuConfigVars(herokuAppName, config);
    await updateData(`bots/${appName}`, { config });
    res.json({ success: true, message: 'Config updated' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/bot-logs', async (req, res) => {
  const { appName } = req.body;
  const bot = await getData(`bots/${appName}`);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  res.json({ success: true, logs: 'Logs feature not yet implemented. Check Heroku dashboard.' });
});

app.post('/restart-app', async (req, res) => {
  const { appName } = req.body;
  const bot = await getData(`bots/${appName}`);
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
  const bot = await getData(`bots/${appName}`);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  const herokuAppName = bot.heroku_app_name;
  try {
    await deleteHerokuApp(herokuAppName);
    await deleteData(`bots/${appName}`);
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
  const announcements = await getData('announcements');
  const active = announcements ? Object.values(announcements).filter(a => a.active) : [];
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

app.post('/admin/users', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const users = await getData('users');
  const usersList = [];
  if (users) {
    for (const [key, value] of Object.entries(users)) {
      const botsCount = await getData(`bots`) ? Object.values(await getData(`bots`)).filter(b => b.github_username === key).length : 0;
      usersList.push({ ...value, active_bots: botsCount });
    }
  }
  res.json({ users: usersList });
});

app.post('/admin/update-user', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { githubUsername, isApproved, isBanned, maxBots, expiryDate, subscriptionPlan } = req.body;
  const updates = {};
  if (isApproved !== undefined) updates.is_approved = isApproved;
  if (isBanned !== undefined) updates.is_banned = isBanned;
  if (maxBots !== undefined) updates.max_bots = maxBots;
  if (expiryDate !== undefined) updates.expiry_date = expiryDate;
  if (subscriptionPlan !== undefined) updates.subscription_plan = subscriptionPlan;
  await updateData(`users/${githubUsername.toLowerCase()}`, updates);
  res.json({ success: true });
});

app.post('/admin/delete-user', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { githubUsername } = req.body;
  const userKey = githubUsername.toLowerCase();
  const bots = await getData('bots');
  if (bots) {
    for (const [botId, bot] of Object.entries(bots)) {
      if (bot.github_username === userKey && bot.heroku_app_name) {
        await deleteHerokuApp(bot.heroku_app_name).catch(console.error);
        await deleteData(`bots/${botId}`);
      }
    }
  }
  await deleteData(`users/${userKey}`);
  res.json({ success: true });
});

app.post('/admin/plans', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const plans = await getData('plans');
  const plansArray = plans ? Object.entries(plans).map(([id, p]) => ({ id, ...p })) : [];
  res.json({ plans: plansArray });
});

app.post('/admin/create-plan', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { name, price, duration_days, max_bots, features, is_active } = req.body;
  const newId = name.toLowerCase().replace(/[^a-z0-9]/g, '_');
  await setData(`plans/${newId}`, {
    name, price, duration_days, max_bots, features, is_active: is_active !== undefined ? is_active : true
  });
  res.json({ success: true });
});

app.post('/admin/update-plan', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { id, name, price, duration_days, max_bots, features, is_active } = req.body;
  await setData(`plans/${id}`, { name, price, duration_days, max_bots, features, is_active });
  res.json({ success: true });
});

app.post('/admin/delete-plan', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { id } = req.body;
  await deleteData(`plans/${id}`);
  res.json({ success: true });
});

app.post('/admin/announcements', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const announcements = await getData('announcements');
  const annArray = announcements ? Object.entries(announcements).map(([id, a]) => ({ id, ...a })) : [];
  annArray.sort((a, b) => (a.priority || 1) - (b.priority || 1));
  res.json({ announcements: annArray });
});

app.post('/admin/create-announcement', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { title, content, priority, active } = req.body;
  const newId = `ann_${Date.now()}`;
  await setData(`announcements/${newId}`, {
    title, content, priority: priority || 1, active: active !== undefined ? active : true, created_at: Date.now()
  });
  res.json({ success: true });
});

app.post('/admin/update-announcement', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { id, title, content, priority, active } = req.body;
  await setData(`announcements/${id}`, { title, content, priority, active });
  res.json({ success: true });
});

app.post('/admin/delete-announcement', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { id } = req.body;
  await deleteData(`announcements/${id}`);
  res.json({ success: true });
});

app.post('/get-all-apps', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const bots = await getData('bots');
  const botsArray = bots ? Object.entries(bots).map(([id, b]) => ({ app_name: id, ...b })) : [];
  botsArray.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  res.json({ apps: botsArray });
});

app.post('/delete-multiple-apps', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { apps } = req.body;
  const results = { success: [], failed: [] };
  for (const { name } of apps) {
    try {
      const bot = await getData(`bots/${name}`);
      if (bot && bot.heroku_app_name) {
        await deleteHerokuApp(bot.heroku_app_name);
      }
      await deleteData(`bots/${name}`);
      results.success.push(name);
    } catch (err) {
      results.failed.push(name);
    }
  }
  res.json({ success: true, results });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
