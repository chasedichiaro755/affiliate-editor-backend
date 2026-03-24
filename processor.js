const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;

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
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.upload_url);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(fileData);
    req.end();
  });
}

// Request transcription
function requestTranscription(audioUrl) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ audio_url: audioUrl, speech_models: ['universal-2'] });
    const options = {
      hostname: 'api.assemblyai.com',
      path: '/v2/transcript',
      method: 'POST',
      headers: {
        'authorization': ASSEMBLYAI_API_KEY,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.id);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Poll until done
function pollTranscript(transcriptId) {
  return new Promise((resolve, reject) => {
    const check = () => {
      const options = {
        hostname: 'api.assemblyai.com',
        path: `/v2/transcript/${transcriptId}`,
        method: 'GET',
        headers: { 'authorization': ASSEMBLYAI_API_KEY }
      };
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.status === 'completed') resolve(parsed);
            else if (parsed.status === 'error') reject(new Error('AssemblyAI error: ' + parsed.error));
            else setTimeout(check, 3000);
          } catch(e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.end();
    };
    check();
  });
}

/**
 * Detect and remove retakes.
 * A retake is when the same phrase (3+ words) appears again within 30 seconds.
 * We keep the LAST occurrence and remove all earlier ones.
 */
function removeRetakes(words, duration) {
  if (!words || words.length === 0) return null;

  // Build sentences from words (group by ~1 second gaps)
  const sentences = [];
  let current = [];
  for (let i = 0; i < words.length; i++) {
    current.push(words[i]);
    const nextWord = words[i + 1];
    const gap = nextWord ? (nextWord.start - words[i].end) / 1000 : 999;
    if (gap > 0.8 || i === words.length - 1) {
      if (current.length >= 2) {
        sentences.push({
          text: current.map(w => w.text.toLowerCase().replace(/[^a-z0-9 ]/g, '')).join(' '),
          start: current[0].start / 1000,
          end: current[current.length - 1].end / 1000,
          words: [...current],
        });
      }
      current = [];
    }
  }

  // Find retakes — sentences with matching first 3+ words within 30 seconds
  const retakeRanges = []; // ranges to CUT (the failed takes)

  for (let i = 0; i < sentences.length; i++) {
    const wordsA = sentences[i].text.split(' ').filter(Boolean);
    for (let j = i + 1; j < sentences.length; j++) {
      const wordsB = sentences[j].text.split(' ').filter(Boolean);
      // Check if they share the first 3+ words
      let matchCount = 0;
      for (let k = 0; k < Math.min(wordsA.length, wordsB.length, 6); k++) {
        if (wordsA[k] === wordsB[k]) matchCount++;
        else break;
      }
      const timeDiff = sentences[j].start - sentences[i].end;
      if (matchCount >= 3 && timeDiff < 30) {
        // sentences[i] is the failed take — mark it for removal
        console.log(`🔁 Retake found: "${sentences[i].text.substring(0, 40)}" → removed`);
        retakeRanges.push({ start: sentences[i].start, end: sentences[i].end });
        break;
      }
    }
  }

  if (retakeRanges.length === 0) {
    console.log('No retakes detected');
    return null; // no retakes found
  }

  console.log(`Found ${retakeRanges.length} retake(s) to remove`);
  return retakeRanges;
}

async function processVideo(inputPath, settings, outputDir) {
  const { silenceThreshold, leadIn, leadOut, removeRetakesEnabled } = settings;

  // STEP 1: Get duration
  const duration = getVideoDuration(inputPath);
  console.log(`Duration: ${duration}s`);

  // STEP 2: Extract audio
  const audioPath = inputPath + '.wav';
  execSync(`ffmpeg -i "${inputPath}" -vn -acodec pcm_s16le -ar 16000 -ac 1 "${audioPath}" -y`, { stdio: 'pipe' });
  console.log('Audio extracted');

  // STEP 3: Upload
  console.log('Uploading audio...');
  const uploadUrl = await uploadFile(audioPath);
  if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);

  // STEP 4: Transcribe
  console.log('Requesting transcription...');
  const transcriptId = await requestTranscription(uploadUrl);
  console.log('Transcript ID:', transcriptId);
  if (!transcriptId) throw new Error('Failed to get transcript ID from AssemblyAI');

  console.log('Waiting for transcript...');
  const transcript = await pollTranscript(transcriptId);
  const words = transcript.words || [];
  console.log(`Got ${words.length} words`);

  if (words.length === 0) {
    const outputPath = path.join(outputDir, 'edited-' + path.basename(inputPath));
    fs.copyFileSync(inputPath, outputPath);
    return outputPath;
  }

  // STEP 5: Detect retakes and return as suggestions (user decides)
  let retakeRangesToRemove = [];
  let retakeSuggestions = [];
  if (settings.flagRetakes) {
    console.log('Checking for retakes...');
    const retakes = removeRetakes(words, duration);
    if (retakes) {
      retakeSuggestions = retakes.map((r, i) => ({
        index: i,
        start: r.start.toFixed(2),
        end: r.end.toFixed(2),
        label: `Clip ${i+1}: ${r.start.toFixed(1)}s – ${r.end.toFixed(1)}s`,
      }));
      // Don't remove anything — just flag them
    }
  }

  // STEP 6: Build speech segments with safety checks
  const MIN_SEGMENT = 0.2; // never shorter than 0.2s
  const rawSegments = words.map(w => {
    const wordStart = w.start / 1000;
    const wordEnd = w.end / 1000;
    const wordDuration = wordEnd - wordStart;

    // Safety: lead-in/out can never eat more than 30% of any word
    const safeLeadIn = leadIn < 0 ? Math.max(leadIn, -(wordDuration * 0.3)) : leadIn;
    const safeLeadOut = leadOut < 0 ? Math.max(leadOut, -(wordDuration * 0.3)) : leadOut;

    const start = Math.max(0, wordStart - safeLeadIn);
    const end = Math.min(duration, wordEnd + safeLeadOut);

    // Safety: segment must be at least MIN_SEGMENT long
    if (end - start < MIN_SEGMENT) {
      // Expand outward to meet minimum
      const mid = (start + end) / 2;
      return {
        start: Math.max(0, mid - MIN_SEGMENT / 2),
        end: Math.min(duration, mid + MIN_SEGMENT / 2),
      };
    }

    return { start, end };
  });

  // Merge segments where gap < silenceThreshold
  let merged = [];
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

  // Retakes are flagged as suggestions only — user removes them manually

  console.log(`Keeping ${merged.length} segments`);

  // STEP 8: Cut with FFmpeg
  const outputPath = path.join(outputDir, 'edited-' + path.basename(inputPath));

  if (merged.length === 0) {
    fs.copyFileSync(inputPath, outputPath);
    return outputPath;
  }

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

  const ffmpegCmd = `ffmpeg -i "${inputPath}" -filter_complex "${filterParts.join(';')}" -map "[vout]" -map "[aout]" -c:v libx264 -preset ultrafast -crf 28 -c:a aac -threads 1 -y "${outputPath}"`;
  console.log('Running FFmpeg...');
  execSync(ffmpegCmd, { stdio: 'pipe' });
  console.log('FFmpeg done!');

  // Attach suggestions to output path object
  const result = { outputPath, retakeSuggestions };
  return result;
}

function getVideoDuration(filePath) {
  const result = execSync(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
    { stdio: 'pipe' }
  ).toString().trim();
  return parseFloat(result);
}

module.exports = { processVideo };
