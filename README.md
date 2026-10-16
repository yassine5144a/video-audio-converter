# 🎵 SoundRip — Video to Audio Converter

A professional, full-stack web application for converting video files to audio.
Built with Node.js, Express, and FFmpeg. Features a dark/neon UI with real-time progress.

---

## ✨ Features

- 🎬 **Input formats**: MP4, MKV, AVI, MOV, WEBM, FLV, MPEG, M4V, 3GP
- 🔗 **URL support**: YouTube, TikTok, Twitter, SoundCloud, 1000+ sites via **yt-dlp**
- 🎵 **Output formats**: MP3, AAC, WAV, OGG, FLAC, M4A
- 📊 **Quality options**: 128 / 192 / 256 / 320 kbps
- 📡 **Real-time progress** via Server-Sent Events (SSE)
- 🖱️ **Drag & Drop** + multiple file support
- 🎧 **Audio preview** before downloading
- 🕓 **Conversion history** (localStorage)
- 🌙 **Dark/Light mode** toggle
- 🔒 **Auto-cleanup**: files deleted after 1 hour
- 📱 **Fully responsive** for mobile

---

## 🚀 Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Start the server

```bash
npm start
```

### 3. Open in browser

```
http://localhost:3000
```

---

## 📁 Project Structure

```
convert/
├── package.json        # Dependencies
├── server.js           # Express + FFmpeg backend
├── README.md
├── uploads/            # Temporary uploaded files (auto-cleaned)
├── outputs/            # Converted audio files (auto-cleaned)
└── public/
    └── index.html      # Full frontend (HTML + CSS + JS)
```

---

## ⚙️ API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| `POST` | `/convert` | Upload video + options, returns `{ jobId }` |
| `POST` | `/convert-url` | Convert YouTube/URL to audio, returns `{ jobId }` |
| `GET`  | `/url-info?url=...` | Get video title, thumbnail, duration via yt-dlp |
| `GET`  | `/progress/:jobId` | SSE stream: progress → done/error |
| `GET`  | `/download/:jobId` | Download converted audio file |
| `GET`  | `/info/:jobId` | Get job status info |
| `DELETE` | `/cancel/:jobId` | Cancel active conversion |

---

## 🔧 Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| Max file size | `500MB` | Configurable in `server.js` |
| Auto-cleanup interval | `30 min` | Deletes files older than 1 hour |

---

## 📦 Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js + Express |
| Media Processing | FFmpeg (via `ffmpeg-static` + `fluent-ffmpeg`) |
| URL Download | **yt-dlp** (via `youtube-dl-exec`) — supports 1000+ sites |
| File Upload | Multer |
| Real-time | Server-Sent Events |
| Frontend | Vanilla HTML5 + CSS3 + JavaScript |

---

## 🔒 Privacy

All uploaded files are stored temporarily and **automatically deleted after 1 hour**.
No files are stored permanently or shared with any third party.

---

## 🌐 Deployment

See [DEPLOYMENT.md](./DEPLOYMENT.md) for detailed instructions on deploying to:
- **Render.com** (recommended for free hosting)
- Railway.app
- AWS / DigitalOcean
- Self-hosted VPS

### Quick Deploy to Render

1. Push this repo to GitHub
2. Create a new Web Service on [Render](https://render.com)
3. Select **Docker** runtime
4. Deploy! ✅

The included `Dockerfile` and `render.yaml` handle everything automatically.
