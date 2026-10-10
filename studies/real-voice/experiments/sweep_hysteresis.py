"""Experiment on the development speakers: hysteresis voicing (low cut-off accepted next to a voiced frame).
python -I sweep_hysteresis.py align.json <explore-candidates dir> development
"""
import json,sys,glob
from pathlib import Path; sys.path.insert(0,str(Path(__file__).resolve().parent.parent))  # -I drops the script dir; our own code only
import numpy as np
from lib import *
al=json.load(open(sys.argv[1])); which=sys.argv[3]
def hyst(f0,conf,rms,hi,lo,semis=3.0,gate=0.003):
    ok=(rms>=gate)&(f0>0)
    v=ok&(conf>=hi)
    cand=ok&(conf>=lo)&~v
    changed=True
    while changed:
        changed=False
        for i in np.where(cand&~v)[0]:
            for j in (i-1,i+1):
                if 0<=j<len(v) and v[j] and abs(12*np.log2(f0[i]/f0[j]))<=semis:
                    v[i]=True; changed=True; break
    return v
for alg,his,los in (('yin',[.5],[.5,.4,.35,.3,.25,.2]),('mpm',[.55],[.55,.45,.4,.35,.3])):
    off=al['ptdb'][alg+'_contour']['best_offset_ms']/1000
    tot=np.zeros(5); res={}
    for lo in los:
        c=np.zeros(8)
        for p in sorted(glob.glob(sys.argv[2]+'/ptdb_*.json')):
            j=json.load(open(p)); spk=j['speaker']
            if split_of('ptdb',spk)!=which: continue
            ref=load_ref('ptdb',spk,j['id']); t=np.array(j['t'])
            r=ref_at('ptdb',ref,t,off); k=(t-off)<=(len(ref)-1)*0.01
            f=np.array(j[alg+'F0']); cf=np.array(j[alg+'Conf']); rm=np.array(j['rms'])
            v=hyst(f,cf,rm,his[0],lo)[k]; f=f[k]; r=r[k]
            rv=r>0; both=rv&v
            c+=[rv.sum(),(rv&~v).sum(),(~rv).sum(),(~rv&v).sum(),both.sum(),(both&gross_pitch_error(f,r)).sum(),len(rv),0]
        print(alg,'hi',his[0],'lo',lo,'V->U %.1f U->V %.1f VDE %.1f GPE %.2f'%(100*c[1]/c[0],100*c[3]/c[2],100*(c[1]+c[3])/c[6],100*c[5]/c[4]))
