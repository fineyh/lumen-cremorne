import { Footprints, Sparkles, TreeDeciduous, Users, type LucideIcon } from "lucide-react";
import type { Route } from "../api";

/** Which way to walk: shared by the Today card and Nearby, and remembered on this phone. */
export type Pref = "auto" | Route["mode"];
export const PREFS: { key: Pref; label: string; icon: LucideIcon }[] = [
  { key: "auto", label: "Auto", icon: Sparkles },
  { key: "shortest", label: "Shortest", icon: Footprints },
  { key: "coolest", label: "Shadiest", icon: TreeDeciduous },
  { key: "calmest", label: "Quietest", icon: Users },
];
const PREF_KEY = "lumen.phone.routePref";
export function loadPref(): Pref {
  try {
    const v = localStorage.getItem(PREF_KEY);
    return PREFS.some((p) => p.key === v) ? (v as Pref) : "auto";
  } catch {
    return "auto";
  }
}
export function savePref(p: Pref) {
  try {
    localStorage.setItem(PREF_KEY, p);
  } catch {
    /* private mode: remembered for this visit only */
  }
}
