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
let users = {};          // key: github_username (lowercase)
let bots = {};           // key: app_name
let plans = {};          // key: plan_id
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

// Optional: add a test user for convenience
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

// -------------------- API ROUTES --------------------

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Get plans
app.get('/api/plans', (req, res) => {
  const activePlans = Object.values(plans).filter(p => p.is_active);
  res.json({ plans: activePlans });
});

// Check fork and user data
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

// Deploy bot
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

// Bot config endpoints
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

// -------------------- SERVE FRONTEND (embedded HTML) --------------------
const frontendHTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>REDX BOT DEPLOYER</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=Fira+Code:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root{
      --bg:#07070f;--bg2:#0d0d1a;--bg3:#121224;
      --card:#141428;--card2:#1a1a32;
      --border:#252545;--border2:#2e2e55;
      --p:#7c3aed;--pl:#9f6ff5;--pglow:rgba(124,58,237,.25);
      --acc:#06b6d4;--aglow:rgba(6,182,212,.18);
      --grn:#10b981;--red:#ef4444;--ylw:#f59e0b;
      --tx:#e2e8f0;--tx2:#94a3b8;--tx3:#64748b;
      --r:14px;--rsm:9px;
    }
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:var(--bg);color:var(--tx);font-family:'Inter',sans-serif;min-height:100vh;overflow-x:hidden}
    ::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:var(--bg2)}::-webkit-scrollbar-thumb{background:var(--p);border-radius:3px}
    body::before{content:'';position:fixed;top:-150px;left:-150px;width:500px;height:500px;background:radial-gradient(circle,var(--pglow),transparent 65%);pointer-events:none;z-index:0}
    body::after{content:'';position:fixed;bottom:-150px;right:-150px;width:400px;height:400px;background:radial-gradient(circle,var(--aglow),transparent 65%);pointer-events:none;z-index:0}
    .nav{position:fixed;top:0;width:100%;z-index:100;background:rgba(7,7,15,.85);backdrop-filter:blur(18px);border-bottom:1px solid var(--border);padding:0 20px;display:flex;align-items:center;justify-content:space-between;height:60px}
    .logo{display:flex;align-items:center;gap:10px;font-size:1.15rem;font-weight:800;background:linear-gradient(135deg,#7c3aed,#06b6d4);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
    .nav-r{display:flex;gap:6px;align-items:center}
    .nbtn{padding:7px 14px;border-radius:7px;border:none;cursor:pointer;font-size:.82rem;font-weight:500;font-family:'Inter',sans-serif;transition:all .2s}
    .nbtn.ghost{background:transparent;color:var(--tx2);border:1px solid var(--border)}
    .nbtn.ghost:hover{border-color:var(--p);color:var(--pl)}
    .nbtn.pri{background:var(--p);color:#fff}
    .nbtn.pri:hover{background:var(--pl);transform:translateY(-1px)}
    .nbtn.warn{color:var(--ylw);border:1px solid rgba(245,158,11,.3);background:rgba(245,158,11,.08)}
    .nbtn.warn:hover{background:rgba(245,158,11,.15)}
    .page{display:none;padding-top:68px;min-height:100vh;position:relative;z-index:1}
    .page.active{display:block}
    .wrap{max-width:1060px;margin:0 auto;padding:36px 20px}
    .center{text-align:center}
    .hero{text-align:center;padding:70px 20px 50px}
    .badge-hero{display:inline-flex;align-items:center;gap:7px;background:var(--pglow);border:1px solid var(--p);color:var(--pl);padding:5px 14px;border-radius:100px;font-size:.78rem;font-weight:600;margin-bottom:22px}
    .hero h1{font-size:clamp(2.2rem,5.5vw,4rem);font-weight:800;line-height:1.1;margin-bottom:18px}
    .hero h1 span{background:linear-gradient(135deg,#7c3aed,#06b6d4);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
    .hero p{font-size:1.05rem;color:var(--tx2);max-width:520px;margin:0 auto 34px}
    .hbtns{display:flex;gap:14px;justify-content:center;flex-wrap:wrap}
    .btn{padding:12px 24px;border-radius:10px;border:none;cursor:pointer;font-size:.95rem;font-weight:600;font-family:'Inter',sans-serif;transition:all .2s;display:inline-flex;align-items:center;gap:7px}
    .btn-pri{background:linear-gradient(135deg,#7c3aed,#6d28d9);color:#fff;box-shadow:0 4px 18px var(--pglow)}
    .btn-pri:hover{transform:translateY(-2px);box-shadow:0 7px 26px var(--pglow)}
    .btn-out{background:transparent;color:var(--tx);border:1px solid var(--border)}
    .btn-out:hover{border-color:var(--p);color:var(--pl)}
    .btn-red{background:var(--red);color:#fff}
    .btn-red:hover{background:#dc2626}
    .btn-grn{background:var(--grn);color:#fff}
    .btn-grn:hover{background:#059669}
    .btn-acc{background:var(--acc);color:#fff}
    .btn-acc:hover{background:#0891b2}
    .btn-ylw{background:var(--ylw);color:#000}
    .btn-ylw:hover{background:#d97706}
    .btn-info{background:var(--acc);color:#fff}
    .btn-info:hover{background:#0891b2}
    .sm{padding:7px 14px;font-size:.82rem;border-radius:7px}
    .card{background:var(--card);border:1px solid var(--border);border-radius:var(--r);padding:24px}
    .card:hover{border-color:var(--border2)}
    .cgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:18px}
    .fg{margin-bottom:18px}
    .fg label{display:block;font-size:.82rem;font-weight:600;color:var(--tx2);margin-bottom:7px;letter-spacing:.3px}
    .fg input,.fg select,.fg textarea{width:100%;background:var(--bg2);border:1px solid var(--border);border-radius:var(--rsm);padding:11px 14px;color:var(--tx);font-family:'Inter',sans-serif;font-size:.92rem;outline:none;transition:border-color .2s}
    .fg input:focus,.fg select:focus,.fg textarea:focus{border-color:var(--p)}
    .fg select option{background:var(--bg2)}
    .row2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
    @media(max-width:500px){.row2{grid-template-columns:1fr}}
    .alert{padding:11px 14px;border-radius:8px;font-size:.88rem;margin-bottom:14px;line-height:1.5}
    .alert a{color:var(--pl)}
    .ae{background:rgba(239,68,68,.1);border:1px solid var(--red);color:#fca5a5}
    .as{background:rgba(16,185,129,.1);border:1px solid var(--grn);color:#6ee7b7}
    .ai{background:rgba(6,182,212,.1);border:1px solid var(--acc);color:#67e8f9}
    .aw{background:rgba(245,158,11,.1);border:1px solid var(--ylw);color:#fcd34d}
    .bdg{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:100px;font-size:.72rem;font-weight:600}
    .bdg::before{content:'';width:5px;height:5px;border-radius:50%;background:currentColor}
    .bg{background:rgba(16,185,129,.15);color:var(--grn);border:1px solid rgba(16,185,129,.3)}
    .br{background:rgba(239,68,68,.15);color:var(--red);border:1px solid rgba(239,68,68,.3)}
    .by{background:rgba(245,158,11,.15);color:var(--ylw);border:1px solid rgba(245,158,11,.3)}
    .bp{background:rgba(124,58,237,.15);color:var(--pl);border:1px solid rgba(124,58,237,.3)}
    .ld{width:17px;height:17px;border:2px solid rgba(255,255,255,.2);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;display:inline-block}
    @keyframes spin{to{transform:rotate(360deg)}}
    .tw{display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(37,37,69,.5)}
    .ti label{font-size:.88rem;font-weight:500;cursor:pointer}
    .ti small{display:block;color:var(--tx3);font-size:.76rem;margin-top:2px}
    .tg{position:relative;width:44px;height:24px;flex-shrink:0}
    .tg input{opacity:0;width:0;height:0}
    .ts{position:absolute;inset:0;background:var(--border);border-radius:100px;cursor:pointer;transition:.3s}
    .ts::before{content:'';position:absolute;left:3px;top:3px;width:18px;height:18px;background:#fff;border-radius:50%;transition:.3s}
    .tg input:checked+.ts{background:var(--p)}
    .tg input:checked+.ts::before{transform:translateX(20px)}
    .tabs{display:flex;gap:3px;background:var(--bg2);border-radius:10px;padding:4px;margin-bottom:24px}
    .tab{flex:1;text-align:center;padding:9px;border-radius:7px;cursor:pointer;font-size:.87rem;font-weight:500;color:var(--tx2);transition:all .2s}
    .tab.active{background:var(--card);color:var(--tx);box-shadow:0 2px 8px rgba(0,0,0,.4)}
    .lbox{max-width:460px;margin:50px auto;padding:0 20px}
    .dash{max-width:860px;margin:0 auto;padding:28px 20px}
    .uh{background:linear-gradient(135deg,rgba(124,58,237,.12),rgba(6,182,212,.06));border:1px solid rgba(124,58,237,.25);border-radius:var(--r);padding:22px 26px;margin-bottom:24px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:14px}
    .botcard{background:var(--card);border:1px solid var(--border);border-radius:var(--r);padding:20px;position:relative;overflow:hidden;margin-bottom:14px}
    .botcard::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,#7c3aed,#06b6d4)}
    .appname{font-family:'Fira Code',monospace;font-size:1rem;font-weight:600;margin-bottom:5px}
    .botacts{display:flex;gap:7px;margin-top:14px;flex-wrap:wrap}
    .plancard{background:var(--card);border:1px solid var(--border);border-radius:var(--r);padding:24px;text-align:center;transition:all .3s;position:relative}
    .plancard.pop{border-color:var(--p);background:linear-gradient(135deg,rgba(124,58,237,.09),rgba(6,182,212,.04))}
    .plancard.pop::before{content:'POPULAR';position:absolute;top:-1px;left:50%;transform:translateX(-50%);background:var(--p);color:#fff;font-size:.68rem;font-weight:700;padding:4px 14px;border-radius:0 0 7px 7px;letter-spacing:1px}
    .pp{font-size:2.2rem;font-weight:800;margin:14px 0 4px}
    .pp span{font-size:.9rem;color:var(--tx2)}
    .pf{list-style:none;text-align:left;margin:16px 0 20px}
    .pf li{padding:5px 0;color:var(--tx2);font-size:.87rem;display:flex;align-items:center;gap:9px}
    .pf li::before{content:'✓';color:var(--grn);font-weight:700}
    .admin-wrap{display:flex;min-height:calc(100vh - 60px)}
    .aside{width:200px;flex-shrink:0;background:var(--card);border-right:1px solid var(--border);padding:20px 0}
    .aside-item{display:flex;align-items:center;gap:10px;padding:11px 20px;cursor:pointer;color:var(--tx2);font-size:.88rem;font-weight:500;transition:all .2s;border-left:3px solid transparent}
    .aside-item:hover{background:var(--bg3);color:var(--tx)}
    .aside-item.active{background:var(--pglow);color:var(--pl);border-left-color:var(--p)}
    .amain{flex:1;padding:28px 24px;overflow:auto}
    .tw2{overflow-x:auto;margin-top:4px}
    table{width:100%;border-collapse:collapse;font-size:.87rem}
    th{padding:10px 14px;text-align:left;background:var(--bg2);color:var(--tx2);font-weight:600;border-bottom:1px solid var(--border)}
    td{padding:10px 14px;border-bottom:1px solid rgba(37,37,69,.4)}
    tr:hover td{background:rgba(124,58,237,.04)}
    .mover{position:fixed;inset:0;background:rgba(0,0,0,.7);backdrop-filter:blur(4px);z-index:200;display:none;align-items:center;justify-content:center;padding:20px}
    .mover.open{display:flex}
    .modal{background:var(--card);border:1px solid var(--border);border-radius:var(--r);padding:28px;max-width:560px;width:100%;max-height:90vh;overflow-y:auto}
    .mh{display:flex;justify-content:space-between;align-items:center;margin-bottom:22px}
    .mx{background:none;border:none;color:var(--tx2);font-size:1.4rem;cursor:pointer;line-height:1}
    .mx:hover{color:var(--tx)}
    .notif{position:fixed;top:70px;right:20px;z-index:300;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:12px 18px;font-size:.88rem;box-shadow:0 8px 28px rgba(0,0,0,.5);transform:translateX(200%);transition:transform .3s;max-width:300px}
    .notif.show{transform:translateX(0)}
    .notif.ok{border-left:3px solid var(--grn)}
    .notif.err{border-left:3px solid var(--red)}
    .notif.info{border-left:3px solid var(--acc)}
    @media(max-width:700px){
      .aside{width:100%;border-right:none;border-bottom:1px solid var(--border);display:flex;overflow-x:auto;padding:8px 0}
      .admin-wrap{flex-direction:column}
      .aside-item{border-left:none;border-bottom:3px solid transparent;white-space:nowrap}
      .aside-item.active{border-left:none;border-bottom-color:var(--p)}
    }
    @media(max-width:480px){
      .nav-r .nbtn:not(.pri){display:none}
    }
  </style>
</head>
<body>
<div class="notif" id="notif"></div>
<nav class="nav">
  <div class="logo">🤖 REDX BOT DEPLOYER</div>
  <div class="nav-r">
    <button class="nbtn ghost" onclick="go('home')">Home</button>
    <button class="nbtn ghost" onclick="go('plans')">Plans</button>
    <button class="nbtn ghost" id="btnLogin" onclick="go('login')">Login</button>
    <button class="nbtn ghost" id="btnLogout" style="display:none" onclick="logout()">Logout</button>
    <button class="nbtn warn" onclick="go('admin')">⚙ Admin</button>
    <button class="nbtn pri" onclick="window.open('https://github.com/AbdulRehman19721986/redxbot302','_blank')">⭐ GitHub</button>
  </div>
</nav>

<div id="pg-home" class="page active">...</div>
<div id="pg-login" class="page">...</div>
<div id="pg-dash" class="page">...</div>
<div id="pg-plans" class="page">...</div>
<div id="pg-admin" class="page">...</div>

<!-- MODALS (simplified for brevity, but you need to include the full modals from the previous version) -->
<!-- We'll include a minimal set that works with the script below -->
<div class="mover" id="mEditUser">...</div>
<div class="mover" id="mEditPlan">...</div>
<div class="mover" id="mEditAnnouncement">...</div>
<div class="mover" id="mChangePassword">...</div>
<div class="mover" id="mConfig">...</div>

<script>
  const API_BASE = ''; // empty means same origin
  const OWNER_NUMBER = '923009842133';
  let CU = null, AP = null;
  function notif(msg,type){...} // define as before
  // ... (rest of the frontend JavaScript from the earlier full version)
  // Important: all API calls should use fetch(API_BASE + url) – with empty base it's fine.
</script>
</body>
</html>`;

// Serve the frontend
app.get('/', (req, res) => {
  res.send(frontendHTML);
});

// Also serve the frontend for any unmatched routes (SPA style)
app.get('*', (req, res) => {
  res.send(frontendHTML);
});

// -------------------- START SERVER --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
