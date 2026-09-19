import json, urllib.request
km = {  # from Front-End-Dashboard/lib/nlex-exits.ts
 "balintawak":0,"nlex harbor link":1.63,"paso de blas valenzuela":3.44,"meycauayan":8.21,
 "marilao":11.73,"cdv/ph arena":14.05,"bocaue interchange":19.0,"bocaue barrier":20.0,
 "balagtas":23.0,"tabang guiguinto":28.0,"sta. rita guiguinto":31.0,"pulilan":35.0,
 "san simon":46.0,"san fernando":56.0,"mexico":62.0,"dau":68.0,"angeles":72.0,
 "sta. ines":76.25,"tambubong":25.0,
}
d = json.load(urllib.request.urlopen(
  "http://localhost:4000/api/ai-sandbox/plaza-flows?direction=NB", timeout=60))["data"]
flows = {p["exit"].lower().strip(): p for p in d["plazas"]}

def mainline(at_km, hour):
    tot = 0.0
    for name, p in flows.items():
        k = km.get(name)
        if k is None or k > at_km + 1e-9: continue
        tot += p["entriesByHour"][hour] - p["exitsByHour"][hour]
    return tot

print("Northbound mainline flow across Km 3.29 (start of the screenshot's segment)")
print("hour   mainline veh/h    contributors")
for h in (3, 8, 12, 19):
    up = [(n, round(p["entriesByHour"][h]), round(p["exitsByHour"][h]))
          for n, p in flows.items()
          if km.get(n) is not None and km[n] <= 3.29 and (p["entriesByHour"][h] or p["exitsByHour"][h])]
    print(f"  {h:02d}:00 {mainline(3.29,h):12.0f}       " +
          ", ".join(f"{n}+{e}" + (f"-{x}" if x else "") for n,e,x in up))
print()
print("Along the corridor at the busiest hour (19:00):")
for k in (0, 3.29, 8.21, 11.73, 14.05, 20.0, 35.0, 56.0):
    print(f"  Km {k:>5}  {mainline(k,19):7.0f} veh/h")
