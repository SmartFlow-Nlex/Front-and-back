import pandas as pd, glob, re, numpy as np, warnings; warnings.filterwarnings("ignore")
src = "D:/OneDrive_2026-09-08/shared files/"
brk = pd.concat([pd.read_csv(f, dtype=str) for f in sorted(glob.glob(src+"breakdown_data_*.csv"))], ignore_index=True)
FIELDS=["service","dispatch_time","arrival_time","departure_time","response_time_min","service_time_min","remarks"]
rows=[]
for _,r in brk[brk.deployments.notna()].iterrows():
    for b in re.findall(r"\{[^{}]*\}",re.sub(r"\}\s*\n?\s*\{","}, {",r.deployments)):
        d={}
        for f in FIELDS:
            m=re.search(r"'%s':\s*(?:'([^']*)'|\"([^\"]*)\")"%f,b); d[f]=(m.group(1) if m and m.group(1) is not None else (m.group(2) if m else None))
        d.update(ev=r.EventNumber,start=r.event_encoded_date,dirn=r.Direction,loc=r.Location,km=r.StartKM,cause=r.MainCause,veh=r.Vehicle,detect=r.Detection,sloop=r.SLoop,ndep=r.deployment_count)
        rows.append(d)
dep=pd.DataFrame(rows)
for c in ["dispatch_time","arrival_time","departure_time","start"]: dep[c]=pd.to_datetime(dep[c],errors="coerce")
dep["resp"]=pd.to_numeric(dep.response_time_min,errors="coerce"); dep["svc"]=pd.to_numeric(dep.service_time_min,errors="coerce")
dep["km"]=pd.to_numeric(dep.km,errors="coerce")/1000
z=dep[dep.resp==0]
print("resp==0 rows:",len(z)); print("by service:",z.service.value_counts().to_dict()); print("by Vehicle col:",z.veh.value_counts().head(4).to_dict()); print("by detection:",z.detect.value_counts().head(4).to_dict())
print("all rows by Vehicle col:",dep.veh.value_counts().head(4).to_dict())
print("median svc of zero-resp:", z.svc.median())
# response including zeros
ok=dep[(dep.resp>=0)&(dep.resp<=240)]
print("\nincluding zeros: n=%d median=%.1f p90=%.1f mean=%.1f"%(len(ok),ok.resp.median(),ok.resp.quantile(.9),ok.resp.mean()))
print("AAP only >0: median %.1f p90 %.1f"%(ok[(ok.service=="AAP")&(ok.resp>0)].resp.median(), ok[(ok.service=="AAP")&(ok.resp>0)].resp.quantile(.9)))
# top remarks tokens
rem=dep.remarks.dropna().str.lower().str.replace(r"[^a-z ]"," ",regex=True).str.split().explode()
print("\ntop remark words:",rem.value_counts().head(25).to_dict())
# km x hour interaction on positive responses
c=dep[(dep.resp>0)&(dep.resp<=240)].copy()
c["seg"]=pd.cut(c.km,[0,20,50,100],labels=["km0-20","km20-50","km50+"])
c["peak"]=np.where(c.dispatch_time.dt.hour.between(16,19),"pm-peak",np.where(c.dispatch_time.dt.hour.between(6,9),"am-peak","other"))
print("\nmedian/p90 response by segment x period")
print(c.groupby(["seg","peak"]).resp.agg(["count","median",lambda s:s.quantile(.9)]).round(1).to_string())
# day-of-week / weekend
c["dow"]=c.dispatch_time.dt.dayofweek
print("\nweekday vs weekend"); print(c.groupby(c.dow>=5).resp.agg(["count","median",lambda s:s.quantile(.9)]).round(1).to_string())
# multi-dispatch events: does 2nd unit arrive later?
print("\nevents with multiple dispatches:", (pd.to_numeric(dep.ndep)>1).sum(), "rows")
# Total time responder engaged
c["eng"]=c.resp+c.svc
print("\nengagement (resp+service) per dispatch: median %.0f p90 %.0f min"%(c.eng.median(),c.eng.quantile(.9)))
# dispatches per hour of day -> workload for units
hrs=c.groupby(c.dispatch_time.dt.hour).size()
print("dispatch records by hour:",hrs.to_dict())
# Fixed span, not max-min: one row is dated 2029 (a typo in the source), which would stretch a max-min span and understate the rate.
days=(pd.Timestamp("2026-06-30")-pd.Timestamp("2022-01-01")).days+1
c=c[c.dispatch_time<=pd.Timestamp("2026-06-30 23:59:59")]
print("avg dispatches/day:", round(len(c)/days,1), "peak-hour avg per day at hour 17:", round(hrs.get(17,0)/days,2))
