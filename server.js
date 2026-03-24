const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { processVideo } = require('./processor');

const app = express();
const PORT = process.env.PORT || 3001;

// ─── CORS (allows your Netlify site to talk to this server) ───────────────────
app.use(cors({
  origin: '*', // You can restrict this to 'https://affiliateeditor.com' later
  methods: ['GET', 'POST'],
}));

app.use(express.json());

// ─── UPLOAD FOLDER SETUP ─────────────────────────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'outputs');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ─── MULTER (handles incoming video files) ────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB per file
  fileFilter: (req, file, cb) => {
    const allowed = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed'));
    }
  },
});

// ─── AUTO-DELETE FILES AFTER 24 HOURS ────────────────────────────────────────
function scheduleDelete(filePath, label) {
  setTimeout(() => {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`🗑️  Auto-deleted ${label}: ${filePath}`);
    }
  }, 24 * 60 * 60 * 1000); // 24 hours
}

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'Affiliate Editor backend is running ✅' });
});

// ─── MAIN PROCESSING ENDPOINT ─────────────────────────────────────────────────
// Accepts up to 20 videos at once
app.post('/process', upload.array('videos', 20), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No video files uploaded.' });
  }

  // Settings from the frontend
  const settings = {
    silenceThreshold: parseFloat(req.body.silenceThreshold) || 0.3, // seconds of silence to cut
    leadIn:           parseFloat(req.body.leadIn)           || 0.05, // seconds to keep before speech
    leadOut:          parseFloat(req.body.leadOut)          || 0.1,  // seconds to keep after speech
  };

  console.log(`📥 Received ${req.files.length} video(s) with settings:`, settings);

  const results = [];
  const errors  = [];

  // Process all videos (in parallel)
  await Promise.all(req.files.map(async (file) => {
    try {
      console.log(`⚙️  Processing: ${file.originalname}`);
      const outputPath = await processVideo(file.path, settings, OUTPUT_DIR);
      const outputFilename = path.basename(outputPath);

      // Schedule auto-delete for input and output
      scheduleDelete(file.path, 'input');
      scheduleDelete(outputPath, 'output');

      results.push({
        originalName: file.originalname,
        downloadUrl: `/download/${outputFilename}`,
      });

      console.log(`✅ Done: ${file.originalname} → ${outputFilename}`);
    } catch (err) {
      console.error(`❌ Error processing ${file.originalname}:`, err.message);
      errors.push({ originalName: file.originalname, error: err.message });
      // Clean up input file on error
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
    }
  }));

  res.json({ results, errors });
});

// ─── DOWNLOAD ENDPOINT ────────────────────────────────────────────────────────
app.get('/download/:filename', (req, res) => {
  const filePath = path.join(OUTPUT_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found or already deleted.' });
  }
  res.download(filePath);
});

// ─── START SERVER ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Affiliate Editor backend running on port ${PORT}`);
});
