const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { processVideo } = require('./processor');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*', methods: ['GET', 'POST'] }));

// ── STRIPE WEBHOOK ────────────────────────────────────────────────────────────
// Must be registered before express.json() so we receive the raw body for sig verification
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const SUPA_URL = 'https://wukwvcxeejsqaqhvknfo.supabase.co';

async function setUserPaidStatus(email, paid) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  // Find user by email
  const listRes = await fetch(`${SUPA_URL}/auth/v1/admin/users?per_page=1000`, {
    headers: { 'apikey': key, 'Authorization': 'Bearer ' + key }
  });
  if (!listRes.ok) throw new Error('Failed to list Supabase users');
  const { users } = await listRes.json();
  const user = users.find(u => u.email === email);
  if (!user) throw new Error(`No Supabase user found for email: ${email}`);

  // Merge paid flag into existing metadata
  const updatedMeta = { ...(user.user_metadata || {}), paid };
  const updateRes = await fetch(`${SUPA_URL}/auth/v1/admin/users/${user.id}`, {
    method: 'PUT',
    headers: { 'apikey': key, 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_metadata: updatedMeta })
  });
  if (!updateRes.ok) {
    const err = await updateRes.json();
    throw new Error('Failed to update user metadata: ' + JSON.stringify(err));
  }
  console.log(`✅ Supabase user ${email} paid=${paid}`);
}

app.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('⚠️  Stripe webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const email = event.data.object.customer_details?.email || event.data.object.customer_email;
      if (email) await setUserPaidStatus(email, true);
    } else if (event.type === 'customer.subscription.created') {
      const customerId = event.data.object.customer;
      const customer = await stripe.customers.retrieve(customerId);
      if (customer.email) await setUserPaidStatus(customer.email, true);
    } else if (event.type === 'customer.subscription.deleted') {
      const customerId = event.data.object.customer;
      const customer = await stripe.customers.retrieve(customerId);
      if (customer.email) await setUserPaidStatus(customer.email, false);
    }
  } catch (err) {
    console.error('⚠️  Webhook handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }

  res.json({ received: true });
});

app.use(express.json());

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'outputs');
[UPLOAD_DIR, OUTPUT_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v'];
    const ext = path.extname(file.originalname).toLowerCase();
    allowed.includes(ext) ? cb(null, true) : cb(new Error('Only video files allowed'));
  },
});

function scheduleDelete(filePath) {
  setTimeout(() => {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }, 24 * 60 * 60 * 1000);
}

app.get('/', (req, res) => {
  res.json({ status: 'Affiliate Editor backend is running ✅' });
});

// Process videos and wait for result before responding
app.post('/process', upload.array('videos', 20), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No video files uploaded.' });
  }

  const settings = {
    silenceThreshold: parseFloat(req.body.silenceThreshold) || 0.3,
    leadIn: parseFloat(req.body.leadIn) || 0.05,
    leadOut: parseFloat(req.body.leadOut) || 0.1,
    flagRetakes: req.body.flagRetakes === 'true',
  };

  console.log(`📥 ${req.files.length} video(s) received`);

  const results = [];
  const errors = [];

  await Promise.all(req.files.map(async (file) => {
    try {
      console.log(`⚙️  Processing: ${file.originalname}`);
      const processed = await processVideo(file.path, settings, OUTPUT_DIR);
      const outputPath = processed.outputPath || processed;
      const outputFilename = path.basename(outputPath);
      scheduleDelete(file.path);
      scheduleDelete(outputPath);
      results.push({
        originalName: file.originalname,
        downloadUrl: `/download/${outputFilename}`,
        retakeSuggestions: processed.retakeSuggestions || [],
        segments: processed.segments || [],
      });
      console.log(`✅ Done: ${file.originalname}`);
    } catch (err) {
      console.error(`❌ Error: ${file.originalname}:`, err.message);
      errors.push({ originalName: file.originalname, error: err.message });
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
    }
  }));

  res.json({ results, errors });
});

app.get('/download/:filename', (req, res) => {
  const filePath = path.join(OUTPUT_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found or already deleted.' });
  }
  res.download(filePath);
});

// Re-export with updated segment times (no AssemblyAI needed)
app.post('/reexport', express.json({ limit: '1mb' }), async (req, res) => {
  const { segments, sourceFilename } = req.body;
  if (!segments || !sourceFilename) {
    return res.status(400).json({ error: 'Missing segments or sourceFilename' });
  }

  const sourcePath = path.join(OUTPUT_DIR, sourceFilename);
  if (!fs.existsSync(sourcePath)) {
    return res.status(404).json({ error: 'Source file not found — please re-upload your video' });
  }

  console.log(`🔁 Re-exporting with ${segments.length} segments`);

  try {
    const { execSync } = require('child_process');
    
    // Get video duration
    const duration = parseFloat(execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${sourcePath}"`,
      { stdio: 'pipe' }
    ).toString().trim());

    // Filter out removed segments, apply trims
    const activeSegments = segments.filter(s => !s.removed).map(s => ({
      start: Math.max(0, s.start + (s.trimStart || 0)),
      end: Math.min(duration, s.end - (s.trimEnd || 0)),
    })).filter(s => s.end - s.start > 0.05);

    if (activeSegments.length === 0) {
      return res.status(400).json({ error: 'No segments remaining after edits' });
    }

    const outputFilename = 'reexport-' + Date.now() + path.extname(sourceFilename);
    const outputPath = path.join(OUTPUT_DIR, outputFilename);

    const filterParts = [];
    const concatInputs = [];
    activeSegments.forEach((seg, i) => {
      filterParts.push(
        `[0:v]trim=start=${seg.start}:end=${seg.end},setpts=PTS-STARTPTS[v${i}]`,
        `[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS[a${i}]`
      );
      concatInputs.push(`[v${i}][a${i}]`);
    });
    filterParts.push(`${concatInputs.join('')}concat=n=${activeSegments.length}:v=1:a=1[vout][aout]`);

    const ffmpegCmd = `ffmpeg -i "${sourcePath}" -filter_complex "${filterParts.join(';')}" -map "[vout]" -map "[aout]" -c:v libx264 -preset ultrafast -crf 28 -c:a aac -threads 1 -y "${outputPath}"`;
    execSync(ffmpegCmd, { stdio: 'pipe' });

    // Auto-delete after 24h
    setTimeout(() => { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); }, 24 * 60 * 60 * 1000);

    console.log(`✅ Re-export done: ${outputFilename}`);
    res.json({ downloadUrl: '/download/' + outputFilename });

  } catch(err) {
    console.error('Re-export error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Affiliate Editor backend running on port ${PORT}`);
});

// Hook generation endpoint
app.post('/generate-hook', express.json(), async (req, res) => {
  const { product } = req.body;
  if (!product) return res.status(400).json({ error: 'No product provided' });

  const https = require('https');
  const body = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 300,
    messages: [{ role: 'user', content: 'TikTok hook expert. Product: ' + product + '. Reply with ONLY this JSON (no markdown): {"score":8,"hook":"hook sentence here","overlay":"5 words emoji","feedback":"one sentence"}' }]
  });

  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-length': Buffer.byteLength(body),
    }
  };

  const apiReq = https.request(options, (apiRes) => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        const text = parsed.content[0].text.trim().replace(/```json|```/g, '').trim();
        const result = JSON.parse(text);
        res.json(result);
      } catch(e) {
        res.status(500).json({ error: 'Failed to parse AI response' });
      }
    });
  });
  apiReq.on('error', (e) => res.status(500).json({ error: e.message }));
  apiReq.write(body);
  apiReq.end();
});
