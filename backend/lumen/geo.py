"""Local metric projection for a ~2 km precinct.

An equirectangular projection around Cremorne is accurate to a few cm over this extent and keeps
the geometry maths in metres without needing pyproj.
"""
import math

import numpy as np

LAT0 = -37.8285
LON0 = 144.9945
M_PER_DEG_LAT = 110_574.0
M_PER_DEG_LON = 111_320.0 * math.cos(math.radians(LAT0))

# Rough Cremorne boundary (Punt Rd, Swan St, Church St, Yarra) in lon/lat, used to pick
# "precinct" buildings for the evaluation and the console.
CREMORNE_LONLAT = [
    (144.9903, -37.8250),
    (144.9979, -37.8256),
    (144.9972, -37.8300),
    (144.9965, -37.8340),
    (144.9903, -37.8340),
]


def to_xy(lon, lat):
    lon = np.asarray(lon, dtype=float)
    lat = np.asarray(lat, dtype=float)
    return (lon - LON0) * M_PER_DEG_LON, (lat - LAT0) * M_PER_DEG_LAT


def to_lonlat(x, y):
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    return x / M_PER_DEG_LON + LON0, y / M_PER_DEG_LAT + LAT0


def ring_to_lonlat(coords, ndigits=6):
    """Shapely coordinate sequence (metres) -> list of [lon, lat]."""
    arr = np.asarray(coords, dtype=float)
    lon, lat = to_lonlat(arr[:, 0], arr[:, 1])
    return [[round(a, ndigits), round(b, ndigits)] for a, b in zip(lon, lat)]


def geom_to_geojson(geom):
    """Shapely (Multi)Polygon / LineString in metres -> GeoJSON geometry dict in lon/lat."""
    gt = geom.geom_type
    if gt == "Polygon":
        return {
            "type": "Polygon",
            "coordinates": [ring_to_lonlat(geom.exterior.coords)]
            + [ring_to_lonlat(r.coords) for r in geom.interiors],
        }
    if gt == "MultiPolygon":
        return {
            "type": "MultiPolygon",
            "coordinates": [geom_to_geojson(p)["coordinates"] for p in geom.geoms],
        }
    if gt == "LineString":
        return {"type": "LineString", "coordinates": ring_to_lonlat(geom.coords)}
    if gt == "GeometryCollection":
        polys = [g for g in geom.geoms if g.geom_type in ("Polygon", "MultiPolygon")]
        from shapely import MultiPolygon

        flat = []
        for p in polys:
            flat.extend(p.geoms if p.geom_type == "MultiPolygon" else [p])
        return geom_to_geojson(MultiPolygon(flat))
    raise ValueError(f"unsupported geometry {gt}")
