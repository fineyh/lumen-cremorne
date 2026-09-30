import { useEffect, useRef, useState } from "react";
import { ArrowUp, Info, ShieldCheck } from "lucide-react";
import { post } from "../api";

type Msg = { me: boolean; text: string };
const QUICK = ["JOIN", "1 6", "TODAY", "Busy at 5pm?", "CHANGE", "HELP", "STOP"];

// crypto.randomUUID only exists on https/localhost; phones on the LAN reach us over plain http
const rand = () => Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 10)).join("");

function sessionId() {
  // a random id per phone session: the demo never sees a phone number
  try {
    let id = sessionStorage.getItem("lumen.sms");
    if (!id) sessionStorage.setItem("lumen.sms", (id = rand()));
    return id;
  } catch {
    return rand();
  }
}

export default function SmsSim() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const sid = useRef(sessionId());
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [msgs, busy]);

  const send = async (t: string) => {
    if (!t.trim() || busy) return;
    setMsgs((m) => [...m, { me: true, text: t }]);
    setText("");
    setBusy(true);
    try {
      const r = await post<{ replies: string[] }>("/api/sms", { session: sid.current, text: t });
      for (const rep of r.replies) {
        await new Promise((res) => setTimeout(res, 450));
        setMsgs((m) => [...m, { me: false, text: rep }]);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sms">
      <div className="sms-top">
        <div className="sms-av">L</div>
        <div><b>Lumen Cremorne</b><small>0400 000 000 · simulated</small></div>
      </div>
      <div className="sms-note"><Info size={13} /> Demo: this screen plays both phones. A pilot would send real texts through an Australian-hosted SMS gateway.</div>
      <div className="sms-thread">
        {!msgs.length && <p className="sms-hint">Drivers see a poster at the loading bay: <b>“Text JOIN to 0400 000 000 for quiet unloading windows.”</b> Tap JOIN below.</p>}
        {msgs.map((m, i) => <div key={i} className={`sb ${m.me ? "me" : ""}`}>{m.text}</div>)}
        {busy && <div className="sb typing"><i /><i /><i /></div>}
        <div ref={end} />
      </div>
      <div className="sms-quick">
        {QUICK.map((q) => <button key={q} onClick={() => send(q)}>{q}</button>)}
      </div>
      <form className="sms-in" onSubmit={(e) => { e.preventDefault(); send(text); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Text message" maxLength={160} />
        <button type="submit" aria-label="Send" disabled={!text.trim()}><ArrowUp size={18} /></button>
      </form>
      <p className="sms-priv"><ShieldCheck size={12} /> Opt-in only. We keep only the streets you pick, never your location or number. STOP deletes everything.</p>
    </div>
  );
}
