const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;

// Simple HTTP request helper
function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Upload file to AssemblyAI
function uploadFile(filePath) {
  return new Promise((resolve, reject) => {
    const fileData = fs.readFileSync(filePath);
    const options = {
      hostname: 'api.assemblyai.com',
      path: '/v2/upload',
      method: 'POST',
      headers: {
        'authorization': ASSEMBLYAI_API_KEY,
        'content-type': 'application/octet-stream',
        'content-length': fileData.length,
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const parsed = JSON.parse(data);
        resolve(parsed.upload_url);
      });
    });
    req.on('error', reject);
    req.write(fileData);
    req.end();
  });
}

// Poll until transcript is ready
async function waitForTranscript(transcriptId) {
  while (true) {
    const res = await httpRequest({
      hostname: 'api.assemblyai.com',
      path: `/v2/transcript/${transcriptId}`,
      method: 'GET',
      headers: { 'authorization': ASSEMBLYAI_API_KEY }
    });
    const { status } = res.body;
    if (status === 'completed') return res.body;
    if (status === 'error') throw new Error('AssemblyAI transcription error: ' + res.body.error);
    await new Promise(r => setTimeout(r, 2000));
  }
}

async function processVideo(inputPath, settings, outputDir) {
  const { silenceThreshold, leadIn, leadOut } = settings;

  // STEP 1: Get duration
  const duration = getVideoDuration(inputPath);
  console.log(`Duration: ${duration}s`);

  // STEP 2: Extract audio
  const audioPath = inputPath + '.wav';
  execSync(`ffmpeg -i "${inputPath}" -vn -acodec pcm_s16le -ar 16000 -ac 1 "${audioPath}" -y`, { stdio: 'pipe' });

  // STEP 3: Upload to AssemblyAI
  console.log('Uploading audio...');
  const uploadUrl = await uploadFile(audioPath);
  if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);

  // STEP 4: Request transcription
  console.log('Requesting transcription...');
  const transcriptRes = await httpRequest({
    hostname: 'api.assemblyai.com',
    path: '/v2/transcript',
    method: 'POST',
    headers: {
      'authorization': ASSEMBLYAI_API_KEY,
      'content-type': 'application/json',
    }
  }, JSON.stringify({ audio_url: uploadUrl, word_boost: [] }));

  const transcriptId = transcriptRes.body.id;
  console.log('Transcript ID:', transcriptId);

  // STEP 5: Poll for result
  const transcript = await waitForTranscript(transcriptId);
  const words = transcript.words || [];
  console.log(`Got ${words.length} words`);

  if (words.length === 0) {
    const outputPath = path.join(outputDir, 'edited-' + path.basename(inputPath));
    fs.copyFileSync(inputPath, outputPath);
    return outputPath;
  }

  // STEP 6: Build segments
  const rawSegments = words.map(w => ({
    start: Math.max(0, w.start / 1000 - leadIn),
    end: Math.min(duration, w.end / 1000 + leadOut),
  }));

  const merged = [];
  for (const seg of rawSegments) {
    if (merged.length === 0) {
      merged.push({ ...seg });
    } else {
      const last = merged[merged.length - 1];
      if (seg.start - last.end <= silenceThreshold) {
        last.end = Math.max(last.end, seg.end);
      } else {
        merged.push({ ...seg });
      }
    }
  }

  console.log(`Keeping ${merged.length} segments`);

  // STEP 7: Cut with FFmpeg
  const outputPath = path.join(outputDir, 'edited-' + path.basename(inputPath));

  const filterParts = [];
  const concatInputs = [];
  merged.forEach((seg, i) => {
    filterParts.push(
      `[0:v]trim=start=${seg.start}:end=${seg.end},setpts=PTS-STARTPTS[v${i}]`,
      `[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS[a${i}]`
    );
    concatInputs.push(`[v${i}][a${i}]`);
  });
  filterParts.push(`${concatInputs.join('')}concat=n=${merged.length}:v=1:a=1[vout][aout]`);

  const ffmpegCmd = `ffmpeg -i "${inputPath}" -filter_complex "${filterParts.join(';')}" -map "[vout]" -map "[aout]" -c:v libx264 -c:a aac -y "${outputPath}"`;
  console.log('Running FFmpeg...');
  execSync(ffmpegCmd, { stdio: 'pipe' });

  return outputPath;
}

function getVideoDuration(filePath) {
  const result = execSync(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
    { stdio: 'pipe' }
  ).toString().trim();
  return parseFloat(result);
}

module.exports = { processVideo };
