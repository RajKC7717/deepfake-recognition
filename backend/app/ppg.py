"""
backend/app/ppg.py — PPG copied from user-provided code
"""
from __future__ import annotations
import logging
from collections import deque
from typing import Optional
import numpy as np

logger = logging.getLogger("backend.ppg")

class PPGSession:
    MAX_LEN = 300
    def __init__(self):
        self.r: deque = deque(maxlen=self.MAX_LEN)
        self.g: deque = deque(maxlen=self.MAX_LEN)
        self.b: deque = deque(maxlen=self.MAX_LEN)
    def append(self, r, g, b):
        self.r.append(r); self.g.append(g); self.b.append(b)
    def as_array(self):
        return (np.array(self.r,dtype=np.float64),
                np.array(self.g,dtype=np.float64),
                np.array(self.b,dtype=np.float64))
    def __len__(self): return len(self.r)

class PPGAnalyzer:
    FPS=30; MIN_FRAMES=60; FOREHEAD_FRAC_Y=0.15; FOREHEAD_FRAC_X=(0.25,0.75)
    def __init__(self): self._sessions={}
    def _get_session(self,sid):
        if sid not in self._sessions: self._sessions[sid]=PPGSession()
        return self._sessions[sid]
    def analyze(self,img_bgr,face_bbox,session_id="default"):
        session=self._get_session(session_id)
        rgb=self._extract_forehead_rgb(img_bgr,face_bbox)
        if rgb is None: return 0.5
        session.append(*rgb)
        if len(session)<self.MIN_FRAMES: return 0.0
        return self._compute_score(session)
    def _extract_forehead_rgb(self,img_bgr,face_bbox):
        try:
            h_img,w_img=img_bgr.shape[:2]
            if face_bbox:
                fx=int(face_bbox.get("x",0)); fy=int(face_bbox.get("y",0))
                fw=int(face_bbox.get("w",w_img)); fh=int(face_bbox.get("h",h_img))
            else: fx,fy,fw,fh=0,0,w_img,h_img
            roi_y1=fy; roi_y2=fy+max(1,int(fh*self.FOREHEAD_FRAC_Y))
            roi_x1=fx+int(fw*self.FOREHEAD_FRAC_X[0]); roi_x2=fx+int(fw*self.FOREHEAD_FRAC_X[1])
            roi_y1=max(0,roi_y1); roi_y2=min(h_img,roi_y2)
            roi_x1=max(0,roi_x1); roi_x2=min(w_img,roi_x2)
            if roi_y2<=roi_y1 or roi_x2<=roi_x1: return None
            roi=img_bgr[roi_y1:roi_y2,roi_x1:roi_x2].astype(np.float64)
            b,g,r=roi[:,:,0].mean(),roi[:,:,1].mean(),roi[:,:,2].mean()
            return float(r),float(g),float(b)
        except: return None
    def _compute_score(self,session):
        r,g,b=session.as_array()
        r_n=r/(r.mean()+1e-6); g_n=g/(g.mean()+1e-6); b_n=b/(b.mean()+1e-6)
        X=3*r_n-2*g_n; Y=1.5*r_n+g_n-1.5*b_n
        alpha=X.std()/(Y.std()+1e-9); ppg=X-alpha*Y
        fft=np.fft.rfft(ppg); freqs=np.fft.rfftfreq(len(ppg),d=1.0/self.FPS)
        mask=(freqs>=0.67)&(freqs<=3.33)
        power_in=np.abs(fft[mask]).sum(); power_all=np.abs(fft).sum()+1e-9
        snr=power_in/power_all
        return float(np.clip(1.0-snr*3,0.0,1.0))