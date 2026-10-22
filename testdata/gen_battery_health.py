"""Battery-health fixture on the TeslaMate schema (v1.1.0 / api_level 14): 2 years, 260 sessions with per-minute charges rows,
rated range fading ~7.5 %, cold-weather usable < battery level, tiny top-ups, one unfinished session and one bogus
usable_battery_level = 1 row (sanity-filter case). Load after schema.sql. Verified: /battery `tm` equals TeslaMate's Grafana
"Battery Health" SQL on this data (with the bogus row deleted): now 75.01 kWh, max 81.36 kWh, health 92.2 %, cycles 120."""
import random, datetime as dt, math
random.seed(7)
o=[]
o.append("INSERT INTO cars (id,eid,vid,model,efficiency,vin,name,marketing_name) VALUES (1,1,1,'Y',0.152,'VINFIX0000000001','Fixture Y','Model Y Long Range');")
o.append("INSERT INTO cars (id,eid,vid,model,efficiency,vin,name,marketing_name) VALUES (2,2,2,'3',0.1345,'VINFIX0000000002','Empty 3','Model 3');")
t=dt.datetime(2024,10,1,8); odo=1200.0; pid=0; cid=0; chid=0; pos=[]; cps=[]; chs=[]
E=0.153  # kWh per rated km (true constant)
for s in range(260):
    t+=dt.timedelta(hours=random.uniform(40,90)); odo+=random.uniform(80,260)
    frac=(odo-1200)/42000; r100=532*(1-0.075*frac)-random.uniform(0,1.5)  # rated km at 100 %
    month=t.month; cold= month in (12,1,2)
    sl=random.randint(10,55); el=random.choice([80,80,80,90,70,85,100,60,75]) if s%17 else 95
    if s%23==0: el=min(sl+3,100)   # tiny top-up (< efficiency kWh → excluded)
    pid+=1; pos.append(f"({pid},'{t:%Y-%m-%d %H:%M:%S}',35.6,139.6,{odo:.1f},{sl},1,{r100*sl/100:.2f},{r100*sl/100:.2f},{sl})")
    cid+=1; dur=int((el-sl)*1.1)+5; end=t+dt.timedelta(minutes=dur) if s!=259 else None
    added=E*r100*(el-sl)/100*random.uniform(0.995,1.005)
    lvl=sl
    for m in range(dur):
        lvl=min(el, sl+(el-sl)*m/max(1,dur-5)); bl=round(lvl)
        ul=bl-(2 if cold and m<dur/2 else 0)
        rr=r100*ul/100*random.uniform(0.998,1.002)
        if s==120 and m==dur-1: ul=1          # bogus usable level → absurd capacity sample (sanity filter case)
        chid+=1; chs.append(f"({chid},'{t+dt.timedelta(minutes=m):%Y-%m-%d %H:%M:%S}',{bl},{added*m/dur:.2f},11,{rr*1.02:.2f},{cid},{rr:.2f},{ul},1)")
    cps.append(f"({cid},'{t:%Y-%m-%d %H:%M:%S}',{('NULL' if end is None else repr(f'{end:%Y-%m-%d %H:%M:%S}'))},{added:.2f},{sl},{el},{dur},1,{pid},{r100*sl/100:.2f},{r100*el/100:.2f},{added*1.08:.2f})")
    t+=dt.timedelta(minutes=dur)
o.append("INSERT INTO positions (id,date,latitude,longitude,odometer,battery_level,car_id,rated_battery_range_km,ideal_battery_range_km,usable_battery_level) VALUES\n"+",\n".join(pos)+";")
o.append("INSERT INTO charging_processes (id,start_date,end_date,charge_energy_added,start_battery_level,end_battery_level,duration_min,car_id,position_id,start_rated_range_km,end_rated_range_km,charge_energy_used) VALUES\n"+",\n".join(cps)+";")
for i in range(0,len(chs),5000):
    o.append("INSERT INTO charges (id,date,battery_level,charge_energy_added,charger_power,ideal_battery_range_km,charging_process_id,rated_battery_range_km,usable_battery_level,charger_phases) VALUES\n"+",\n".join(chs[i:i+5000])+";")
open('battery_health_fixture.sql','w').write("\n".join(o)+"\nANALYZE;\n")
print(cid, chid)
