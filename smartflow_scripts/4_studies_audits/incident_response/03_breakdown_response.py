import pandas as pd, glob, re, numpy as np
src = "D:/OneDrive_2026-09-08/shared files/"
brk = pd.concat([pd.read_csv(f, dtype=str) for f in sorted(glob.glob(src+"breakdown_data_*.csv"))], ignore_index=True)
FIELDS=["service","dispatch_time","arrival_time","departure_time","response_time_min","service_time_min","remarks"]
rows=[]; nblocks=0
for _,r in brk[brk.deployments.notna()].iterrows():
    norm=re.sub(r"\}\s*\n?\s*\{","}, {",r.deployments)
    blocks=re.findall(r"\{[^{}]*\}",norm)
    for b in blocks:
        d={}
        for f in FIELDS:
            m=re.search(r"'%s':\s*(?:'([^']*)'|\"([^\"]*)\")"%f,b)
            d[f]=(m.group(1) if m and m.group(1) is not None else (m.group(2) if m else None))
        d.update(ev=r.EventNumber,start=r.event_encoded_date,dirn=r.Direction,loc=r.Location,sub=r.SubLocation,km=r.StartKM,cause=r.MainCause,cls=r.VehicleClass,status=r.EventStatus,detect=r.Detection)
        rows.append(d)
dep=pd.DataFrame(rows)
print("deployment rows parsed:", len(dep), "(ETL comment says 48,196 events carry deployments)")
for c in ["dispatch_time","arrival_time","departure_time","start"]: dep[c]=pd.to_datetime(dep[c],errors="coerce")
dep["resp"]=pd.to_numeric(dep.response_time_min,errors="coerce")
dep["svc"]=pd.to_numeric(dep.service_time_min,errors="coerce")
dep["km"]=pd.to_numeric(dep.km,errors="coerce")/1000
dep["lag"]=(dep.dispatch_time-dep.start).dt.total_seconds()/60
print("resp null",dep.resp.isna().sum(),"neg",(dep.resp<0).sum(),">240",(dep.resp>240).sum(),">1440",(dep.resp>1440).sum(),"==0",(dep.resp==0).sum())
print("empty arrival_time:", dep.arrival_time.isna().sum(), " empty dispatch:", dep.dispatch_time.isna().sum())
print("status:",dep.status.value_counts().to_dict())
clean=dep[(dep.resp>0)&(dep.resp<=240)&(dep.status!="DELETED")].copy()
print("clean rows",len(clean),"(%.1f%% of parsed)"%(len(clean)/len(dep)*100))
q=lambda s:s.quantile
def summ(g,col="resp"):
    return pd.Series({"n":len(g),"median":g[col].median(),"p90":g[col].quantile(.9),"mean":g[col].mean()})
print("\n== overall response (min)"); print(summ(clean).round(1).to_string())
print("\n== service time (min) overall"); print(summ(clean[clean.svc.between(0,480)],"svc").round(1).to_string())
print("\n== by service"); print(clean.groupby("service").apply(summ).round(1).sort_values("n",ascending=False).to_string())
clean["yr"]=clean.dispatch_time.dt.year
print("\n== by year"); print(clean.groupby("yr").apply(summ).round(1).to_string())
clean["hr"]=clean.dispatch_time.dt.hour
clean["band"]=pd.cut(clean.hr,[-1,4,8,11,15,19,23],labels=["00-04","05-08","09-11","12-15","16-19","20-23"])
print("\n== by hour band"); print(clean.groupby("band",observed=True).apply(summ).round(1).to_string())
print("\n== by direction"); print(clean.groupby("dirn").apply(summ).round(1).sort_values("n",ascending=False).head(6).to_string())
print("\n== by location"); print(clean.groupby("loc").apply(summ).round(1).sort_values("n",ascending=False).to_string())
print("\n== by cause"); print(clean.groupby("cause").apply(summ).round(1).sort_values("n",ascending=False).head(8).to_string())
clean["seg"]=(clean.km//10*10)
print("\n== by 10km segment"); print(clean.groupby("seg").apply(summ).round(1).to_string())
# SLA
for t in (10,15,20,30,45,60): print(f"share arrived within {t} min: {(clean.resp<=t).mean()*100:.1f}%")
print("\nreport->dispatch lag (0..120 min):"); l=clean[(clean.lag>=0)&(clean.lag<=120)].lag; print(l.describe(percentiles=[.5,.9]).round(1).to_string())
# what share of breakdown events get a deployment at all, and by cause
brk["has"]=pd.to_numeric(brk.deployment_count)>0
print("\nshare of breakdown events with a dispatch: %.1f%%"%(brk.has.mean()*100))
print(brk.groupby("MainCause").has.agg(["count","mean"]).sort_values("count",ascending=False).head(8).round(3).to_string())
print("\nVehicle col:"); print(brk.Vehicle.value_counts().head(5).to_string())
print("MaterialTraffic:"); print(brk.MaterialTraffic.value_counts(dropna=False).head(5).to_string())
