import math, json
def srgb_to_lin(c):
    c/=255; return c/12.92 if c<=0.04045 else ((c+0.055)/1.055)**2.4
def lin_to_srgb(c):
    c = 12.92*c if c<=0.0031308 else 1.055*c**(1/2.4)-0.055
    return max(0,min(255,round(c*255)))
def hex2rgb(h): h=h.lstrip('#'); return [int(h[i:i+2],16) for i in (0,2,4)]
def rgb2hex(r): return '#%02X%02X%02X'%tuple(r)
def lum(h):
    r,g,b=[srgb_to_lin(x) for x in hex2rgb(h)]; return 0.2126*r+0.7152*g+0.0722*b
def cr(a,b):
    la,lb=lum(a),lum(b); hi,lo=max(la,lb),min(la,lb); return (hi+0.05)/(lo+0.05)
# OKLab
def rgb2oklab(h):
    r,g,b=[srgb_to_lin(x) for x in hex2rgb(h)]
    l=0.4122214708*r+0.5363325363*g+0.0514459929*b
    m=0.2119034982*r+0.6806995451*g+0.1073969566*b
    s=0.0883024619*r+0.2817188376*g+0.6299787005*b
    l,m,s=[x**(1/3) for x in (l,m,s)]
    return (0.2104542553*l+0.7936177850*m-0.0040720468*s,1.9779984951*l-2.4285922050*m+0.4505937099*s,0.0259040371*l+0.7827717662*m-0.8086757660*s)
def oklch2hex(L,C,H):
    a=C*math.cos(math.radians(H)); b=C*math.sin(math.radians(H))
    l=L+0.3963377774*a+0.2158037573*b; m=L-0.1055613458*a-0.0638541728*b; s=L-0.0894841775*a-1.2914855480*b
    l,m,s=l**3,m**3,s**3
    r=4.0767416621*l-3.3077115913*m+0.2309699292*s
    g=-1.2684380046*l+2.6097574011*m-0.3413193965*s
    bb=-0.0041960863*l-0.7034186147*m+1.7076147010*s
    if min(r,g,bb)<-0.0005 or max(r,g,bb)>1.0005: return None
    return rgb2hex([lin_to_srgb(max(0,min(1,x))) for x in (r,g,bb)])
L0,a,b=rgb2oklab('#FF7F50'); C0=math.hypot(a,b); H0=math.degrees(math.atan2(b,a))
print('coral oklch',round(L0,3),round(C0,3),round(H0,1))
steps={50:0.975,100:0.945,200:0.89,300:0.82,400:0.755,500:0.705,600:0.62,700:0.53,800:0.44,900:0.36,950:0.26}
scale={}
for k,L in steps.items():
    # chroma: shrink near extremes, keep within gamut
    C = C0*min(1, (1-L)/(1-L0)*1.0) if L>L0 else C0*(0.55+0.45*L/L0)
    if k in (50,100): C=C0*{50:0.12,100:0.25}[k]
    h=None; c=C
    while h is None: h=oklch2hex(L,c,H0 - (0 if L>0.7 else (0.7-L)*28)); c-=0.002
    scale[k]=h
scale[400]='#FF7F50'
ink='#1A1A19'; white='#FFFFFF'; dark='#141413'; surf_d='#1E1E1C'
print(f"{'step':>4} {'hex':8} {'vsWhite':>7} {'vsInk':>6} {'vsDark':>6} {'whiteOn':>7}")
for k,h in scale.items():
    print(f"{k:>4} {h:8} {cr(h,white):7.2f} {cr(h,ink):6.2f} {cr(h,dark):6.2f} {cr(white,h):7.2f}")
scale[400]='#FF7F50'
json.dump(scale,open('coral-scale.json','w'),indent=1)
