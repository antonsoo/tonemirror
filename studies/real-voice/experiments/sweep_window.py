"""Experiment on the development speakers: analysis window of 2x or 3x the longest lag (explore-candidates.ts, FRAME_MULT).
python -I sweep_window.py <candidates dir> yin|mpm <cutoff>
"""
import json,sys,glob
from pathlib import Path; sys.path.insert(0,str(Path(__file__).resolve().parent.parent))  # -I drops the script dir; our own code only
import numpy as np
from lib import *
d=sys.argv[1]; alg=sys.argv[2]; cut=float(sys.argv[3])
files=[p for p in sorted(glob.glob(d+'/ptdb_*.json')) if split_of('ptdb',p.split('ptdb_')[1][:3])=='development']
data=[]
for p in files:
    j=json.load(open(p)); data.append((j['speaker'],load_ref('ptdb',j['speaker'],j['id']),np.array(j['t']),np.array(j[alg+'F0']),np.array(j[alg+'Conf']),np.array(j['rms'])))
def run(off,sex=None):
    c=np.zeros(7)
    for spk,ref,t,f,cf,rm in data:
        if sex and SEX(spk)!=sex: continue
        r=ref_at('ptdb',ref,t,off); k=(t-off)<=(len(ref)-1)*0.01
        v=(f>0)&(cf>=cut)&(rm>=0.003)
        r,f,v=r[k],f[k],v[k]
        rv=r>0; both=rv&v
        c+=[rv.sum(),(rv&~v).sum(),(~rv).sum(),(~rv&v).sum(),both.sum(),(both&gross_pitch_error(f,r)).sum(),len(rv)]
    return c
best=max(np.arange(0.010,0.045,0.002),key=lambda o:(lambda c:(c[4]-c[5])/c[0])(run(o)))
for sex in (None,'M','F'):
    c=run(best,sex); print(d.split('/')[-1],alg,'cut',cut,'sex',sex,'offset %.0f ms'%(best*1000),'V->U %.1f U->V %.1f VDE %.1f GPE %.2f'%(100*c[1]/c[0],100*c[3]/c[2],100*(c[1]+c[3])/c[6],100*c[5]/c[4]))
