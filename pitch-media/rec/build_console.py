"""Console frames -> GIF (README) + MP4 at a constant frame rate, sped up by the clip's `speed`."""
import json, pathlib, shutil, subprocess, sys
from PIL import Image
import imageio_ffmpeg
FF = imageio_ffmpeg.get_ffmpeg_exe()
OUT = pathlib.Path(__file__).resolve().parents[1]
FPS, GW = 12, 1200
names = sys.argv[1:] or ["sun", "crowd", "whatif", "access"]

for name in names:
    d = pathlib.Path("frames") / f"c_{name}"
    m = json.load(open(d / "meta.json")); fr = m["frames"]; sp = m.get("speed", 1.0)
    t0 = fr[0]["wall"]; n = int((m["end"] - t0) / sp * FPS) + 1
    tmp = pathlib.Path("build") / f"c_{name}"
    shutil.rmtree(tmp, ignore_errors=True); tmp.mkdir(parents=True)
    j = 0
    for k in range(n):
        t = t0 + k * sp / FPS
        while j + 1 < len(fr) and fr[j + 1]["wall"] <= t:
            j += 1
        shutil.copy(d / fr[j]["f"], tmp / f"{k:05d}.jpg")
    gif, mp4 = OUT / f"{name}.gif", OUT / f"{name}.mp4"
    src = ["-framerate", str(FPS), "-i", str(tmp / "%05d.jpg")]
    # one palette for the whole clip; diff-only frames keep the static panels from bloating the file
    subprocess.run([FF, "-y", "-loglevel", "error", *src, "-vf",
                    f"scale={GW}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];"
                    "[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle", str(gif)], check=True)
    subprocess.run([FF, "-y", "-loglevel", "error", *src, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20",
                    "-preset", "slow", "-movflags", "+faststart", str(mp4)], check=True)
    print(name, f"{n / FPS:.1f}s", f"gif {gif.stat().st_size / 1e6:.1f}MB", f"mp4 {mp4.stat().st_size / 1e6:.1f}MB")
