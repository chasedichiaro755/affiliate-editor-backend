const { AssemblyAI } = require('assemblyai');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const client = new AssemblyAI({
  apiKey: process.env.ASSEMBLYAI_API_KEY,
});

/**
 * Main function: takes a video file path, detects silence, cuts it, returns output path.
 */
async function processVideo(inputPath, settings, outputDir) {
  const { silenceThreshold, leadIn, leadOut } = settings;

  // ── STEP 1: Get video duration ───────────────────────────────────────────────
  const duration = getVideoDuration(inputPath);
  console.log(`   📏 Duration: ${duration}s`);

  // ── STEP 2: Extract audio for AssemblyAI ────────────────────────────────────
  const audioPath = inputPath + '.wav';
  execSync(`ffmpeg -i "${inputPath}" -vn -acodec pcm_s16le -ar 16000 -ac 1 "${audioPath}" -y`, {
    stdio: 'pipe',
  });

  // ── STEP 3: Upload audio to AssemblyAI & transcribe with timestamps ──────────
  console.log(`   📤 Uploading to AssemblyAI...`);

  // Upload the file first, then transcribe
  const uploadUrl = await client.files.upload(audioPath);

  const transcript = await client.transcripts.transcribe({
    audio: uploadUrl,
    speech_model: 'best',
    format_text: false,
  });

  // Clean up temp audio file
  if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);

  if (transcript.status === 'error') {
    throw new Error(`AssemblyAI error: ${transcript.error}`);
  }

  // ── STEP 4: Find SPEECH segments (what to KEEP) ──────────────────────────────
  const words = transcript.words || [];

  if (words.length === 0) {
    console.log(`   ⚠️  No speech detected. Returning original.`);
    const outputPath = path.join(outputDir, 'edited-' + path.basename(inputPath));
    fs.copyFileSync(inputPath, outputPath);
    return outputPath;
  }

  // ── STEP 5: Build keep-segments with lead-in / lead-out ─────────────────────
  const rawSegments = words.map(w => ({
    start: Math.max(0, w.start / 1000 - leadIn),
    end:   Math.min(duration, w.end / 1000 + leadOut),
  }));

  // Merge segments where gap < silenceThreshold
  const merged = [];
  for (const seg of rawSegments) {
    if (merged.length === 0) {
      merged.push({ ...seg });
    } else {
      const last = merged[merged.length - 1];
      const gap = seg.start - last.end;
      if (gap <= silenceThreshold) {
        last.end = Math.max(last.end, seg.end);
      } else {
        merged.push({ ...seg });
      }
    }
  }

  console.log(`   ✂️  Found ${merged.length} speech segments to keep`);

  // ── STEP 6: Build FFmpeg filter ──────────────────────────────────────────────
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

  const concatFilter = `${concatInputs.join('')}concat=n=${merged.length}:v=1:a=1[vout][aout]`;
  filterParts.push(concatFilter);

  const filterComplex = filterParts.join(';');

  const ffmpegCmd = [
    `ffmpeg`,
    `-i "${inputPath}"`,
    `-filter_complex "${filterComplex}"`,
    `-map "[vout]"`,
    `-map "[aout]"`,
    `-c:v libx264`,
    `-c:a aac`,
    `-y`,
    `"${outputPath}"`,
  ].join(' ');

  console.log(`   🎬 Running FFmpeg...`);
  execSync(ffmpegCmd, { stdio: 'pipe' });

  return outputPath;
}

/**
 * Get video duration in seconds using FFprobe
 */
function getVideoDuration(filePath) {
  const result = execSync(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
    { stdio: 'pipe' }
  ).toString().trim();
  return parseFloat(result);
}

module.exports = { processVideo };
