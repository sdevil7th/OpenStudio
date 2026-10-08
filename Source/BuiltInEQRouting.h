#pragma once
#include <array>
#include <complex>
#include <cmath>

namespace BuiltInEQRouting
{
using Complex=std::complex<double>;
using Matrix=std::array<Complex,4>;
inline Matrix band(Complex h,int target)
{
    if(target==1) return {h,0,0,1};
    if(target==2) return {1,0,0,h};
    if(target==3) return {(h+1.0)*.5,(h-1.0)*.5,(h-1.0)*.5,(h+1.0)*.5};
    if(target==4) return {(h+1.0)*.5,(1.0-h)*.5,(1.0-h)*.5,(h+1.0)*.5};
    return {h,0,0,h};
}
inline Matrix multiply(const Matrix& a,const Matrix& b)
{
    return {a[0]*b[0]+a[1]*b[2],a[0]*b[1]+a[1]*b[3],a[2]*b[0]+a[3]*b[2],a[2]*b[1]+a[3]*b[3]};
}
inline double energy(const Matrix& m) {return std::sqrt((std::norm(m[0])+std::norm(m[1])+std::norm(m[2])+std::norm(m[3]))*.5);}
inline std::array<float,2> mix(float dryL,float dryR,float wetL,float wetR,const std::array<float,5>& weights)
{
    const float dryMid=(dryL+dryR)*.5f,drySide=(dryL-dryR)*.5f,wetMid=(wetL+wetR)*.5f,wetSide=(wetL-wetR)*.5f;
    float sum=0;for(float w:weights)sum+=w;
    return {(wetL*(weights[0]+weights[1])+dryL*weights[2]+(wetMid+drySide)*weights[3]+(dryMid+wetSide)*weights[4])/sum,
            (wetR*(weights[0]+weights[2])+dryR*weights[1]+(wetMid-drySide)*weights[3]+(dryMid-wetSide)*weights[4])/sum};
}
}
