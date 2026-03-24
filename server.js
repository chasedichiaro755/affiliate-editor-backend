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
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// In-memory job store
const jobs = {};

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

// Submit job — returns immediately with a job ID
app.post('/process', upload.array('videos', 20), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No video files uploaded.' });
  }

  const settings = {
    silenceThreshold: parseFloat(req.body.silenceThreshold) || 0.3,
    leadIn: parseFloat(req.body.leadIn) || 0.05,
    leadOut: parseFloat(req.body.leadOut) || 0.1,
  };

  const jobId = Date.now() + '-' + Math.round(Math.random() * 1e9);
  jobs[jobId] = { status: 'processing', results: [], errors: [] };

  console.log(`📥 Job ${jobId}: ${req.files.length} video(s)`);

  // Process in background — don't await
  (async () => {
    await Promise.all(req.files.map(async (file) => {
      try {
        console.log(`⚙️  Processing: ${file.originalname}`);
        const outputPath = await processVideo(file.path, settings, OUTPUT_DIR);
        const outputFilename = path.basename(outputPath);
        scheduleDelete(file.path);
        scheduleDelete(outputPath);
        jobs[jobId].results.push({
          originalName: file.originalname,
          downloadUrl: `/download/${outputFilename}`,
        });
        console.log(`✅ Done: ${file.originalname}`);
      } catch (err) {
        console.error(`❌ Error: ${file.originalname}:`, err.message);
        jobs[jobId].errors.push({ originalName: file.originalname, error: err.message });
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      }
    }));
    jobs[jobId].status = 'done';
    console.log(`🏁 Job ${jobId} complete`);
    // Clean up job after 1 hour
    setTimeout(() => delete jobs[jobId], 60 * 60 * 1000);
  })();

  // Return job ID immediately
  res.json({ jobId });
});

// Poll for job status
app.get('/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// Download endpoint
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
