const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { processVideo } = require('./processor');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*', methods: ['GET', 'POST'] }));
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
