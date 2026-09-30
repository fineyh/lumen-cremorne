import { Accessibility, CircleCheck, TriangleAlert } from "lucide-react";
import { stopWarnings, type Barrier, type Meta, type RouteAccess, type StepFreeVs } from "../api";
import { glyph } from "../accessIcons";
import type { Pin } from "./MiniMap";

/** Step-free on the phone: the switch, what it did to this walk, and where the steps are. */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const flights = (n: number) => `${plural(n, "flight")} of steps`;
const BARRIER_LABEL: Record<Barrier["kind"], string> = { steps: "Steps", kerb: "Raised kerb", blocked: "Not step-free" };

/** "2 flights of steps and a raised kerb" */
export function barrierText(a: Pick<RouteAccess, "steps" | "kerbs" | "blocked">) {
  const bits = [
    a.steps ? flights(a.steps) : "",
    a.kerbs ? plural(a.kerbs, "raised kerb") : "",
    a.blocked ? plural(a.blocked, "path", "paths") + " marked not step-free" : "",
  ].filter(Boolean);
  return bits.length > 1 ? `${bits.slice(0, -1).join(", ")} and ${bits[bits.length - 1]}` : bits[0] ?? "";
}

export function StepFreeSwitch({ on, onChange, dark = false }: { on: boolean; onChange: (on: boolean) => void; dark?: boolean }) {
  return (
    <button className={`m-sf ${on ? "on" : ""} ${dark ? "dark" : ""}`} role="switch" aria-checked={on} onClick={() => onChange(!on)}>
      <span className="m-sf-ic"><Accessibility size={15} /></span>
      <span className="m-sf-t">
        <b>Step-free</b>
        <small>{on ? "Avoiding steps and raised kerbs" : "For wheelchairs, prams and walking frames"}</small>
      </span>
      <span className="m-switch" aria-hidden="true"><i /></span>
    </button>
  );
}

/** What step-free means for this walk: what it avoided and what it cost, or the steps still on it. */
export function AccessNote({ access, vs, stepFree, onStepFree }: {
  access: RouteAccess; vs?: StepFreeVs | null; stepFree: boolean; onStepFree: (on: boolean) => void;
}) {
  if (!stepFree) {
    if (access.step_free) return null;
    return (
      <div className="m-acc warn">
        <TriangleAlert size={15} />
        <span>This way has {barrierText(access)}, marked on the map.</span>
        <button onClick={() => onStepFree(true)}>Go step-free</button>
      </div>
    );
  }
  if (!access.step_free)
    return (
      <div className="m-acc warn">
        <TriangleAlert size={15} />
        <span>No fully step-free way found. This one still has {barrierText(access)}, marked on the map.</span>
      </div>
    );
  const avoided = vs ? vs.avoided_steps + vs.avoided_kerbs : 0;
  return (
    <div className="m-acc good">
      <CircleCheck size={15} />
      <span>
        {vs && avoided > 0
          ? <>Step-free. Avoids {barrierText({ steps: vs.avoided_steps, kerbs: vs.avoided_kerbs, blocked: 0 })} for {vs.extra_min > 0.05 ? `+${vs.extra_min.toFixed(1)} min` : "no extra time"}.</>
          : <>Step-free. No steps or raised kerbs on the way.</>}
        {access.signal_crossings + access.unmarked_crossings + access.rough_m > 0 && (
          <small>
            {[
              access.signal_crossings + access.unmarked_crossings > 0
                ? `${plural(access.signal_crossings, "crossing")} with signals, ${access.unmarked_crossings} without` : "",
              access.rough_m > 0 ? `${access.rough_m} m of rough surface` : "",
            ].filter(Boolean).join(" · ")}
          </small>
        )}
      </span>
    </div>
  );
}

/** Tram stops without a level-access platform, with the nearest one that has it. */
export function StopNotes({ meta, refs, onUse }: { meta: Meta; refs: string[]; onUse?: (from: string, to: string) => void }) {
  return (
    <>
      {stopWarnings(meta, refs).map(({ stop, alt }) => (
        <div key={stop.id} className="m-acc warn">
          <Accessibility size={15} />
          <span>
            <b>{stop.name.replace(" (tram)", "")}</b> has no level-access platform.{" "}
            {alt ? <>Nearest one on Route {(alt.access.routes ?? []).join(", ")}: <b>{alt.name.replace(" (tram)", "")}</b>.</>
              : <>No level-access stop on Route {(stop.access.routes ?? []).join(", ")} nearby.</>}
          </span>
          {alt && onUse && <button onClick={() => onUse(stop.id, alt.id)}>Use it</button>}
        </div>
      ))}
    </>
  );
}

function BarrierIcon({ kind }: { kind: Barrier["kind"] }) {
  return <span className="mm-bar-ic" dangerouslySetInnerHTML={{ __html: glyph(kind === "steps" ? "stairs" : "kerb", 13, 2.6) }} />;
}

/** Map markers for the steps and raised kerbs on a walk. */
export function barrierMarks(barriers: Barrier[]): Pin[] {
  return barriers.map((b) => ({
    coord: [b.lon, b.lat], label: "", cls: `bar ${b.kind}`, title: `${BARRIER_LABEL[b.kind]} · ${b.street}`, icon: <BarrierIcon kind={b.kind} />,
  }));
}

/** The warning for one step of a walk, if it has steps or a raised kerb on it. */
export function stepBarrier(a: RouteAccess | undefined) {
  if (!a || a.step_free) return null;
  return a.steps ? (a.steps === 1 ? "Steps ahead" : `${a.steps} flights of steps ahead`) : a.kerbs ? "Raised kerb ahead" : "Not step-free here";
}
