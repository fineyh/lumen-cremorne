// Recording props: a touch dot and an iOS-style picker sheet (headless Chrome never draws native <select> popups).
(() => {
  const css = `
  .m-side-note{display:none!important}
  body{background:#0b1324!important}
  #fx-finger{position:fixed;left:0;top:0;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;
    background:rgba(11,19,36,.22);border:2.5px solid rgba(255,255,255,.95);box-shadow:0 4px 14px rgba(11,19,36,.35);
    pointer-events:none;z-index:99999;opacity:0;transform:scale(1.25);
    transition:left .45s cubic-bezier(.3,.7,.2,1),top .45s cubic-bezier(.3,.7,.2,1),opacity .2s,transform .14s}
  #fx-finger.on{opacity:1;transform:scale(1)}
  #fx-finger.press{transform:scale(.78);background:rgba(11,19,36,.36)}
  #fx-finger.drag{transition:opacity .2s,transform .14s}
  .fx-wrap{position:absolute;inset:0;z-index:50;display:flex;flex-direction:column;justify-content:flex-end}
  .fx-dim{position:absolute;inset:0;background:rgba(11,19,36,.38);opacity:0;transition:opacity .28s}
  .fx-sheet{position:relative;background:#fff;border-radius:24px 24px 0 0;padding:8px 0 26px;
    transform:translateY(105%);transition:transform .34s cubic-bezier(.2,.8,.2,1);box-shadow:0 -10px 40px rgba(11,19,36,.2)}
  .fx-wrap.on .fx-dim{opacity:1} .fx-wrap.on .fx-sheet{transform:none}
  .fx-grab{width:38px;height:5px;border-radius:9px;background:#d5d9e0;margin:2px auto 10px}
  .fx-title{font-size:13px;font-weight:700;color:#74829a;text-align:center;padding:0 20px 10px;border-bottom:1px solid rgba(11,19,36,.08)}
  .fx-list{max-height:400px;overflow-y:auto;scrollbar-width:none}
  .fx-list::-webkit-scrollbar{display:none}
  .fx-row{display:flex;align-items:center;justify-content:space-between;height:50px;padding:0 22px;font-size:15.5px;font-weight:600;
    color:#0b1324;border-bottom:1px solid rgba(11,19,36,.06);transition:background .2s}
  .fx-row.on{color:#ea580c}
  .fx-row.hit{background:#fff4e0}
  .fx-row .ck{font-size:17px;font-weight:800;color:#ea580c}
  .fx-flash{animation:fxflash 1.1s ease}
  @keyframes fxflash{0%{box-shadow:0 0 0 0 rgba(245,158,11,0)}30%{box-shadow:0 0 0 4px rgba(245,158,11,.45);border-color:#f59e0b}100%{box-shadow:0 0 0 0 rgba(245,158,11,0)}}
  `;
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const finger = () => {
    let f = document.getElementById("fx-finger");
    if (!f) { f = document.createElement("div"); f.id = "fx-finger"; document.body.appendChild(f); }
    return f;
  };
  window.__fx = {
    install() {
      if (document.getElementById("fx-css")) return;
      const s = document.createElement("style"); s.id = "fx-css"; s.textContent = css; document.head.appendChild(s);
    },
    show(x, y, jump) {
      const f = finger();
      if (jump || !f.classList.contains("on")) { f.style.transition = "none"; f.style.left = x + "px"; f.style.top = y + "px"; f.offsetWidth; f.style.transition = ""; }
      else { f.style.left = x + "px"; f.style.top = y + "px"; }
      f.classList.add("on");
    },
    press(on) { finger().classList.toggle("press", on); },
    hide() { finger().classList.remove("on", "press"); },
    // finger drags upward while the container scrolls down, like a thumb swipe
    swipe(sel, dy, ms, x, y0) {
      const el = typeof sel === "string" ? document.querySelector(sel) : sel;
      const f = finger();
      const from = el.scrollTop, to = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, from + dy));
      const travel = Math.sign(dy) * Math.min(260, Math.abs(to - from) * 0.6 + 60);
      this.show(x, y0, true);
      f.classList.add("drag", "press");
      return new Promise((res) => {
        const t0 = performance.now();
        const step = (now) => {
          const t = Math.min(1, (now - t0) / ms), e = ease(t);
          el.scrollTop = from + (to - from) * e;
          f.style.top = y0 - travel * e + "px";
          if (t < 1) requestAnimationFrame(step);
          else { f.classList.remove("press"); setTimeout(() => { f.classList.remove("drag", "on"); res(to - from); }, 180); }
        };
        requestAnimationFrame(step);
      });
    },
    sheet(title, items, checked) {
      const scr = document.querySelector(".m-screen");
      const w = document.createElement("div"); w.className = "fx-wrap";
      w.innerHTML = `<div class="fx-dim"></div><div class="fx-sheet"><div class="fx-grab"></div><div class="fx-title"></div><div class="fx-list"></div></div>`;
      w.querySelector(".fx-title").textContent = title;
      const list = w.querySelector(".fx-list");
      items.forEach((t, i) => {
        const r = document.createElement("div"); r.className = "fx-row" + (i === checked ? " on" : "");
        r.innerHTML = `<span></span>${i === checked ? '<span class="ck">✓</span>' : ""}`;
        r.firstChild.textContent = t; list.appendChild(r);
      });
      scr.appendChild(w);
      // start with the checked row in view, as iOS does
      const row = list.children[checked];
      if (row) list.scrollTop = Math.max(0, row.offsetTop - list.clientHeight / 2 + 25);
      w.offsetWidth; w.classList.add("on");
    },
    sheetScroll(i, ms) {
      const list = document.querySelector(".fx-list"), row = list.children[i];
      const from = list.scrollTop, to = Math.max(0, Math.min(list.scrollHeight - list.clientHeight, row.offsetTop - list.clientHeight / 2 + 25));
      return new Promise((res) => {
        const t0 = performance.now();
        const step = (now) => { const t = Math.min(1, (now - t0) / ms); list.scrollTop = from + (to - from) * ease(t); t < 1 ? requestAnimationFrame(step) : res(); };
        requestAnimationFrame(step);
      });
    },
    // thumb drags the list up until row i sits mid-sheet
    sheetSwipe(i, ms) {
      const [x, y] = this.listRect(), f = finger();
      this.show(x, y, true); f.classList.add("drag", "press");
      const list = document.querySelector(".fx-list"), row = list.children[i];
      const from = list.scrollTop, to = Math.max(0, Math.min(list.scrollHeight - list.clientHeight, row.offsetTop - list.clientHeight / 2 + 25));
      const travel = Math.min(220, Math.abs(to - from) * 0.5 + 40) * Math.sign(to - from);
      return new Promise((res) => {
        const t0 = performance.now();
        const step = (now) => {
          const t = Math.min(1, (now - t0) / ms), e = ease(t);
          list.scrollTop = from + (to - from) * e; f.style.top = y - travel * e + "px";
          if (t < 1) requestAnimationFrame(step);
          else { f.classList.remove("press"); setTimeout(() => { f.classList.remove("drag", "on"); res(); }, 160); }
        };
        requestAnimationFrame(step);
      });
    },
    rowRect(i) { const r = document.querySelector(".fx-list").children[i].getBoundingClientRect(); return [r.x + r.width * 0.4, r.y + r.height / 2]; },
    listRect() { const r = document.querySelector(".fx-list").getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height * 0.75]; },
    pick(i) {
      const list = document.querySelector(".fx-list");
      [...list.children].forEach((r, k) => {
        r.classList.toggle("on", k === i); r.classList.toggle("hit", k === i);
        const ck = r.querySelector(".ck"); if (ck) ck.remove();
        if (k === i) r.insertAdjacentHTML("beforeend", '<span class="ck">✓</span>');
      });
    },
    closeSheet() {
      const w = document.querySelector(".fx-wrap"); if (!w) return;
      w.classList.remove("on"); setTimeout(() => w.remove(), 380);
    },
    flash(sel) { const el = document.querySelector(sel); el.classList.remove("fx-flash"); el.offsetWidth; el.classList.add("fx-flash"); },
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => window.__fx.install());
  else window.__fx.install();
})();
