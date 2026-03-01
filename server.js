// server.js
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// ---------- Environment ----------
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'redx';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN; // optional, for higher rate limits
const BOTS_DIR = process.env.BOTS_DIR || path.join(__dirname, 'bots'); // directory to store bot clones
const REPO_URL = 'https://github.com/AbdulRehman19721986/redxbot302.git';

if (!fs.existsSync(BOTS_DIR)) fs.mkdirSync(BOTS_DIR, { recursive: true });

// ---------- MongoDB Models ----------
const userSchema = new mongoose.Schema({
  githubUsername: { type: String, unique: true, required: true },
  isApproved: { type: Boolean, default: true },
  maxBots: { type: Number, default: 1 },
  expiryDate: Date,
  subscriptionPlan: String,
  deployedBots: [{ appName: String, createdAt: Date }]
}, { timestamps: true });

const planSchema = new mongoose.Schema({
  name: String,
  price: String,
  duration: String,
  maxBots: Number,
  features: [String],
  isActive: { type: Boolean, default: true }
});

const User = mongoose.model('User', userSchema);
const Plan = mongoose.model('Plan', planSchema);

// ---------- In‑memory process tracking ----------
const runningProcesses = {}; // key: appName, value: child process object

// ---------- Helper: Check GitHub fork ----------
async function checkFork(username) {
  try {
    const headers = GITHUB_TOKEN ? { Authorization: `token ${GITHUB_TOKEN}` } : {};
    const url = `https://api.github.com/repos/AbdulRehman19721986/redxbot302/forks?per_page=100`;
    const resp = await fetch(url, { headers });
    const forks = await resp.json();
    const userFork = forks.find(fork => fork.owner.login.toLowerCase() === username.toLowerCase());
    return { hasFork: !!userFork, forkUrl: userFork?.html_url };
  } catch (e) {
    console.error('GitHub API error:', e.message);
    return { hasFork: false, error: e.message };
  }
}

// ---------- Helper: Start a bot process ----------
function startBotProcess(appName, botPath, envVars) {
  // Write .env file
  const envContent = Object.entries(envVars).map(([k, v]) => `${k}=${v}`).join('\n');
  fs.writeFileSync(path.join(botPath, '.env'), envContent);

  // Run npm install (first time only – we assume it's already installed, but we can force)
  // For simplicity, we assume dependencies are installed. If not, you'd run `npm install` here.

  // Spawn the bot process
  const botProcess = spawn('node', ['index.js'], {
    cwd: botPath,
    env: { ...process.env, ...envVars },
    detached: false
  });

  botProcess.stdout.on('data', (data) => {
    console.log(`[${appName}] stdout: ${data}`);
  });

  botProcess.stderr.on('data', (data) => {
    console.error(`[${appName}] stderr: ${data}`);
  });

  botProcess.on('close', (code) => {
    console.log(`[${appName}] exited with code ${code}`);
    delete runningProcesses[appName];
  });

  runningProcesses[appName] = botProcess;
  return botProcess;
}

// ---------- Helper: Clone repo if not exists ----------
async function ensureBotCloned(appName, githubUsername) {
  const botPath = path.join(BOTS_DIR, appName);
  if (fs.existsSync(botPath)) return botPath;

  // Clone using the user's fork URL (assuming they forked the main repo)
  const forkUrl = `https://github.com/${githubUsername}/redxbot302.git`;
  return new Promise((resolve, reject) => {
    exec(`git clone ${forkUrl} "${botPath}"`, (err) => {
      if (err) {
        // If fork clone fails, fallback to main repo (read‑only)
        exec(`git clone ${REPO_URL} "${botPath}"`, (err2) => {
          if (err2) reject(err2);
          else resolve(botPath);
        });
      } else {
        resolve(botPath);
      }
    });
  });
}

// ---------- Helper: Stop a bot process ----------
function stopBotProcess(appName) {
  if (runningProcesses[appName]) {
    runningProcesses[appName].kill();
    delete runningProcesses[appName];
  }
}

// ---------- Routes ----------

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Get all plans (public)
app.get('/api/plans', async (req, res) => {
  const plans = await Plan.find({ isActive: true });
  res.json({ plans });
});

// Check fork and return user data
app.post('/check-fork', async (req, res) => {
  const { githubUsername } = req.body;
  if (!githubUsername) return res.status(400).json({ error: 'Username required' });

  const forkInfo = await checkFork(githubUsername);
  let user = await User.findOne({ githubUsername: githubUsername.toLowerCase() });
  if (!user) {
    user = new User({ githubUsername: githubUsername.toLowerCase(), maxBots: 1 });
    await user.save();
  }

  res.json({
    hasFork: forkInfo.hasFork,
    forkUrl: forkInfo.forkUrl,
    isApproved: user.isApproved,
    maxBots: user.maxBots,
    expiryDate: user.expiryDate,
    subscriptionPlan: user.subscriptionPlan,
    deployedBots: user.deployedBots || [],
    currentBots: user.deployedBots?.length || 0
  });
});

