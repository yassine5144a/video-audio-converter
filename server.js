'use strict';

const express    = require('express');
const cors       = require('cors');
const multer     = require('multer');
const ffmpeg     = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const { v4: uuidv4 } = require('uuid');
const path       = require('path');
const fs         = require('fs');
const https      = require('https');
const http       = require('http');
const youtubedl  = require('youtube-dl-exec');

// ─── FFmpeg binary path ────────────────────────────────────────────────────
ffmpeg.setFfmpegPath(ffmpegPath);

// ─── App setup ────────────────────────────────────────────────────────────
const app  = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Folders ──────────────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const OUTPUTS_DIR = path.join(__dirname, 'outputs');
[UPLOADS_DIR, OUTPUTS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ─── In-memory job store ───────────────────────────────────────────────────
// jobId → { sseClients: Set<res>, ffmpegCommand, inputFile, outputFile, status }
const jobs = new Map();

// ─── Multer config ────────────────────────────────────────────────────────
const ALLOWED_MIME = new Set([
  'video/mp4', 'video/x-matroska', 'video/x-msvideo',
  'video/quicktime', 'video/webm', 'video/x-flv',
  'video/mpeg', 'video/ogg', 'application/octet-stream'
]);
const ALLOWED_EXT = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.webm', '.flv', '.mpeg', '.mpg', '.ogv', '.m4v', '.3gp'
]);

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_MIME.has(file.mimetype) || ALLOWED_EXT.has(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.originalname}`));
    }
  }
});

// ─── Helper: send SSE event ───────────────────────────────────────────────
function sendSSE(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcastToJob(jobId, event, data) {
  const job = jobs.get(jobId);
  if (!job) return;
  for (const client of job.sseClients) {
    try { sendSSE(client, event, data); } catch (_) {}
  }
}

// ─── Route: POST /convert ─────────────────────────────────────────────────
app.post('/convert', upload.single('video'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No video file provided' });
  }

  const { format = 'mp3', bitrate = '192' } = req.body;

  const SUPPORTED_FORMATS = ['mp3', 'aac', 'wav', 'ogg', 'flac', 'm4a'];
  const SUPPORTED_BITRATES = ['64', '96', '128', '192', '256', '320'];

  if (!SUPPORTED_FORMATS.includes(format)) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: `Unsupported output format: ${format}` });
  }
  if (format !== 'wav' && format !== 'flac' && !SUPPORTED_BITRATES.includes(String(bitrate))) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: `Unsupported bitrate: ${bitrate}` });
  }

  const jobId      = uuidv4();
  const inputFile  = req.file.path;
  const outputName = `${jobId}.${format}`;
  const outputFile = path.join(OUTPUTS_DIR, outputName);
  const origName   = path.basename(req.file.originalname, path.extname(req.file.originalname));

  jobs.set(jobId, {
    sseClients: new Set(),
    ffmpegCommand: null,
    inputFile,
    outputFile,
    outputName,
    origName,
    format,
    bitrate,
    status: 'pending',
    createdAt: Date.now()
  });

  // Return jobId immediately so client can subscribe to SSE before conversion starts
  res.json({ jobId, outputName });

  // Start conversion in next tick so SSE client has time to subscribe
  setImmediate(() => startConversion(jobId));
});

// ─── Conversion logic ─────────────────────────────────────────────────────
function startConversion(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  job.status = 'converting';

  const cmd = ffmpeg(job.inputFile);
  job.ffmpegCommand = cmd;

  applyAudioCodec(cmd, job.format, job.bitrate);

  cmd
    .output(job.outputFile)
    .on('start', cmdLine => {
      console.log(`[${jobId}] FFmpeg started`);
      broadcastToJob(jobId, 'start', { jobId, message: 'Conversion started' });
    })
    .on('progress', prog => {
      const percent = Math.min(Math.round(prog.percent || 0), 99);
      broadcastToJob(jobId, 'progress', {
        percent,
        timemark: prog.timemark || '00:00:00',
        currentKbps: prog.currentKbps || 0
      });
    })
    .on('end', () => {
      job.status = 'done';
      console.log(`[${jobId}] Conversion done → ${job.outputFile}`);
      broadcastToJob(jobId, 'done', {
        percent: 100,
        jobId,
        downloadUrl: `/download/${jobId}`,
        filename: `${job.origName}.${job.format}`,
        format: job.format,
        bitrate: job.bitrate
      });
      // Cleanup input file
      fs.unlink(job.inputFile, () => {});
    })
    .on('error', (err, stdout, stderr) => {
      job.status = 'error';
      console.error(`[${jobId}] FFmpeg error:`, err.message);
      broadcastToJob(jobId, 'error', { message: err.message || 'Conversion failed' });
      fs.unlink(job.inputFile, () => {});
    })
    .run();
}

// ─── Route: GET /progress/:jobId (SSE) ───────────────────────────────────
app.get('/progress/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // If already done, send done immediately
  if (job.status === 'done') {
    sendSSE(res, 'done', {
      percent: 100,
      jobId,
      downloadUrl: `/download/${jobId}`,
      filename: `${job.origName}.${job.format}`,
      format: job.format,
      bitrate: job.bitrate
    });
    res.end();
    return;
  }

  if (job.status === 'error') {
    sendSSE(res, 'error', { message: 'Conversion failed' });
    res.end();
    return;
  }

  job.sseClients.add(res);

  const keepAlive = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) {}
  }, 15000);

  req.on('close', () => {
    clearInterval(keepAlive);
    job.sseClients.delete(res);
  });
});

// ─── Route: GET /download/:jobId ──────────────────────────────────────────
app.get('/download/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job || job.status !== 'done') {
    return res.status(404).json({ error: 'File not found or not ready' });
  }

  if (!fs.existsSync(job.outputFile)) {
    return res.status(410).json({ error: 'File has been cleaned up' });
  }

  const safeFilename = encodeURIComponent(`${job.origName}.${job.format}`);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${safeFilename}`);
  res.setHeader('Content-Type', getAudioMime(job.format));
  res.sendFile(job.outputFile);
});

