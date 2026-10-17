import csv,json,math,random,datetime,zipfile,pathlib,collections
R=random.Random(20261017)
out=pathlib.Path('/workspace/scratch/993a97f6aa90/outputs/foodfit_synthetic')
today=datetime.date(2026,10,17);asof=datetime.date(2026,10,11)
tables={};desc={}
def save(name,rows,description):
 assert rows,name
 tables[name]=rows;desc[name]=description
 with (out/(name+'.csv')).open('w',newline='') as f:
  w=csv.DictWriter(f,fieldnames=rows[0]);w.writeheader();w.writerows(rows)
areas=[('A01','Simulated Richardson area',32.948,-96.729,18000,44000,0.13,0.10,0.21),('A02','Simulated South Dallas area',32.735,-96.765,23000,32000,0.24,0.21,0.36),('A03','Simulated West Dallas area',32.782,-96.865,20500,37000,0.20,0.16,0.31),('A04','Simulated East Dallas area',32.813,-96.701,26000,41000,0.17,0.14,0.28),('A05','Simulated Oak Cliff area',32.709,-96.837,24000,35000,0.22,0.18,0.33)]
save('service_areas',[dict(service_area_id=a,name=n,latitude=lat,longitude=lon,population=pop,median_household_income_usd=inc,poverty_rate=pov,no_vehicle_household_rate=car,low_food_access_population_rate=access,is_synthetic=True) for a,n,lat,lon,pop,inc,pov,car,access in areas],'Fictional area-level features; IDs are custom, not Census tract identifiers. Rates are fractions.')
pantries=[]
for i,a in enumerate(areas):
 pantries.append(dict(pantry_id=f'P{i+1:02}',name=f'FoodFit Simulated Pantry {i+1}',service_area_id=a[0],latitude=a[2]+.006,longitude=a[3]-.005,storage_capacity_kg=[1800,2300,2000,2100,2200][i],cold_storage_capacity_kg=[450,600,500,550,550][i],weekly_household_capacity=[125,160,140,145,150][i],is_synthetic=True))
