"""Experiment on the development speakers: sweep the voicing cut-off and the silence gate.
python -I sweep_voicing_cutoff.py align.json <explore-candidates dir> development
"""
import json,sys,glob
from pathlib import Path; sys.path.insert(0,str(Path(__file__).resolve().parent.parent))  # -I drops the script dir; our own code only
import numpy as np
from lib import *
al=json.load(open(sys.argv[1])); which=sys.argv[3]
def collect(alg):
    off=al['ptdb'][alg+'_contour']['best_offset_ms']/1000
    R=[]
    for p in sorted(glob.glob(sys.argv[2]+'/ptdb_*.json')):
        j=json.load(open(p)); spk=j['speaker']
        if split_of('ptdb',spk)!=which: continue
        ref=load_ref('ptdb',spk,j['id']); t=np.array(j['t'])
        r=ref_at('ptdb',ref,t,off); k=(t-off)<=(len(ref)-1)*0.01
        R.append(np.stack([r[k],np.array(j[alg+'F0'])[k],np.array(j[alg+'Conf'])[k],np.array(j['rms'])[k]],1))
    return np.concatenate(R)
for alg,cuts in (('yin',[.3,.4,.5,.6,.7,.8]),('mpm',[.4,.5,.55,.6,.7,.8,.9])):
    R=collect(alg); rv=R[:,0]>0
    for rmsg in (0.003,0.001,0.0003):
        for c in cuts:
            ev=(R[:,1]>0)&(R[:,2]>=c)&(R[:,3]>=rmsg)
            both=rv&ev
            cents=np.abs(1200*np.log2(np.where(both,R[:,1],1)/np.where(both,R[:,0],1)))
            gross=both&(cents>GROSS_CENTS)
            print(alg,'rmsgate',rmsg,'cut',c,'V->U %.1f U->V %.1f VDE %.1f GPE %.2f'%(100*(rv&~ev).sum()/rv.sum(),100*(~rv&ev).sum()/(~rv).sum(),100*((rv&~ev).sum()+(~rv&ev).sum())/len(rv),100*gross.sum()/both.sum()))
