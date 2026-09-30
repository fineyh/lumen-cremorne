"""SMS channel for delivery drivers, simulated on the phone screen for the demo.

Drivers are the one group without a desk, Slack or a reason to open a web app mid-shift, so they
get a text instead. Opt-in only: nothing is sent until someone texts JOIN. Keywords:

    JOIN    start           CHANGE  edit streets / switch to the web app for another role
    TODAY   today's windows STOP    opt out and delete the settings           HELP  this list

The demo keeps each conversation under a random session id, never a phone number, and forgets it
on STOP or restart. A production gateway should be an Australian-hosted SMS provider rather than
an overseas API (e.g. Twilio), to keep the data-sovereignty story intact.
"""
from __future__ import annotations

import re
import threading

from .engine import Lumen
from .personal import _short, driver_sms, street_day, street_list

SESSIONS: dict[str, dict] = {}
_lock = threading.Lock()
MENU_SIZE = 9
MAX_SESSIONS = 2000


def _menu(lumen: Lumen) -> list[str]:
    return street_list(lumen)[:MENU_SIZE]


def _menu_text(lumen: Lumen) -> str:
    return " ".join(f"{i + 1} {_short(s)}" for i, s in enumerate(_menu(lumen)))


def _today(lumen: Lumen, streets: list[str]) -> str:
    return driver_sms([street_day(lumen, s) for s in streets])


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