save('pantries',pantries,'Fictional pantry sites and capacities; coordinates are illustrative and do not identify real pantry facilities.')
save('pantry_hours',[dict(pantry_id=p['pantry_id'],day_of_week=d,opens_at=o,closes_at=c,appointment_required=(i%2==0),is_synthetic=True) for i,p in enumerate(pantries) for d,o,c in [('Tuesday','09:00','13:00'),('Thursday','14:00','18:00'),('Saturday','09:00','12:00')]],'Typical recurring FOOD service hours in America/Chicago; not real schedules.')
cats=[('grains',.30,False,180),('canned_goods',.25,False,240),('produce',.20,True,7),('protein',.15,True,10),('dairy',.10,True,8)]
save('food_categories',[dict(food_category=c,demand_share=s,requires_cold_storage=cold,typical_shelf_life_days=life,is_synthetic=True) for c,s,cold,life in cats],'Food-category assumptions; all quantities elsewhere use kilograms.')
start=datetime.date(2024,10,14);weeks=[start+datetime.timedelta(weeks=i) for i in range(104)]
weekly=[];category_rows=[];movement=[];events=[];batches=[];current=[]
for pi,p in enumerate(pantries):
 stock={c:round(65+R.random()*70,2) for c,*_ in cats}
 for wi,day in enumerate(weeks):
  end=day+datetime.timedelta(days=6)
  seasonal=1+.10*math.sin(2*math.pi*(day.timetuple().tm_yday-290)/365.25)
  holiday=.15 if day.month in (11,12) else 0
  households=round([108,160,137,143,150][pi]*(seasonal+holiday)*(1+.10*wi/103)*R.uniform(.88,1.12))
  kg_per=round(R.uniform(9.5,12),2);requested=round(households*kg_per,2)
  cap=p['weekly_household_capacity'];opening=round(sum(stock.values()),2)
  distributed=expired=received=0;shortfall=0
  for ci,(cat,share,cold,life) in enumerate(cats):
   op=stock[cat];exp=round(op*(R.uniform(.035,.10) if cold else R.uniform(0,.008)),2)
   rec=round(requested*share*R.uniform(.63,.98),2)
   need=round(requested*share,2)
   dist=round(min(op-exp+rec,need,cap*kg_per*share),2)
   close=round(op-exp+rec-dist,2);stock[cat]=close
   unmet=round(need-dist,2)
   category_rows.append(dict(pantry_id=p['pantry_id'],week_start=day,week_end=end,food_category=cat,requested_kg=need,distributed_kg=dist,unmet_kg=unmet,is_synthetic=True))
   movement.append(dict(pantry_id=p['pantry_id'],week_start=day,food_category=cat,opening_stock_kg=op,received_kg=rec,distributed_kg=dist,expired_kg=exp,closing_stock_kg=close,is_synthetic=True))
   received+=rec;expired+=exp;distributed+=dist
  requested=round(sum(x['requested_kg'] for x in category_rows[-5:]),2)
  distributed=round(distributed,2);served=min(households,cap,int(distributed/kg_per));turn=households-served
  weekly.append(dict(pantry_id=p['pantry_id'],service_area_id=p['service_area_id'],week_start=day,week_end=end,households_requesting=households,household_visits_served=served,households_unserved=turn,individual_service_instances=served*R.choice([2,3,4]),requested_kg=requested,distributed_kg=distributed,unmet_kg=round(requested-distributed,2),opening_stock_kg=opening,received_kg=round(received,2),expired_kg=round(expired,2),closing_stock_kg=round(sum(stock.values()),2),weekly_household_capacity=cap,is_synthetic=True))
  for ei,offset in enumerate([1,3,5]):
   # Divide weekly counts and quantities exactly among three service events.
   def part(total):return total//3+(1 if ei<total%3 else 0)
   events.append(dict(event_id=f'{p["pantry_id"]}-{day}-E{ei+1}',pantry_id=p['pantry_id'],event_date=day+datetime.timedelta(days=offset),households_requesting=part(households),household_visits_served=part(served),households_unserved=part(households)-part(served),is_synthetic=True))
 for ci,(cat,share,cold,life) in enumerate(cats):
  qty=stock[cat]
  for b,frac in enumerate([.4,.6]):
   expiry=today+datetime.timedelta(days=([2,5][b] if cold else [45,90][b]))
   batches.append(dict(batch_id=f'{p["pantry_id"]}-{cat}-{b+1}',pantry_id=p['pantry_id'],food_category=cat,quantity_kg=round(qty*frac,2) if b==0 else round(qty-round(qty*.4,2),2),received_date=today-datetime.timedelta(days=2),expiration_date=expiry,requires_cold_storage=cold,snapshot_date=today,is_synthetic=True))
  current.append(dict(pantry_id=p['pantry_id'],food_category=cat,quantity_kg=qty,snapshot_date=today,is_synthetic=True))
