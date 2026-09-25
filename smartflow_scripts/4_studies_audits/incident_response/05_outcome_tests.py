import pandas as pd, glob, re, numpy as np, warnings; warnings.filterwarnings("ignore")
src = "D:/OneDrive_2026-09-08/shared files/"
acc = pd.concat([pd.read_csv(f, dtype=str) for f in sorted(glob.glob(src+"accident_data_*.csv"))], ignore_index=True)
brk = pd.concat([pd.read_csv(f, dtype=str) for f in sorted(glob.glob(src+"breakdown_data_*.csv"))], ignore_index=True)
for c in ["event_start_date","SiteCleared","BlockageCleared"]: acc[c]=pd.to_datetime(acc[c],errors="coerce")
acc["km"]=pd.to_numeric(acc.StartKM,errors="coerce")/1000
acc=acc[(acc.EventStatus!="DELETED")&acc.km.notna()].copy()
acc["t"]=(acc.event_start_date-pd.Timestamp("2022-01-01")).dt.total_seconds()/60
acc["D"]=(acc.SiteCleared-acc.event_start_date).dt.total_seconds()/60
END=acc.t.max()
A={}
for d,g in acc.groupby("Direction"):
    g=g.sort_values("t"); A[d]=(g.t.values,g.km.values,g.index.values)
def count(d,t0,t1,km,R,excl=None):
    if d not in A: return 0
    T,K,I=A[d]; lo=np.searchsorted(T,t0,side="right"); hi=np.searchsorted(T,t1,side="right")
    if hi<=lo: return 0
    m=np.abs(K[lo:hi]-km)<=R
    if excl is not None: m&=I[lo:hi]!=excl
    return int(m.sum())
def ratio(a,ma,b,mb,label):
    r=(a/ma)/(b/mb) if b>0 and a>0 else float("nan"); se=np.sqrt(1/max(a,1)+1/max(b,1))
    print(f"{label}: during={a} events/{ma:,.0f} min  control={b} events/{mb:,.0f} min  rate ratio={r:.2f} (95% CI {r*np.exp(-1.96*se):.2f}-{r*np.exp(1.96*se):.2f})")

# TEST 1: accident lingering. rate of nearby accidents while uncleared vs equal-length window right after clearing
ok=acc[(acc.D>=5)&(acc.D<=240)&(acc.t+2*acc.D<END)]
print("TEST 1 — accidents: nearby (same direction, +-2km) accident rate while site uncleared vs equal window after clearing; n=",len(ok))
for skip in (0,5):
    a=b=0;ma=mb=0.0
    for i,r in ok.iterrows():
        a+=count(r.Direction,r.t+skip,r.t+r.D,r.km,2,i); ma+=max(r.D-skip,0)
        b+=count(r.Direction,r.t+r.D,r.t+2*r.D-skip,r.km,2,i); mb+=max(r.D-skip,0)
    ratio(a,ma,b,mb,f"  excluding first {skip} min of window")
# by clearance duration bucket
ok=ok.assign(bucket=pd.cut(ok.D,[4,15,30,60,120,241]))
print("  by how long the site stayed uncleared (rate per 1000 incident-hours, during vs after):")
for bk,g in ok.groupby("bucket",observed=True):
    a=b=0;m=0.0
    for i,r in g.iterrows():
        a+=count(r.Direction,r.t+5,r.t+r.D,r.km,2,i); b+=count(r.Direction,r.t+r.D,r.t+2*r.D-5,r.km,2,i); m+=max(r.D-5,0)
    print(f"   {str(bk):>10}: n={len(g):5d}  during {a/m*60000:6.1f}  after {b/m*60000:6.1f}  (events {a} vs {b})")

# TEST 2: stalled vehicles. accidents near a breakdown while it waits for a responder vs equal window before it
FIELDS=["dispatch_time","arrival_time"]
brk["t"]=(pd.to_datetime(brk.event_encoded_date,errors="coerce")-pd.Timestamp("2022-01-01")).dt.total_seconds()/60
brk["km"]=pd.to_numeric(brk.StartKM,errors="coerce")/1000
rows=[]
for i,r in brk[brk.deployments.notna()].iterrows():
    ar=[]
    for b in re.findall(r"\{[^{}]*\}",re.sub(r"\}\s*\n?\s*\{","}, {",r.deployments)):
        m=re.search(r"'arrival_time':\s*'([^']*)'",b)
        if m and m.group(1): ar.append(pd.Timestamp(m.group(1)))
    if ar: rows.append((i,(min(ar)-pd.Timestamp("2022-01-01")).total_seconds()/60))
w=pd.DataFrame(rows,columns=["i","arr_t"]).set_index("i"); b2=brk.join(w,how="inner")
b2["W"]=b2.arr_t-b2.t
b2=b2[(b2.W>=5)&(b2.W<=240)&(b2.t-b2.W>0)&(b2.t+b2.W<END)&b2.km.notna()&b2.Direction.isin(["NB","SB"])]
lane=b2.SubLocation.isin(["Lane1","Lane2","Lane3","Lane4"])
print("\nTEST 2 — breakdowns waiting for a responder (report->arrival, 5-240 min), n=",len(b2),"; accidents same direction +-1km")
for name,sub in (("all",b2),("in a live lane",b2[lane]),("shoulder/embankment/other",b2[~lane])):
    a=b=0;m=0.0
    for i,r in sub.iterrows():
        a+=count(r.Direction,r.t,r.t+r.W,r.km,1); b+=count(r.Direction,r.t-r.W,r.t,r.km,1); m+=r.W
    ratio(a,m,b,m,f"  {name} (n={len(sub)})")
# does longer wait => more crashes per breakdown? per-minute rate by wait bucket, live lane
sub=b2[lane].assign(bk=pd.cut(b2[lane].W,[4,15,30,60,241]))
print("  live-lane breakdowns, accident rate per 1000 breakdown-hours while waiting:")
for bk,g in sub.groupby("bk",observed=True):
    a=0;m=0.0
    for i,r in g.iterrows(): a+=count(r.Direction,r.t,r.t+r.W,r.km,1); m+=r.W
    print(f"   wait {str(bk):>10}: n={len(g):5d}  crashes {a:4d}  rate {a/m*60000:6.1f}")

# TEST 3: units vs clearance inside severity (confounded; shown only to check direction)
acc["sev"]=np.where(pd.to_numeric(acc.NumberOfFatality)>0,"Fatal",np.where(pd.to_numeric(acc.NumberOfInjured)>0,"Injury","PDO"))
acc["nd"]=pd.to_numeric(acc.deployment_count)
x=acc[(acc.D>=0)&(acc.D<=1440)]
print("\nTEST 3 — median site-clearance minutes by units sent, within severity")
for s,g in x.groupby("sev"):
    print("  ",s, g.groupby(pd.cut(g.nd,[-1,0,2,4,100])).D.agg(["count","median"]).round(1).to_dict("index"))
