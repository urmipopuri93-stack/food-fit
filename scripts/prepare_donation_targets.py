"""Export only joinable USDA counts; leave missing values null and record provenance."""
import csv, io, json, subprocess
from pathlib import Path
root = Path(__file__).resolve().parents[1]
ref = 'b3da75fa7cc5e87a806e2b4d6d31cc5dd65b7073'
prefix = 'backend/data/original/usda_food_access_2019/'
def read(name):
    return subprocess.check_output(['git','show',f'{ref}:{prefix}{name}'], cwd=root).decode('utf-8-sig')
lookup = list(csv.DictReader(io.StringIO(read('VariableLookup.csv'))))
assert any('LALOWI1_10' in str(row) and 'Low access' in str(row) for row in lookup)
areas = {}
for row in csv.DictReader(io.StringIO(read('Food Access Research Atlas.csv'))):
    geoid = row['CensusTract'].zfill(11)
    if not geoid.startswith('48'): continue
    raw = row['LALOWI1_10'].strip()
    value = None if raw in ('','NULL') else float(raw)
    if value is not None and value < 0: raise ValueError(geoid)
    areas[geoid] = value
payload = {'source_branch':'manila/combined-data','source_commit':ref,
 'source_file':prefix+'Food Access Research Atlas.csv','field':'LALOWI1_10',
 'definition':'Low-income residents beyond 1 mile (urban) or 10 miles (rural) from a supermarket',
 'source':'USDA Food Access Research Atlas 2019; population base 2010',
 'assumption':'One kit per listed resident for one illustrative distribution; not measured meal demand',
 'areas':areas}
output = root/'frontend/public/data/donation_targets.json'
output.write_text(json.dumps(payload, separators=(',',':')),encoding='utf-8')
print(f'Exported {len(areas)} Texas areas; {sum(v is None for v in areas.values())} missing counts')
