const { AssemblyAI } = require('assemblyai');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const client = new AssemblyAI({
  apiKey: process.env.ASSEMBLYAI_API_KEY,
});

async function processVideo(inputPath, settings, outputDir) {
  const { silenceThreshold, leadIn, leadOut } = settings;

  // STEP 1: Get video duration
  const duration = getVideoDuration(inputPath);
  console.log(`Duration: ${duration}s`);

  // STEP 2: Extract audio
  const audioPath = inputPath + '.wav';
  execSync(`ffmpeg -i "${inputPath}" -vn -acodec pcm_s16le -ar 16000 -ac 1 "${audioPath}" -y`, { stdio: 'pipe' });

  // STEP 3: Transcribe with AssemblyAI
  console.log(`Uploading to AssemblyAI...`);
  const uploadUrl = await client.files.upload(audioPath);
  const transcript = await client.transcripts.transcribe({ audio: uploadUrl });

  if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);

  if (transcript.status === 'error') {
    throw new Error(`AssemblyAI error: ${transcript.error}`);
  }

  // STEP 4: Get word timestamps
  const words = transcript.words || [];
  console.log(`Got ${words.length} words`);

  if (words.length === 0) {
    const outputPath = path.join(outputDir, 'edited-' + path.basename(inputPath));
    fs.copyFileSync(inputPath, outputPath);
    return outputPath;
  }

  // STEP 5: Build speech segments with lead-in/lead-out
  const rawSegments = words.map(w => ({
    start: Math.max(0, w.start / 1000 - leadIn),
    end: Math.min(duration, w.end / 1000 + leadOut),
  }));

  // Merge segments where gap < silenceThreshold
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

  console.log(`Found ${merged.length} segments to keep`);

  // STEP 6: Cut with FFmpeg
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

  const ffmpegCmd = `ffmpeg -i "${inputPath}" -filter_complex "${filterParts.join(';')}" -map "[vout]" -map "[aout]" -c:v libx264 -c:a aac -y "${outputPath}"`;

  console.log(`Running FFmpeg...`);
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