// ─── Route: GET /info/:jobId ──────────────────────────────────────────────
app.get('/info/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.json({
    jobId,
    status: job.status,
    origName: job.origName,
    format: job.format,
    bitrate: job.bitrate,
    downloadUrl: job.status === 'done' ? `/download/${jobId}` : null
  });
});

// ─── Route: DELETE /cancel/:jobId ─────────────────────────────────────────
app.delete('/cancel/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  if (job.ffmpegCommand && job.status === 'converting') {
    try { job.ffmpegCommand.kill('SIGKILL'); } catch (_) {}
  }
  job.status = 'cancelled';
  fs.unlink(job.inputFile, () => {});
  fs.unlink(job.outputFile, () => {});
  broadcastToJob(jobId, 'cancelled', { message: 'Conversion cancelled' });
  res.json({ message: 'Cancelled' });
});

// ─── Helper: MIME types ───────────────────────────────────────────────────
function getAudioMime(format) {
  const map = {
    mp3: 'audio/mpeg',
    aac: 'audio/aac',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
    m4a: 'audio/mp4'
  };
  return map[format] || 'audio/mpeg';
}

// ─── Auto-cleanup: delete files older than 1 hour ─────────────────────────
function cleanupOldFiles() {
  const ONE_HOUR = 60 * 60 * 1000;
  const now = Date.now();

  // Clean jobs map
  for (const [jobId, job] of jobs.entries()) {
    if (now - job.createdAt > ONE_HOUR) {
      fs.unlink(job.inputFile, () => {});
      fs.unlink(job.outputFile, () => {});
      jobs.delete(jobId);
    }
  }

  // Clean orphan files in uploads/ and outputs/
  [UPLOADS_DIR, OUTPUTS_DIR].forEach(dir => {
    fs.readdir(dir, (err, files) => {
      if (err) return;
      files.forEach(file => {
        const filePath = path.join(dir, file);
        fs.stat(filePath, (err, stat) => {
          if (err) return;
          if (now - stat.mtimeMs > ONE_HOUR) {
            fs.unlink(filePath, () => {});
          }
        });
      });
    });
  });
}

setInterval(cleanupOldFiles, 30 * 60 * 1000); // every 30 min

