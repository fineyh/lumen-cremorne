"""Frames -> phone-cropped GIF (transparent corners) + MP4 (white corners) at a constant frame rate."""
import json, os, pathlib, shutil, subprocess, sys
import numpy as np
from PIL import Image, ImageDraw
import imageio_ffmpeg
FF = imageio_ffmpeg.get_ffmpeg_exe()
OUT = pathlib.Path(r"E:\Workspace\personal\cremorne\pitch-media")
FPS, GW = int(os.environ.get("FPS", 20)), int(os.environ.get("GW", 544))  # README clips: FPS=15 GW=400
names = sys.argv[1:] or ["1_role", "2_settings", "3_routes", "4_guide"]

def mask(w, h, r, ss=4):
    m = Image.new("L", (w * ss, h * ss), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, w * ss - 1, h * ss - 1), r * ss, fill=255)
    return m.resize((w, h), Image.LANCZOS)

for name in names:
    d = pathlib.Path("frames") / name
    m = json.load(open(d / "meta.json")); b = m["box"]; fr = m["frames"]
    t0 = fr[0]["wall"]; n = int((m["end"] - t0) * FPS) + 1
    tmp = pathlib.Path("build") / name
    shutil.rmtree(tmp, ignore_errors=True); (tmp / "g").mkdir(parents=True); (tmp / "v").mkdir()
    s = Image.open(d / fr[0]["f"]).width / m["vw"]
    crop = tuple(round(v * s) for v in (b["x"], b["y"], b["x"] + b["width"], b["y"] + b["height"]))
    W, H = crop[2] - crop[0], crop[3] - crop[1]
    W -= W % 2; H -= H % 2
    GH = round(GW * H / W); GH -= GH % 2
    mv = mask(W, H, 52 * s)
    corner = np.array(mask(GW, GH, 52 * s * GW / W)) < 128
    white = Image.new("RGB", (W, H), "white")
    j = 0
    for k in range(n):
        t = t0 + k / FPS
        while j + 1 < len(fr) and fr[j + 1]["wall"] <= t:
            j += 1
        im = Image.open(d / fr[j]["f"]).convert("RGB").crop(crop).crop((0, 0, W, H))
        Image.composite(im, white, mv).save(tmp / "v" / f"{k:05d}.png")
        im.resize((GW, GH), Image.LANCZOS).save(tmp / "g" / f"{k:05d}.png")  # corners are the navy page behind the phone

    # one 255-colour palette for the whole clip; index 255 is kept for the transparent corners alone,
    # so dithering can never punch a hole in the screen
    subprocess.run([FF, "-y", "-loglevel", "error", "-framerate", str(FPS), "-i", str(tmp / "g" / "%05d.png"),
                    "-vf", "palettegen=max_colors=255:reserve_transparent=0:stats_mode=full", str(tmp / "pal.png")], check=True)
    cols = list(dict.fromkeys(Image.open(tmp / "pal.png").convert("RGB").get_flattened_data()))[:255]
    flat = [c for rgb in cols for c in rgb]
    pal = Image.new("P", (1, 1)); pal.putpalette(flat + flat[:3] * (256 - len(cols)))
    frames = []
    for k in range(n):
        q = np.array(Image.open(tmp / "g" / f"{k:05d}.png").quantize(palette=pal, dither=Image.Dither.FLOYDSTEINBERG))
        q[q >= len(cols)] = 0  # padding entries repeat colour 0
        q[corner] = 255
        f = Image.fromarray(q, "P"); f.putpalette(flat + [0] * (3 * (255 - len(cols))) + [0, 255, 0])
        frames.append(f)
    out = name if name.startswith("phone_") else f"mia_{name}"
    gif, mp4 = OUT / f"{out}.gif", OUT / f"{out}.mp4"
    frames[0].save(gif, save_all=True, append_images=frames[1:], duration=1000 // FPS, loop=0,
                   transparency=255, disposal=1, optimize=False)
    subprocess.run([FF, "-y", "-loglevel", "error", "-framerate", str(FPS), "-i", str(tmp / "v" / "%05d.png"),
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "slow", "-movflags", "+faststart", str(mp4)], check=True)
    print(name, f"{n / FPS:.1f}s", f"gif {GW}x{GH} {gif.stat().st_size / 1e6:.1f}MB", f"mp4 {W}x{H} {mp4.stat().st_size / 1e6:.1f}MB")