// Deploy bot
app.post('/deploy', async (req, res) => {
  const { githubUsername, sessionId, appName, ...config } = req.body;
  if (!githubUsername || !sessionId) return res.status(400).json({ error: 'Missing fields' });

  const user = await User.findOne({ githubUsername: githubUsername.toLowerCase() });
  if (!user || !user.isApproved) return res.status(403).json({ error: 'User not approved' });
  if (user.deployedBots.length >= user.maxBots) return res.status(403).json({ error: 'Bot limit reached' });

  // Generate a unique app name if not provided
  const finalAppName = appName || `${githubUsername}-${Date.now()}`;

  try {
    // Clone the bot code
    const botPath = await ensureBotCloned(finalAppName, githubUsername);

    // Prepare environment variables
    const envVars = {
      SESSION_ID: sessionId,
      GITHUB_USERNAME: githubUsername,
      PREFIX: config.PREFIX || '.',
      BOT_NAME: config.BOT_NAME || 'REDX BOT',
      OWNER_NAME: config.OWNER_NAME || 'Abdul Rehman',
      OWNER_NUMBER: config.OWNER_NUMBER || '923346690239',
      AUTO_STATUS_SEEN: config.AUTO_STATUS_SEEN || 'true',
      AUTO_STATUS_REACT: config.AUTO_STATUS_REACT || 'true',
      ANTI_DELETE: config.ANTI_DELETE || 'true',
      ANTI_LINK: config.ANTI_LINK || 'false',
      ALWAYS_ONLINE: config.ALWAYS_ONLINE || 'false',
      AUTO_REPLY: config.AUTO_REPLY || 'false',
      AUTO_STICKER: config.AUTO_STICKER || 'false',
      WELCOME: config.WELCOME || 'false',
      READ_MESSAGE: config.READ_MESSAGE || 'false',
      AUTO_TYPING: config.AUTO_TYPING || 'false'
    };

    // Start the bot process
    startBotProcess(finalAppName, botPath, envVars);

    // Save to database
    user.deployedBots.push({ appName: finalAppName, createdAt: new Date() });
    await user.save();

    res.json({ success: true, appName: finalAppName });
  } catch (error) {
    console.error('Deploy error:', error);
    res.status(500).json({ error: 'Deployment failed', details: error.message });
  }
});

// Restart bot
app.post('/restart-app', async (req, res) => {
  const { appName } = req.body;
  const user = await User.findOne({ 'deployedBots.appName': appName });
  if (!user) return res.status(404).json({ error: 'Bot not found' });

  stopBotProcess(appName);

  // Find the bot path and restart
  const botPath = path.join(BOTS_DIR, appName);
  if (!fs.existsSync(botPath)) return res.status(404).json({ error: 'Bot folder missing' });

  // Reload environment from .env file (or from DB – you could store config separately)
  // For simplicity, we just restart with existing .env
  const envFile = fs.readFileSync(path.join(botPath, '.env'), 'utf8');
  const envVars = {};
  envFile.split('\n').forEach(line => {
    const [key, val] = line.split('=');
    if (key && val) envVars[key] = val;
  });

  startBotProcess(appName, botPath, envVars);
  res.json({ success: true, message: 'Restarted' });
});

// Get bot config (returns .env content)
app.post('/get-config', async (req, res) => {
  const { appName } = req.body;
  const botPath = path.join(BOTS_DIR, appName);
  if (!fs.existsSync(botPath)) return res.status(404).json({ error: 'Bot not found' });

  const envFile = fs.readFileSync(path.join(botPath, '.env'), 'utf8');
  const config = {};
  envFile.split('\n').forEach(line => {
    const [key, val] = line.split('=');
    if (key && val) config[key] = val;
  });
  res.json({ success: true, config });
});

// Update bot config
app.post('/update-config', async (req, res) => {
  const { appName, config } = req.body;
  const botPath = path.join(BOTS_DIR, appName);
  if (!fs.existsSync(botPath)) return res.status(404).json({ error: 'Bot not found' });

  // Write new .env
  const envContent = Object.entries(config).map(([k, v]) => `${k}=${v}`).join('\n');
  fs.writeFileSync(path.join(botPath, '.env'), envContent);

  // Restart bot to apply changes
  stopBotProcess(appName);
  startBotProcess(appName, botPath, config);

  res.json({ success: true, message: 'Config updated and bot restarted' });
});

