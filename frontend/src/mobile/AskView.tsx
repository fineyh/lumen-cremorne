import { useEffect, useRef, useState } from "react";
import { ArrowUp, Navigation2 } from "lucide-react";
import { post, type AskAnswer } from "../api";
import type { Settings } from "./MobileApp";
import { phoneNow } from "./GoView";

export type AskMsg = { who: "me" | "lumen"; text: string; action?: AskAnswer["action"] };

const SUGGEST = [
  "Where's quiet for lunch?",
  "Coffee in 15 min?",
  "Shady spot to sit for 30 min at 12:30pm?",
  "Which streets are hottest this afternoon?",
  "Coolest way to Dover House at 3:30pm?",
];
const TONE = { busy: "busy", quiet: "quiet", hot: "sun" } as const;

/** Ask Lumen on the phone: the same answers as the Console's chat, with routes opening in Walk. */
export default function AskView({ s, scenario, msgs, setMsgs, onRoute }: {
  s: Settings; scenario: string; msgs: AskMsg[]; setMsgs: (f: (m: AskMsg[]) => AskMsg[]) => void;
  onRoute: (a: NonNullable<AskAnswer["action"]>, label: string) => void;
}) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // block body: newer browsers return a Promise from scrollIntoView, which React would call as cleanup
    end.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [msgs, busy]);

  const ask = async (question: string) => {
    if (!question.trim() || busy) return;
    setMsgs((m) => [...m, { who: "me", text: question }]);
    setQ("");
    setBusy(true);
    try {
      const a = await post<AskAnswer>("/api/ask", { question, scenario, t: phoneNow(), office: s.office });
      setMsgs((m) => [...m, { who: "lumen", text: a.answer, action: a.action }]);
    } catch {
      setMsgs((m) => [...m, { who: "lumen", text: "Sorry, I couldn't reach Lumen. Check your connection and try again." }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="m-stack ask">
      {msgs.length === 0 && (
        <section className="m-card ask-intro">
          <b>Ask about routes, crowds or heat.</b>
          <p>Answers use the same shade and crowd models as your Today card. Questions are answered and forgotten.</p>
        </section>
      )}
      <div className="ask-thread">
        {msgs.map((m, i) => (
          <div key={i} className={`ask-b ${m.who}`}>
            {m.text}
            {m.action?.streets?.length ? (
              <div className="nb-chips">
                {m.action.streets.map((st) => <span key={st.name} className={`nb-chip ${TONE[st.tone]}`}>{st.name}</span>)}
              </div>
            ) : null}
            {m.action?.type === "route" && (
              <button className="ask-go" onClick={() => onRoute(m.action!, answerPlace(m.text))}>
                <Navigation2 size={13} /> Open in Walk
              </button>
            )}
          </div>
        ))}
        {busy && <div className="ask-b lumen typing"><i /><i /><i /></div>}
        <div ref={end} />
      </div>
      <div className="ask-sug">
        {SUGGEST.map((x) => <button key={x} onClick={() => ask(x)} disabled={busy}>{x}</button>)}
      </div>
      <form className="ask-form" onSubmit={(e) => { e.preventDefault(); ask(q); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask Lumen…" maxLength={300} aria-label="Your question" />
        <button type="submit" disabled={busy || !q.trim()} aria-label="Ask"><ArrowUp size={18} /></button>
      </form>
    </div>
  );
}

/** A nearby answer names the place first ("Cafe X (1 Swan St): ..." or "Park Y: ..."): used to label the pin. */
function answerPlace(text: string) {
  const m = text.match(/^([^:(]{2,60}?)(?: \(|:)/);
  return m ? m[1].trim() : "Place from Ask Lumen";
}
