"""Download the open data Lumen needs for Cremorne from OpenStreetMap (Overpass API).

Run once before the hackathon demo; the output is cached in data/raw/ so the demo runs offline.

    python data/fetch_osm.py            # everything
    python data/fetch_osm.py pois       # just one layer
"""
import json
import pathlib
import sys
import time

import requests

# Cremorne plus a buffer so buildings just outside the precinct still cast shadows in,
# and Richmond / East Richmond stations are inside the network.
BBOX = (-37.8360, 144.9860, -37.8205, 145.0030)  # south, west, north, east
OUT = pathlib.Path(__file__).parent / "raw"
ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
HEADERS = {"User-Agent": "Lumen-FEIT-Hackathon/0.1"}

bb = ",".join(str(v) for v in BBOX)
QUERIES = {
    "buildings": f"""
        [out:json][timeout:90];
        (way["building"]({bb}); relation["building"]({bb}););
        out body geom;""",
    "ways": f"""
        [out:json][timeout:90];
        way["highway"~"^(footway|pedestrian|path|steps|living_street|residential|service|unclassified|tertiary|secondary|primary|tertiary_link|secondary_link|cycleway)$"]({bb});
        out body geom;""",
    "trunk": f"""
        [out:json][timeout:60];
        way["highway"~"^(trunk|trunk_link|motorway)$"]["name"]({bb});
        out body geom;""",
    "trees": f"""
        [out:json][timeout:60];
        node["natural"="tree"]({bb});
        out;""",
    "transit": f"""
        [out:json][timeout:60];
        (
          node["railway"="station"]({bb});
          way["railway"="station"]({bb});
          node["railway"="tram_stop"]({bb});
          node["public_transport"="platform"]["tram"="yes"]({bb});
        );
        out center tags;""",
    "water": f"""
        [out:json][timeout:60];
        (way["waterway"="river"]({bb}); way["natural"="water"]({bb}); relation["natural"="water"]({bb}););
        out body geom;""",
    # Places people pop out to between meetings: shops, food, seats, parks, toilets, water, gyms and classes.
    "pois": f"""
        [out:json][timeout:90];
        (
          nwr["amenity"~"^(cafe|fast_food|restaurant|pub|ice_cream|pharmacy|atm|bank|toilets|drinking_water|bench|shelter)$"]({bb});
          nwr["shop"]({bb});
          nwr["leisure"~"^(park|garden|picnic_table|fitness_centre|sports_centre|dance)$"]({bb});
          nwr["amenity"="dojo"]({bb});
        );
        out tags geom;""",
    # Step-free access: kerb ramps, crossings, steps, accessible parking and toilets, platforms, bus stops.
    "access": f"""
        [out:json][timeout:90];
        (
          node["kerb"]({bb});
          node["highway"~"^(crossing|traffic_signals|elevator|bus_stop)$"]({bb});
          node["tactile_paving"="yes"]({bb});
          nw["highway"="steps"]({bb});
          nw["ramp:wheelchair"]({bb});
          nw["amenity"~"^(toilets|parking_space)$"]({bb});
          nw["wheelchair"]({bb});
          nw["railway"="platform"]({bb});
        );
        out tags center;""",
}


def run(name: str, query: str) -> None:
    for attempt in range(4):
        url = ENDPOINTS[attempt % len(ENDPOINTS)]
        try:
            r = requests.post(url, data={"data": query}, headers=HEADERS, timeout=180)
            r.raise_for_status()
            data = r.json()
            (OUT / f"{name}.json").write_text(json.dumps(data), encoding="utf-8")
            print(f"{name}: {len(data['elements'])} elements  ({url})")
            return
        except Exception as exc:  # noqa: BLE001 - retry any network/parse failure
            print(f"{name}: attempt {attempt + 1} failed: {exc}")
            time.sleep(5 * (attempt + 1))
    raise SystemExit(f"could not fetch {name}")


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for name, q in QUERIES.items():
        if len(sys.argv) < 2 or name in sys.argv[1:]:
            run(name, q)