// ─── Route: GET /url-info?url=... ────────────────────────────────────────
// Returns title + thumbnail for a URL (YouTube supported via yt-dlp)
app.get('/url-info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });

  try {
    const safeUrl = new URL(url); // validates URL structure
    if (!['http:', 'https:'].includes(safeUrl.protocol)) {
      return res.status(400).json({ error: 'Only http/https URLs are allowed' });
    }

    // Try yt-dlp for all URLs (supports YouTube + 1000+ sites)
    try {
      let info;
      try {
        // Try with cookies first
        info = await youtubedl(url, {
          dumpSingleJson: true,
          noCheckCertificates: true,
          noWarnings: true,
          preferFreeFormats: true,
          cookies: 'cookies-from-browser:chrome',
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          ffmpegLocation: path.dirname(ffmpegPath)
        });
      } catch (cookieErr) {
        // Fallback: try without cookies
        info = await youtubedl(url, {
          dumpSingleJson: true,
          noCheckCertificates: true,
          noWarnings: true,
          preferFreeFormats: true,
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          ffmpegLocation: path.dirname(ffmpegPath)
        });
      }

      const platform = info.extractor_key || info.extractor || 'generic';
      return res.json({
        title:     info.title || info.fulltitle || 'Video',
        author:    info.uploader || info.channel || '',
        duration:  info.duration ? formatDuration(parseInt(info.duration)) : '',
        thumbnail: info.thumbnail || '',
        platform:  platform.toLowerCase()
      });
    } catch (ytdlErr) {
      // Fallback: generic URL
      return res.json({
        title:    safeUrl.hostname,
        author:   '',
        duration: '',
        thumbnail: '',
        platform: 'generic'
      });
    }
  } catch (err) {
    return res.status(400).json({ error: 'Invalid URL: ' + err.message });
  }
});

// ─── Route: POST /convert-url ─────────────────────────────────────────────
app.post('/convert-url', express.json(), async (req, res) => {
  const { url, format = 'mp3', bitrate = '192' } = req.body || {};

  if (!url) return res.status(400).json({ error: 'Missing url' });

  // Validate URL
  let safeUrl;
  try {
    safeUrl = new URL(url);
    if (!['http:', 'https:'].includes(safeUrl.protocol)) {
      return res.status(400).json({ error: 'Only http/https URLs are allowed' });
    }
  } catch (_) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const SUPPORTED_FORMATS  = ['mp3', 'aac', 'wav', 'ogg', 'flac', 'm4a'];
  const SUPPORTED_BITRATES = ['64', '96', '128', '192', '256', '320'];

  if (!SUPPORTED_FORMATS.includes(format)) {
    return res.status(400).json({ error: `Unsupported format: ${format}` });
  }
  if (!['wav','flac'].includes(format) && !SUPPORTED_BITRATES.includes(String(bitrate))) {
    return res.status(400).json({ error: `Unsupported bitrate: ${bitrate}` });
  }

  const jobId      = uuidv4();
  const outputName = `${jobId}.${format}`;
  const outputFile = path.join(OUTPUTS_DIR, outputName);

  // Derive a clean title for the filename
  let origName = safeUrl.hostname.replace(/^www\./, '');

  jobs.set(jobId, {
    sseClients: new Set(),
    ffmpegCommand: null,
    inputFile: null,   // no local input for URL jobs
    outputFile,
    outputName,
    origName,
    format,
    bitrate,
    status: 'pending',
    createdAt: Date.now(),
    isUrlJob: true
  });

  res.json({ jobId, outputName });

  // Start in next tick
  setImmediate(async () => {
    const job = jobs.get(jobId);
    if (!job) return;
    job.status = 'converting';

    broadcastToJob(jobId, 'start', { message: 'Download started' });

    try {
      await convertUrlWithYtDlp(jobId, url);
    } catch (err) {
      const job = jobs.get(jobId);
      if (job) job.status = 'error';
      broadcastToJob(jobId, 'error', { message: err.message || 'Conversion failed' });
    }
  });
});

