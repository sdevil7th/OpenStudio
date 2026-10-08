#pragma once
#include <JuceHeader.h>
#include "BuiltInIRColour.h"
#include <array>
#include <complex>

// Analysis-only sixth-order Butterworth bandpass. Base-10 octave edges are
// individually prewarped. No IEC class or acoustic certification is asserted.
struct BuiltInOctaveAnalysis
{
    static constexpr std::array<double,10> nominal {31.5,63,125,250,500,1000,2000,4000,8000,16000};
    std::array<BuiltInIRColour::Coefficients,3> sections {};
    double centre=0,low=0,high=0,peakFrequency=0,minimumDecay=0;
    bool available=false;
    bool prepare(size_t band,double rate)
    {
        available=false;
        if(band>=nominal.size()||!std::isfinite(rate)||rate<8000||rate>384000)return false;
        const double octave=std::pow(10.0,.3);
        centre=1000*std::pow(octave,static_cast<double>(band)-5);low=centre/std::sqrt(octave);high=centre*std::sqrt(octave);
        if(high>=rate*.49)return false;
        const double pi=juce::MathConstants<double>::pi,scale=2*rate;
        const double lower=scale*std::tan(pi*low/rate),upper=scale*std::tan(pi*high/rate);
        const double width=upper-lower,omega=std::sqrt(lower*upper);
        peakFrequency=rate/pi*std::atan(omega/scale);size_t index=0,realCount=0;double maximumPole=0;
        std::array<double,2> realPoles {};
        for(int k=0;k<3;++k)
        {
            const auto prototype=std::polar(1.0,pi*(2*k+4)/6);
            const auto discriminant=std::sqrt(width*width*prototype*prototype-std::complex<double>(4*omega*omega,0));
            for(double sign:{-1.0,1.0})
            {
                const auto analog=(width*prototype+sign*discriminant)*.5;
                const auto pole=(scale+analog)/(scale-analog);
                if(std::abs(pole.imag())<=1e-12)
                {
                    if(realCount>=realPoles.size()||std::abs(pole)>=1)return false;
                    realPoles[realCount++]=pole.real();maximumPole=std::max(maximumPole,std::abs(pole));continue;
                }
                if(pole.imag()<=1e-12)continue;
                if(index>=sections.size()||std::abs(pole)>=1)return false;
                sections[index++]={1,0,-1,-2*pole.real(),std::norm(pole)};
                maximumPole=std::max(maximumPole,std::abs(pole));
            }
        }
        if(realCount==2&&index<sections.size())sections[index++]={1,0,-1,-realPoles[0]-realPoles[1],realPoles[0]*realPoles[1]};
        else if(realCount!=0)return false;
        if(index!=sections.size())return false;
        double magnitude=1;for(const auto& section:sections)magnitude*=section.magnitude(peakFrequency,rate);
        const double gain=std::pow(magnitude,-1.0/3);
        for(auto& section:sections){section.b0*=gain;section.b2*=gain;}
        minimumDecay=-2*std::log(1000.0)/(rate*std::log(maximumPole));
        available=true;return true;
    }
    double magnitude(double frequency,double rate)const
    {double value=1;for(const auto& section:sections)value*=section.magnitude(frequency,rate);return value;}
    double process(double input,std::array<std::array<double,2>,3>& state)const noexcept
    {for(size_t i=0;i<sections.size();++i)input=sections[i].process(input,state[i]);return input;}
};
