import json
from pathlib import Path
root=Path(__file__).resolve().parents[1]
seed=json.loads((root/'data/seed.json').read_text())
merge=json.loads((root/'data/merge-map.json').read_text())
people=[]; byid={}
for p in seed['html_people']:
    q={'id':p['id'],'given_name':p.get('given'),'surname':p.get('surname'),'aliases':[],'sex':p.get('sex','U'),'birth_year':None,'death_year':None,'notes':p.get('notes'),'source':'html'}
    byid[q['id']]=q; people.append(q)

def years(v):
    import re
    ys=re.findall(r'(1[5-9]\d{2}|20\d{2})',str(v or ''))
    return [int(x) for x in ys]
def splitname(s):
    a=s.strip().split()
    return (' '.join(a[:-1]),a[-1]) if len(a)>1 else (s.strip(),None)

def resolve(ref):
    if ref in byid:return ref
    if 'i'+ref in byid:return 'i'+ref

rels=[]; relset=set()
def add(a,b,t,source='html'):
    if not a or not b or a==b:return
    k=(a,b,t)
    if k not in relset:
        relset.add(k); rels.append({'from_person_id':a,'to_person_id':b,'relationship_type':t,'status':'approved','source':source})
remove=set(merge.get('excel_root_replacement',{}).get('remove_html_parent_relationships_for',[]))
for p in seed['html_people']:
    if p['id'] not in remove:
        for _,ref in p.get('parents',[]): add(resolve(ref),p['id'],'parent')
    for ref in p.get('spouses',[]): add(p['id'],resolve(ref),'spouse')

identity=merge.get('identity_matches',{})
excel_db={}; name_db={}
for p in seed['excel_people']:
    m=identity.get(p['name'])
    if m and m.get('html_id') in byid:
        dbid=m['html_id']; excel_db[p['id']]=dbid; name_db[p['name']]=dbid
        q=byid[dbid]
        canonical=m.get('canonical_name') or p['name']
        given,surname=splitname(canonical)
        q['given_name']=given; q['surname']=surname
        aliases=list(dict.fromkeys((m.get('aliases') or []) + ([f"{q['given_name']} {q['surname']}" ] if False else [])))
        # Preserve original HTML display name as an alias where it differs.
        orig=' '.join(x for x in [next((h.get('given') for h in seed['html_people'] if h['id']==dbid),''),next((h.get('surname') for h in seed['html_people'] if h['id']==dbid),'')] if x)
        if orig and orig!=canonical: aliases.append(orig)
        q['aliases']=list(dict.fromkeys(aliases))
        ds=merge.get('excel_dates',{}).get(p['name']) or p.get('dates')
        ys=years(ds)
        if ys:q['birth_year']=ys[0]; q['death_year']=ys[-1] if len(ys)>1 else None
        q['source']='excel'; q['notes']=(' '.join(x for x in [q.get('notes'),p.get('notes'),m.get('reason')] if x)).strip()
    elif p['id']=='excel-003' and 'Kwaku Buafo (Opayin Kankyea)' in name_db:
        excel_db[p['id']]=name_db['Kwaku Buafo (Opayin Kankyea)']
    else:
        eid=p['id']; given,surname=splitname(p['name']); ds=merge.get('excel_dates',{}).get(p['name']) or p.get('dates'); ys=years(ds)
        q={'id':eid,'given_name':given,'surname':surname,'aliases':[],'sex':'U','birth_year':ys[0] if ys else None,'death_year':ys[-1] if len(ys)>1 else None,'notes':p.get('notes') or 'Imported from the Kankyea and Mansa Excel family tree.','source':'excel'}
        byid[eid]=q; people.append(q); excel_db[eid]=eid; name_db[p['name']]=eid

def ex(n):return name_db.get(n)
topA,topB=ex('Kwaku Buafo (Opayin Kankyea)'),ex('Ama Buah (Nana Mansa)')
add(topA,topB,'spouse','excel')
for n in merge.get('excel_root_replacement',{}).get('top_couple_children',[]):
    c=ex(n)
    add(topA,c,'parent','excel'); add(topB,c,'parent','excel')
for p in seed['excel_people']:
    if not p.get('parent_name'):continue
    add(ex(p['parent_name']),excel_db.get(p['id']),'parent','excel')
# Remove old HTML Mansa parent relation entirely if any made it through, and ensure canonical Ama->Abena.
mansa=identity['Ama Buah (Nana Mansa)']['html_id']; abena=identity['Abena Gyampraa']['html_id']
rels=[r for r in rels if not (r['to_person_id']==mansa and r['relationship_type']=='parent')]
add(mansa,abena,'parent','excel')
# stable sort
people.sort(key=lambda p:(0 if p['source']=='html' else 1,p['id']))
(root/'public/demo.json').write_text(json.dumps({'people':people,'relationships':rels},ensure_ascii=False,indent=2))
print('demo people',len(people),'relationships',len(rels))
print('root',byid[topA]['given_name'],byid[topA]['surname'],'+',byid[topB]['given_name'],byid[topB]['surname'])
print('abena',byid[abena])
