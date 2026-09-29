"""Solar position (NOAA spreadsheet algorithm, same maths pvlib's 'ephemeris' model uses).

Accurate to well under 0.5 degrees, which is far below the error in our building heights.
"""
import math
from datetime import date, datetime, time, timezone
from zoneinfo import ZoneInfo

from .geo import LAT0, LON0

MELBOURNE = ZoneInfo("Australia/Melbourne")


def solar_position(when: datetime, lat: float = LAT0, lon: float = LON0) -> tuple[float, float]:
    """Return (azimuth_deg clockwise from north, elevation_deg) for an aware datetime."""
    utc = when.astimezone(timezone.utc)
    jd = utc.timestamp() / 86400.0 + 2440587.5
    jc = (jd - 2451545.0) / 36525.0

    l0 = (280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360
    m = 357.52911 + jc * (35999.05029 - 0.0001537 * jc)
    ecc = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc)
    mr = math.radians(m)
    ctr = (
        math.sin(mr) * (1.914602 - jc * (0.004817 + 0.000014 * jc))
        + math.sin(2 * mr) * (0.019993 - 0.000101 * jc)
        + math.sin(3 * mr) * 0.000289
    )
    true_long = l0 + ctr
    omega = 125.04 - 1934.136 * jc
    app_long = true_long - 0.00569 - 0.00478 * math.sin(math.radians(omega))
    mean_obliq = 23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60
    obliq = mean_obliq + 0.00256 * math.cos(math.radians(omega))
    decl = math.asin(math.sin(math.radians(obliq)) * math.sin(math.radians(app_long)))

    y = math.tan(math.radians(obliq / 2)) ** 2
    l0r = math.radians(l0)
    eq_time = 4 * math.degrees(
        y * math.sin(2 * l0r)
        - 2 * ecc * math.sin(mr)
        + 4 * ecc * y * math.sin(mr) * math.cos(2 * l0r)
        - 0.5 * y * y * math.sin(4 * l0r)
        - 1.25 * ecc * ecc * math.sin(2 * mr)
    )
    minutes = utc.hour * 60 + utc.minute + utc.second / 60
    tst = (minutes + eq_time + 4 * lon) % 1440
    ha = math.radians(tst / 4 - 180)

    latr = math.radians(lat)
    cos_zen = math.sin(latr) * math.sin(decl) + math.cos(latr) * math.cos(decl) * math.cos(ha)
    zen = math.acos(max(-1.0, min(1.0, cos_zen)))
    elev = 90 - math.degrees(zen)

    denom = math.cos(latr) * math.sin(zen)
    if abs(denom) < 1e-9:
        az = 0.0
    else:
        cos_az = (math.sin(latr) * math.cos(zen) - math.sin(decl)) / denom
        a = math.degrees(math.acos(max(-1.0, min(1.0, cos_az))))
        az = (a + 180) % 360 if ha > 0 else (540 - a) % 360
    return az, elev


def local_dt(d: date, minutes: int) -> datetime:
    return datetime.combine(d, time(minutes // 60, minutes % 60), tzinfo=MELBOURNE)


def sun_times(d: date) -> tuple[int, int]:
    """Approximate sunrise / sunset in local minutes (first/last minute with elevation > 0)."""
    up = [m for m in range(0, 1440, 5) if solar_position(local_dt(d, m))[1] > 0]
    return (up[0], up[-1]) if up else (720, 720)
