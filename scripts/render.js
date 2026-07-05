/**
 * render.js — v2 (Türkçe altyazı videoya gömülü)
 * -----------------------------------------------------------------------
 * Storyboard JSON'ı okur, her sahne için:
 *   1) edge-tts ile İngilizce seslendirme üretir
 *   2) Puppeteer ile karakter SVG rig'ini konuşma/kırpma animasyonuyla
 *      PNG frame'lere render eder
 *   3) ffmpeg ile frame + ses birleştirir
 *   4) Türkçe altyazıyı .srt olarak üretir VE videoya gömer (hardsub)
 *
 * Kullanım: node render.js <storyboard.json yolu>
 * -----------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const puppeteer = require("puppeteer");

const FPS = 24;
const OUT_DIR = path.join(__dirname, "output");
const FRAMES_DIR = path.join(OUT_DIR, "frames");
const CHAR_DIR = path.join(__dirname, "..", "assets", "character");

function ensureDirs() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(FRAMES_DIR, { recursive: true });
}

function sh(cmd) {
  execSync(cmd, { stdio: "inherit" });
}

function synthesize(text, outMp3, voice = "en-US-GuyNeural") {
  sh(
    `edge-tts --voice "${voice}" --text "${text.replace(/"/g, '\\"')}" ` +
      `--write-media "${outMp3}"`
  );
  const durationOut = execSync(
    `ffprobe -v error -show_entries format=duration -of csv=p=0 "${outMp3}"`
  )
    .toString()
    .trim();
  return parseFloat(durationOut);
}

function buildRigHtml(pose) {
  const svgContent = fs.readFileSync(
    path.join(CHAR_DIR, "character.svg"),
    "utf8"
  );
  return `
  <html>
    <head>
      <style>
        body { margin: 0; background: transparent; }
        .frame { width: 1080px; height: 1920px; display:flex; align-items:center; justify-content:center; }
        .frame svg { width: 900px; height: auto; }
        .mouth-open { display: none; }
        .mouth-open.talking { display: block; }
        .mouth-closed.talking { display: none; }
        .eyes-open.blink { display: none; }
        .eyes-closed.blink { display: block; }
        .gesture-${pose} { transform: rotate(-4deg); transform-origin: center; }
      </style>
    </head>
    <body>
      <div class="frame">${svgContent}</div>
      <script>
        window.setTalking = (on) => {
          document.querySelectorAll('.mouth-open, .mouth-closed')
            .forEach(el => el.classList.toggle('talking', on));
        };
        window.setBlink = (on) => {
          document.querySelectorAll('.eyes-open, .eyes-closed')
            .forEach(el => el.classList.toggle('blink', on));
        };
      </script>
    </body>
  </html>`;
}

async function renderSceneFrames(page, pose, durationSec, frameOffset) {
  const totalFrames = Math.ceil(durationSec * FPS);
  await page.setContent(buildRigHtml(pose), { waitUntil: "load" });

  for (let i = 0; i < totalFrames; i++) {
    const talking = Math.floor(i / 3) % 2 === 0;
    const blink = i % (FPS * 3) < 3;
    await page.evaluate(
      (t, b) => {
        window.setTalking(t);
        window.setBlink(b);
      },
      talking,
      blink
    );
    const framePath = path.join(
      FRAMES_DIR,
      `frame_${String(frameOffset + i).padStart(6, "0")}.png`
    );
    await page.screenshot({ path: framePath });
  }
  return totalFrames;
}

function formatSrtTime(seconds) {
  const h = String(Math.floor(seconds / 3600)).padStart(2, "0");
  const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  const s = String(Math.floor(seconds % 60)).padStart(2, "0");
  const ms = String(Math.floor((seconds % 1) * 1000)).padStart(3, "0");
  return `${h}:${m}:${s},${ms}`;
}

async function main() {
  const storyboardPath = process.argv[2];
  if (!storyboardPath) {
    console.error("Kullanım: node render.js <storyboard.json>");
    process.exit(1);
  }
  const storyboard = JSON.parse(fs.readFileSync(storyboardPath, "utf8"));
  ensureDirs();

  const browser = await puppeteer.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1920 });

  let frameOffset = 0;
  const sceneAudioFiles = [];
  const srtLines = [];
  let cumulativeTime = 0;
  let srtIndex = 1;

  for (const [idx, scene] of storyboard.scenes.entries()) {
    const mp3Path = path.join(OUT_DIR, `scene_${idx}.mp3`);
    const duration = synthesize(scene.english_line, mp3Path);
    sceneAudioFiles.push(mp3Path);

    const framesRendered = await renderSceneFrames(
      page,
      scene.pose || "neutral",
      duration,
      frameOffset
    );
    frameOffset += framesRendered;

    const start = formatSrtTime(cumulativeTime);
    cumulativeTime += duration;
    const end = formatSrtTime(cumulativeTime);
    srtLines.push(`${srtIndex}\n${start} --> ${end}\n${scene.turkish_line}\n`);
    srtIndex++;
  }

  await browser.close();

  // Türkçe altyazı dosyasını yaz (hem gömme için hem artifact olarak)
  const srtPath = path.join(OUT_DIR, "subtitles_tr.srt");
  fs.writeFileSync(srtPath, srtLines.join("\n"));

  // Frame'leri sessiz videoya çevir
  sh(
    `ffmpeg -y -framerate ${FPS} -i "${FRAMES_DIR}/frame_%06d.png" ` +
      `-c:v libx264 -pix_fmt yuv420p "${OUT_DIR}/video_silent.mp4"`
  );

  // Ses dosyalarını birleştir
  const concatListPath = path.join(OUT_DIR, "audio_concat.txt");
  fs.writeFileSync(
    concatListPath,
    sceneAudioFiles.map((f) => `file '${f}'`).join("\n")
  );
  sh(
    `ffmpeg -y -f concat -safe 0 -i "${concatListPath}" -c copy "${OUT_DIR}/audio_full.mp3"`
  );

  // Video + ses + GÖMÜLÜ TÜRKÇE ALTYAZI
  // subtitles filtresi srt'yi videonun içine yakar (hardsub)
  const srtForFilter = srtPath.replace(/\\/g, "/").replace(/:/g, "\\:");
  sh(
    `ffmpeg -y -i "${OUT_DIR}/video_silent.mp4" -i "${OUT_DIR}/audio_full.mp3" ` +
      `-vf "subtitles='${srtForFilter}':force_style='FontName=Arial,FontSize=14,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,Bold=1,MarginV=60,Alignment=2'" ` +
      `-c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "${OUT_DIR}/final.mp4"`
  );

  console.log("Render tamamlandı: output/final.mp4 (Türkçe altyazı gömülü)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
