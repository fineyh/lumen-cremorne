"""SMS channel for delivery drivers, simulated on the phone screen for the demo.

Drivers are the one group without a desk, Slack or a reason to open a web app mid-shift, so they
get a text instead. Opt-in only: nothing is sent until someone texts JOIN. Keywords:

    JOIN    start           CHANGE  edit streets / switch to the web app for another role
    TODAY   today's windows STOP    opt out and delete the settings           HELP  this list

Anything else that names a time or asks about crowds ("busy at 5pm on Church St?") gets a rule-based
answer from the same street windows as TODAY, so the two texts never disagree. No LLM: the numbers
go out on SMS as computed.

The demo keeps each conversation under a random session id, never a phone number, and forgets it
on STOP or restart. A production gateway should be an Australian-hosted SMS provider rather than
an overseas API (e.g. Twilio), to keep the data-sovereignty story intact.
"""
from __future__ import annotations

import re
import threading

from .brief import parse_time
from .engine import Lumen, fmt_time
from .personal import WINDOW, _short, driver_sms, street_day, street_list

SESSIONS: dict[str, dict] = {}
_lock = threading.Lock()
MENU_SIZE = 9
MAX_SESSIONS = 2000
DAY = (360, 1200)  # street_day covers 6am-8pm
CROWD_WORDS = re.compile(r"busy|quiet|crowd|congest|packed|people|traffic|foot ?traffic|when", re.I)


def _menu(lumen: Lumen) -> list[str]:
    return street_list(lumen)[:MENU_SIZE]


def _menu_text(lumen: Lumen) -> str:
    return " ".join(f"{i + 1} {_short(s)}" for i, s in enumerate(_menu(lumen)))


def _today(lumen: Lumen, streets: list[str]) -> str:
    return driver_sms([street_day(lumen, s) for s in streets])


def _mentioned(lumen: Lumen, text: str) -> list[str]:
    low = text.lower()
    return [s for s in street_list(lumen)
            if re.search(rf"\b({re.escape(s.lower())}|{re.escape(_short(s).lower())})\b", low)][:3]


def _at(day: dict, t: int) -> str:
    for w in day["busy"]:
        if w["from_min"] <= t < w["to_min"]:
            return f"{day['short']} busy (LOS {w['worst']}) until {fmt_time(w['to_min'])}."
    soon = next((w for w in day["busy"] if t < w["from_min"] <= t + WINDOW), None)
    if soon:
        return f"{day['short']} quiet, but busy from {fmt_time(soon['from_min'])}."
    return f"{day['short']} quiet."


def _query(lumen: Lumen, msg: str, streets: list[str]) -> str | None:
    """Free-text question about a time or crowds -> one text, or None if it isn't one."""
    t = parse_time(msg, -1)
    if t < 0 and not CROWD_WORDS.search(msg):
        return None
    streets = _mentioned(lumen, msg) or streets or _menu(lumen)[:3]
    if t < 0:
        return _today(lumen, streets)
    if not DAY[0] <= t < DAY[1]:
        return f"Lumen models footpaths from {fmt_time(DAY[0])} to {fmt_time(DAY[1])}. Ask about a time in that range."
    return " ".join([f"Around {fmt_time(t)}:", *(_at(street_day(lumen, s), t) for s in streets)])


def handle(lumen: Lumen, sid: str, text: str, base_url: str = "") -> list[str]:
    msg = text.strip()
    word = msg.upper().split()[0] if msg else ""
    with _lock:
        s = SESSIONS.get(sid)
        if s is None and len(SESSIONS) >= MAX_SESSIONS:
            SESSIONS.pop(next(iter(SESSIONS)))

    if word == "STOP":
        with _lock:
            SESSIONS.pop(sid, None)
        return ["You're unsubscribed from Lumen Cremorne and your street list is deleted. Text JOIN to start again."]
    if word == "HELP":
        return ["Lumen Cremorne: quiet delivery windows for your streets, from a pedestrian model. "
                "TODAY = today's windows, CHANGE = edit, STOP = opt out. Free, no data kept."]
    if s is None:
        if word in ("JOIN", "START", "HI", "HELLO"):
            with _lock:
                SESSIONS[sid] = {"stage": "streets", "streets": []}
            return ["Welcome to Lumen Cremorne. We text delivery drivers when the footpaths on their streets are quiet. "
                    "You opted in; reply STOP any time.",
                    f"Which streets do you deliver on? Reply with up to 3 numbers, e.g. 1 3: {_menu_text(lumen)}"]
        answer = _query(lumen, msg, [])
        if answer:
            return [answer, "Text JOIN to get quiet windows for your own streets every weekday."]
        return ["Text JOIN to get quiet delivery windows for Cremorne streets by SMS."]

    stage = s["stage"]
    if word == "CHANGE":
        s["stage"] = "change"
        link = f"{base_url}/m" if base_url else "the Lumen web app"
        return [f"Reply 1 to change your streets. Office worker or shop owner? Open {link} (no login) instead."]
    if word == "TODAY" and s["streets"]:
        return [_today(lumen, s["streets"])]
    if stage == "change":
        if msg.strip() == "1":
            s["stage"] = "streets"
            return [f"Which streets? Reply with up to 3 numbers: {_menu_text(lumen)}"]
        return ["Reply 1 to change your streets, or STOP to opt out."]
    answer = _query(lumen, msg, s["streets"])
    if answer:
        return [answer]
    if stage == "streets":
        menu = _menu(lumen)
        nums = [int(n) for n in re.findall(r"\d+", msg) if 1 <= int(n) <= len(menu)]
        picked = list(dict.fromkeys(menu[n - 1] for n in nums))[:3]
        if not picked:
            return [f"Sorry, reply with numbers from the list, e.g. 1 3: {_menu_text(lumen)}"]
        s["streets"], s["stage"] = picked, "active"
        return [f"Done: {', '.join(_short(x) for x in picked)}. You'll get one text at 6:30am on weekdays. "
                "Here is today's:", _today(lumen, picked)]
    return ["Reply TODAY for today's windows, CHANGE to edit, STOP to opt out."]