save('weekly_pantry_history',weekly,'104 completed Monday-Sunday weeks per pantry. Requests are synthetic observed outcomes for model targets; unavailable at prediction time. Served counts include repeat visits over time.')
save('weekly_category_demand',category_rows,'Weekly category requests, distribution, and unmet food quantities; reconciles to pantry history.')
save('weekly_inventory_movements',movement,'Inventory ledger: opening + received - distributed - expired = closing; consecutive weekly balances reconcile.')
save('attendance_events',events,'Three synthetic service events per week; attendance totals reconcile weekly. Not unique individuals or household identities.')
save('inventory_batches',batches,'Current synthetic batch inventory as of 2026-10-17; historical week-end stock carried forward with no assumed intervening movements. Expiry dates support first-expiring-first-out allocation.')
save('current_inventory',current,'Current category stock; identical in total to inventory_batches. Use one inventory source to avoid double counting.')
save('incoming_donations',[dict(donation_id=f'D{ci+1:03}',food_category=c,quantity_kg=[600,500,450,300,200][ci],available_date=today,expiration_date=today+datetime.timedelta(days=life if not cold else 4),requires_cold_storage=cold,is_synthetic=True) for ci,(c,s,cold,life) in enumerate(cats)],'Available donation pool for a what-if scenario; not yet included in pantry inventory.')
save('scenario_parameters',[dict(parameter=k,value=v,unit=u,is_synthetic=True) for k,v,u in [('planning_week_start','2026-10-19','date'),('forecast_horizon_weeks',1,'weeks'),('minimum_allocation',5,'kg'),('vehicle_capacity',700,'kg'),('allow_partial_fulfillment',True,'boolean')]],'Editable scenario assumptions. Pantry storage, cold storage and household service capacities are separate constraints.')
# Fixed illustrative service-area polygons, not real neighborhood/Census boundaries.
geo={'type':'FeatureCollection','features':[]}
for aid,n,lat,lon,*_ in areas:
 ring=[[lon-.018,lat-.018],[lon+.018,lat-.018],[lon+.018,lat+.018],[lon-.018,lat+.018],[lon-.018,lat-.018]]
 geo['features'].append(dict(type='Feature',properties=dict(service_area_id=aid,name=n,is_synthetic=True),geometry=dict(type='Polygon',coordinates=[ring])))
(out/'synthetic_service_areas.geojson').write_text(json.dumps(geo,indent=2))
dictionary=[]
for name,rows in tables.items():
 for col,v in rows[0].items():
  unit='kg' if col.endswith('_kg') else 'fraction (0-1)' if col.endswith('_rate') or col=='demand_share' else 'USD' if col.endswith('_usd') else ''
  dictionary.append(dict(file=name+'.csv',column=col,data_type=type(v).__name__,unit=unit,description=desc[name] if col==list(rows[0])[0] else col.replace('_',' ')))
with (out/'data_dictionary.csv').open('w',newline='') as f:
 w=csv.DictWriter(f,fieldnames=dictionary[0]);w.writeheader();w.writerows(dictionary)
# Validate data relationships, capacity, stock ledger, and event reconciliation.
assert len(weekly)==520 and len(events)==1560 and len(movement)==2600
event_sums=collections.defaultdict(lambda:[0,0,0])
for x in events:
 assert x['households_requesting']==x['household_visits_served']+x['households_unserved']
 d=x['event_date'];wk=d-datetime.timedelta(days=d.weekday());a=event_sums[(x['pantry_id'],wk)]
 for i,k in enumerate(['households_requesting','household_visits_served','households_unserved']):a[i]+=x[k]
for x in weekly:
 assert x['households_requesting']==x['household_visits_served']+x['households_unserved']
 assert event_sums[(x['pantry_id'],x['week_start'])]==[x[k] for k in ['households_requesting','household_visits_served','households_unserved']]
 assert abs(x['opening_stock_kg']+x['received_kg']-x['distributed_kg']-x['expired_kg']-x['closing_stock_kg'])<.011
 p=next(p for p in pantries if p['pantry_id']==x['pantry_id']);assert x['closing_stock_kg']<=p['storage_capacity_kg']
for x in movement:assert min(x[k] for k in ['opening_stock_kg','received_kg','distributed_kg','expired_kg','closing_stock_kg'])>=0
for p in pantries:
 cold=sum(x['quantity_kg'] for x in batches if x['pantry_id']==p['pantry_id'] and x['requires_cold_storage']);assert cold<=p['cold_storage_capacity_kg']