// ─── URL conversion via yt-dlp ────────────────────────────────────────────
async function convertUrlWithYtDlp(jobId, url) {
  const job = jobs.get(jobId);
  if (!job) return;

  // Download best audio with yt-dlp directly to temp file
  const tmpAudio = path.join(UPLOADS_DIR, `${jobId}.%(ext)s`);

  broadcastToJob(jobId, 'progress', { percent: 5, timemark: '00:00:00', currentKbps: 0 });

  try {
    // Get video title first (try with cookies, fallback to no-cookies)
    let info = null;
    try {
      info = await youtubedl(url, {
        dumpSingleJson: true,
        noCheckCertificates: true,
        noWarnings: true,
        cookies: 'cookies-from-browser:chrome',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ffmpegLocation: path.dirname(ffmpegPath)
      });
    } catch (cookieErr) {
      // Fallback: try without cookies
      info = await youtubedl(url, {
        dumpSingleJson: true,
        noCheckCertificates: true,
        noWarnings: true,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ffmpegLocation: path.dirname(ffmpegPath)
      }).catch(() => null);
    }

    if (info && info.title) {
      job.origName = sanitizeFilename(info.title);
    }

    // Download audio (try with cookies first, fallback to no-cookies)
    try {
      await youtubedl(url, {
        extractAudio: true,
        audioFormat: 'best',
        output: tmpAudio,
        noCheckCertificates: true,
        noWarnings: true,
        preferFreeFormats: true,
        cookies: 'cookies-from-browser:chrome',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ffmpegLocation: path.dirname(ffmpegPath)
      });
    } catch (downloadErr) {
      // Fallback: try without cookies
      await youtubedl(url, {
        extractAudio: true,
        audioFormat: 'best',
        output: tmpAudio,
        noCheckCertificates: true,
        noWarnings: true,
        preferFreeFormats: true,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ffmpegLocation: path.dirname(ffmpegPath)
      });
    }

    // Find the downloaded file (yt-dlp replaces %(ext)s with actual extension)
    const files = fs.readdirSync(UPLOADS_DIR).filter(f => f.startsWith(jobId));
    if (!files.length) throw new Error('Downloaded file not found');

    const downloadedFile = path.join(UPLOADS_DIR, files[0]);
    job.inputFile = downloadedFile;

    broadcastToJob(jobId, 'progress', { percent: 50, timemark: '00:00:00', currentKbps: 0 });

    // Convert with FFmpeg
    await new Promise((resolve, reject) => {
      const cmd = ffmpeg(downloadedFile);
      job.ffmpegCommand = cmd;

      applyAudioCodec(cmd, job.format, job.bitrate);

      cmd
        .output(job.outputFile)
        .on('progress', prog => {
          const pct = 50 + Math.min(Math.round((prog.percent || 0) * 0.49), 49);
          broadcastToJob(jobId, 'progress', {
            percent: Math.min(pct, 99),
            timemark: prog.timemark || '00:00:00',
            currentKbps: prog.currentKbps || 0
          });
        })
        .on('end', () => {
          job.status = 'done';
          broadcastToJob(jobId, 'done', {
            percent: 100,
            jobId,
            downloadUrl: `/download/${jobId}`,
            filename: `${job.origName}.${job.format}`,
            format: job.format,
            bitrate: job.bitrate
          });
          fs.unlink(downloadedFile, () => {});
          resolve();
        })
        .on('error', (err) => {
          job.status = 'error';
          broadcastToJob(jobId, 'error', { message: err.message });
          fs.unlink(downloadedFile, () => {});
          reject(err);
        })
        .run();
    });

  } catch (err) {
    throw new Error('Download/conversion failed: ' + err.message);
  }
}

// ─── Shared helpers ───────────────────────────────────────────────────────
function applyAudioCodec(cmd, format, bitrate) {
  cmd.noVideo();
  if (format === 'mp3')       cmd.audioCodec('libmp3lame').audioBitrate(bitrate);
  else if (format === 'aac')  cmd.audioCodec('aac').audioBitrate(bitrate);
  else if (format === 'wav')  cmd.audioCodec('pcm_s16le');
  else if (format === 'ogg')  cmd.audioCodec('libvorbis').audioBitrate(bitrate);
  else if (format === 'flac') cmd.audioCodec('flac');
  else if (format === 'm4a')  cmd.audioCodec('aac').audioBitrate(bitrate);
  return cmd;
}

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').substring(0, 120).trim() || 'audio';
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

// ─── Error handling middleware ────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large. Maximum size is 500MB.' });
  }
  console.error('Server error:', err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ─── Start server ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🎵 SoundRip server running at http://localhost:${PORT}\n`);
});
