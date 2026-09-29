import { useEffect, useRef, useState } from "react";
import { get, post, type AskAnswer, type Brief, type Meta } from "../api";

type Props = {
  meta: Meta;
  scenario: string;
  minutes: number;
  office: string;
  onShowRoute: (a: NonNullable<AskAnswer["action"]>) => void;
  onShowTime: (m: number) => void;
};

type Msg = { who: "me" | "lumen"; text: string; action?: AskAnswer["action"]; engine?: string };

const SUGGEST = [
  "Where's quiet for lunch?",
  "Coolest way from East Richmond to Era Building at 3:30pm?",
  "Which streets are hottest this afternoon?",
  "Least crowded walk to Sussan Group at 8:45am",
  "How do I get to Dover House at 7pm?",
];

function md(text: string) {
  // Slack-style *bold* only; everything else is plain text
  return text.split(/(\*[^*]+\*)/g).map((part, i) =>
    part.startsWith("*") && part.endsWith("*") ? <b key={i}>{part.slice(1, -1)}</b> : <span key={i}>{part}</span>,
  );
}

export default function BriefPanel({ meta, scenario, minutes, office, onShowRoute, onShowTime }: Props) {
  const [brief, setBrief] = useState<Brief | null>(null);
  const [officeId, setOfficeId] = useState(office.includes(",") ? meta.offices[0].id : office);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const chatEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setBrief(null);
    get<Brief>(`/api/brief?scenario=${scenario}&office=${officeId}`).then(setBrief).catch(() => setBrief(null));
  }, [scenario, officeId]);
  useEffect(() => {
    // block body on purpose: newer browsers return a Promise from scrollIntoView,
    // which React would try to call as the effect's cleanup
    chatEnd.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [msgs]);

  const ask = async (question: string) => {
    if (!question.trim()) return;
    setMsgs((m) => [...m, { who: "me", text: question }]);
    setQ("");
    setBusy(true);
    try {
      const a = await post<AskAnswer>("/api/ask", { question, scenario, t: minutes, office: officeId });
      setMsgs((m) => [...m, { who: "lumen", text: a.answer, action: a.action, engine: a.engine }]);
      if (a.action && a.action.type !== "route") onShowTime(a.action.minutes);
    } catch {
      setMsgs((m) => [...m, { who: "lumen", text: "Sorry, I couldn't reach the precinct model." }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="brief">
      <div className="office-pick">
        <label>Your office</label>
        <select value={officeId} onChange={(e) => setOfficeId(e.target.value)}>
          {meta.offices.filter((o) => o.name).map((o) => (
            <option key={o.id} value={o.id}>{o.name}</option>
          ))}
        </select>
      </div>

      <div className="slack">
        <div className="slack-bar"># cremorne-precinct</div>
        <div className="slack-msg">
          <img src="/lumen.svg" alt="" width={36} height={36} />
          <div>
            <div className="who">
              <b>Lumen</b> <span className="app">APP</span> <span className="ts">8:15 AM</span>
            </div>
            {brief ? brief.lines.map((l, i) => <p key={i}>{md(l)}</p>) : <p className="muted">Generating today's brief…</p>}
            <div className="react">
              <span>👍 Was the walk comfortable today?</span>
              <button>😎</button><button>🙂</button><button>🥵</button>
            </div>
          </div>
        </div>
      </div>
      {brief && (
        <p className="fine">
          Written by {brief.engine === "template" ? "the deterministic template (no LLM running)" : `a local model (${brief.engine.replace("ollama:", "")}) that never leaves this laptop`}.
          Every number comes from the backend; LLM output is rejected if any number changes.
        </p>
      )}

      <h3>Ask Lumen</h3>
      <div className="chat">
        {msgs.length === 0 && <p className="muted">Try one of these:</p>}
        {msgs.map((m, i) => (
          <div key={i} className={`bubble ${m.who}`}>
            {m.text}
            {m.action?.type === "route" && (
              <button className="link" onClick={() => onShowRoute(m.action!)}>Show on map →</button>
            )}
          </div>
        ))}
        {busy && <div className="bubble lumen muted">…</div>}
        <div ref={chatEnd} />
      </div>
      <div className="suggest">
        {SUGGEST.map((s) => (
          <button key={s} onClick={() => ask(s)}>{s}</button>
        ))}
      </div>
      <form className="ask" onSubmit={(e) => { e.preventDefault(); ask(q); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about routes, crowds or heat…" />
        <button type="submit" disabled={busy}>Ask</button>
      </form>
      <p className="fine">Questions are answered and discarded. Lumen stores no locations.</p>
    </div>
  );
}
