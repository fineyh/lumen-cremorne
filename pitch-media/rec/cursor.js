// Recording prop for the Console: a mouse pointer that glides between targets and ripples on click.
(() => {
  const css = `
  #fx-cur{position:fixed;left:0;top:0;width:26px;height:26px;pointer-events:none;z-index:99999;opacity:0;
    transition:left .55s cubic-bezier(.3,.7,.2,1),top .55s cubic-bezier(.3,.7,.2,1),opacity .2s;filter:drop-shadow(0 2px 3px rgba(11,19,36,.35))}
  #fx-cur.on{opacity:1}
  #fx-cur.drag{transition:opacity .2s}
  .fx-rip{position:fixed;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:3px solid rgba(234,88,12,.85);
    pointer-events:none;z-index:99998;animation:fxrip .5s ease-out forwards}
  @keyframes fxrip{from{transform:scale(.3);opacity:1}to{transform:scale(1.4);opacity:0}}
  `;
  const svg = `<svg viewBox="0 0 26 26" width="26" height="26"><path d="M4 2 L4 21 L9 16.5 L12.5 24 L16 22.5 L12.6 15 L19.5 15 Z"
    fill="#0b1324" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
  const cur = () => {
    let c = document.getElementById("fx-cur");
    if (!c) { c = document.createElement("div"); c.id = "fx-cur"; c.innerHTML = svg; document.body.appendChild(c); }
    return c;
  };
  window.__cur = {
    install() {
      if (document.getElementById("fx-cur-css")) return;
      const s = document.createElement("style"); s.id = "fx-cur-css"; s.textContent = css; document.head.appendChild(s);
    },
    move(x, y, jump) {
      const c = cur();
      if (jump || !c.classList.contains("on")) { c.style.transition = "none"; c.style.left = x - 4 + "px"; c.style.top = y - 2 + "px"; c.offsetWidth; c.style.transition = ""; }
      else { c.style.left = x - 4 + "px"; c.style.top = y - 2 + "px"; }
      c.classList.add("on");
    },
    drag(on) { cur().classList.toggle("drag", on); },
    ripple(x, y) {
      const r = document.createElement("div"); r.className = "fx-rip"; r.style.left = x + "px"; r.style.top = y + "px";
      document.body.appendChild(r); setTimeout(() => r.remove(), 600);
    },
    hide() { cur().classList.remove("on"); },
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => window.__cur.install());
  else window.__cur.install();
})();