manifest=dict(dataset_name='FoodFit Synthetic Pantry Operations',version='1.0',generated_for_date=str(today),is_synthetic=True,real_organizations_used=False,history_start=str(weeks[0]),history_end=str(asof),random_seed=20261017,files={n+'.csv':len(r) for n,r in tables.items()},validation='passed')
(out/'manifest.json').write_text(json.dumps(manifest,indent=2))
readme='''# FoodFit synthetic data pack

ALL DATA IS SYNTHETIC. Five fictional pantries and fictional service areas near Dallas. No actual NTFB operations, Census estimates, real household records, real facility locations, or measured travel times. This is a coherent demo/test dataset, not evidence of real demand or model accuracy in Dallas.

## Coverage
104 completed weeks: 2024-10-14 through 2026-10-11. Snapshot: 2026-10-17. No movements are assumed between history end and snapshot. CSV dates are ISO YYYY-MM-DD. Service schedules use America/Chicago. All food quantities are kilograms; never add households, people, meals and kilograms together.

## Files and joins
pantries.csv: 5 fictional sites, map coordinates, total/cold storage kg limits and weekly household capacity.
service_areas.csv + synthetic_service_areas.geojson: 5 illustrative polygons and synthetic income/access features; join service_area_id. These IDs do NOT join to Census GEOIDs. Replace these demo features with your verified real demographic/boundary data when available, using an explicit spatial mapping.
pantry_hours.csv: recurring food service schedules, one row per open day.
weekly_pantry_history.csv: 520 rows, targets and history; join pantry_id + week_start.
weekly_category_demand.csv: 2,600 category demand/distribution rows; add food_category to the key.
weekly_inventory_movements.csv: 2,600 stock ledger rows, same category key.
attendance_events.csv: 1,560 event rows. Repeated visits are not unique residents.
inventory_batches.csv: 50 current batches and expiry dates for FEFO.
current_inventory.csv: 25 category aggregates of the SAME current batches; do not add both sources.
incoming_donations.csv: 5 unallocated donation lots; these are separate from existing stock.
food_categories.csv: category shares and shelf-life assumptions.
scenario_parameters.csv: editable planning assumptions.
data_dictionary.csv: column types, units and table descriptions.

## Forecasting
Forecast households_requesting or requested_kg separately per pantry, or requested_kg per pantry/category. Begin with last-week and 4-week rolling-mean baselines; compare on a chronological holdout. Train on weeks before 2026-07-20 and evaluate later completed weeks. Build lag features ONLY from earlier weeks. Current-week requested/distributed/unmet counts and closing inventory are future information at forecast time: do not use them as predictors. There are only 104 observations per pantry; prefer simple baselines. Random row splitting leaks temporal information. Any measured accuracy here describes generated data only.

The next planning week is 2026-10-19. The intervening week 2026-10-12 is intentionally incomplete and excluded. Forecast with the corresponding two-week lead from the last complete history; do not treat the incomplete week as zero or shift dates silently.

## Allocation simulation
Use forecast demand, current unexpired inventory, donation quantities, total storage, cold storage, and pantry household capacity. Define whether demand is total demand or additional need; avoid subtracting stock twice. Allocate in kg by category, enforce donation-pool limits, and compute unmet_kg = max(0, forecast_requested_kg - planned_distribution_kg). Model receiving and distribution timing explicitly before enforcing storage constraints. Prioritize earliest-expiring usable batches. Do not equate the count of unserved households with unmet kg: served households can receive partial quantities. Transport times/distances and real routes are NOT provided; vehicle capacity is only an editable assumption.

## Import
Python: pd.read_csv('weekly_pantry_history.csv', parse_dates=['week_start','week_end']). Load pantry/category IDs as strings. Convert is_synthetic values to booleans as needed. Every CSV includes is_synthetic=True. Store these in backend/data/synthetic/ and label the website 'Simulated operations — fictional pantries'. Do not combine NYC service totals with these records as if they describe the same geography.

## Refresh
This is a fixed snapshot, not a live feed. Regenerate only when you intentionally update the scenario and version. Missing real observations cannot be repaired by changing the synthetic label. Keep real-directory and synthetic operating data separate.
'''
(out/'README.md').write_text(readme)
(out/'generate_foodfit.py').write_text(pathlib.Path(__file__).read_text())
zip_path=out.parent/'FoodFit_Synthetic_Data_Pack.zip'
with zipfile.ZipFile(zip_path,'w',zipfile.ZIP_DEFLATED) as z:
 for p in sorted(out.iterdir()):z.write(p,'foodfit_synthetic/'+p.name)
print(json.dumps(manifest,indent=2));print(zip_path)