// Delete bot
app.post('/delete-app', async (req, res) => {
  const { appName, githubUsername } = req.body;
  const user = await User.findOne({ githubUsername: githubUsername?.toLowerCase() });
  if (!user) return res.status(404).json({ error: 'User not found' });

  const botIndex = user.deployedBots.findIndex(b => b.appName === appName);
  if (botIndex === -1) return res.status(404).json({ error: 'Bot not found' });

  // Stop process
  stopBotProcess(appName);

  // Remove folder
  const botPath = path.join(BOTS_DIR, appName);
  fs.rm(botPath, { recursive: true, force: true }, (err) => {
    if (err) console.error('Folder deletion error:', err);
  });

  // Remove from DB
  user.deployedBots.splice(botIndex, 1);
  await user.save();

  res.json({ success: true, message: 'Bot deleted' });
});

// Delete multiple bots (admin)
app.post('/delete-multiple-apps', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { apps } = req.body; // array of { name, serverId } – serverId unused here
  const results = { success: [], failed: [] };

  for (const { name } of apps) {
    try {
      stopBotProcess(name);
      const botPath = path.join(BOTS_DIR, name);
      if (fs.existsSync(botPath)) {
        fs.rmSync(botPath, { recursive: true, force: true });
      }
      // Remove from any user's deployedBots
      await User.updateMany(
        { 'deployedBots.appName': name },
        { $pull: { deployedBots: { appName: name } } }
      );
      results.success.push(name);
    } catch (e) {
      results.failed.push(name);
    }
  }
  res.json({ success: true, results });
});

// Admin login
app.post('/admin-login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) return res.json({ success: true });
  res.status(401).json({ error: 'Invalid password' });
});

// Admin: get all users
app.post('/admin/users', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const users = await User.find();
  res.json({ users });
});

// Admin: update user
app.post('/admin/update-user', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { githubUsername, isApproved, maxBots, expiryDate, subscriptionPlan } = req.body;
  await User.findOneAndUpdate(
    { githubUsername: githubUsername.toLowerCase() },
    { isApproved, maxBots, expiryDate, subscriptionPlan },
    { upsert: true }
  );
  res.json({ success: true });
});

// Admin: delete user
app.post('/admin/delete-user', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  await User.deleteOne({ githubUsername: req.body.githubUsername.toLowerCase() });
  res.json({ success: true });
});

// Admin: get plans
app.post('/admin/plans', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const plans = await Plan.find();
  res.json({ plans });
});

// Admin: create plan
app.post('/admin/create-plan', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const plan = new Plan(req.body);
  await plan.save();
  res.json({ success: true });
});

// Admin: update plan
app.post('/admin/update-plan', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { _id, ...data } = req.body;
  await Plan.findByIdAndUpdate(_id, data);
  res.json({ success: true });
});

// Admin: delete plan
app.post('/admin/delete-plan', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  await Plan.findByIdAndDelete(req.body._id);
  res.json({ success: true });
});

// Admin: get all bots (across users)
app.post('/get-all-apps', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const users = await User.find();
  const apps = [];
  users.forEach(u => {
    u.deployedBots.forEach(b => apps.push({ ...b.toObject(), githubUsername: u.githubUsername }));
  });
  res.json({ apps });
});

// Simple buy-plan endpoint (generates WhatsApp link)
app.post('/api/buy-plan', (req, res) => {
  const { planName, price, githubUsername } = req.body;
  const message = `I want to buy the ${planName} plan (${price}). My GitHub: ${githubUsername}`;
  const whatsappLink = `https://wa.me/923346690239?text=${encodeURIComponent(message)}`;
  res.json({ whatsappLink });
});

// ---------- Restore bots on startup ----------
async function restoreBots() {
  console.log('Restoring bots from database...');
  const users = await User.find();
  for (const user of users) {
    for (const bot of user.deployedBots) {
      const appName = bot.appName;
      const botPath = path.join(BOTS_DIR, appName);
      if (!fs.existsSync(botPath)) {
        console.log(`Bot ${appName} folder missing, skipping.`);
        continue;
      }
      // Read .env file
      const envFile = fs.readFileSync(path.join(botPath, '.env'), 'utf8');
      const envVars = {};
      envFile.split('\n').forEach(line => {
        const [key, val] = line.split('=');
        if (key && val) envVars[key] = val;
      });
      console.log(`Starting bot ${appName}...`);
      startBotProcess(appName, botPath, envVars);
    }
  }
  console.log('Restore complete.');
}

// ---------- Connect to MongoDB and start server ----------
const PORT = process.env.PORT || 3000;
mongoose.connect(process.env.MONGODB_URI).then(async () => {
  console.log('Connected to MongoDB');
  await restoreBots();
  app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
}).catch(err => console.error('MongoDB error:', err));
