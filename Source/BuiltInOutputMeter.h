#pragma once
#include "BuiltInLoudnessHistory.h"

// Stereo K-weighting and rectangular 400 ms / 3 s loudness windows.
// Coefficients: ITU-R BS.1770, Annex 1 (48 kHz reference); transformed
// through the bilinear domain for other device rates. History gating is computed
// by the consumer; full EBU meter certification is not claimed.
class BuiltInOutputMeter
{
public:
    BuiltInLoudnessHistory loudnessHistory;
    std::atomic<float> peakDb { -100 }, truePeakDb { -100 }, momentary { -100 }, shortTerm { -100 };
    void prepare(double rate, int block)
    {
        shortSize = juce::jmax(1, static_cast<int>(std::round(rate * 3)));
        momentarySize = juce::jmax(1, static_cast<int>(std::round(rate * .4)));
        energy.assign(static_cast<size_t>(shortSize), 0);
        maximumBlock = juce::jmax(1, block);
        oversampler = std::make_unique<juce::dsp::Oversampling<float>>(2, 4, juce::dsp::Oversampling<float>::filterHalfBandFIREquiripple, true);
        oversampler->initProcessing(static_cast<size_t>(maximumBlock));
        shelf = transform({1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, .73248077421585}, rate);
        highPass = transform({1, -2, 1, -1.99004745483398, .99007225036621}, rate);
        loudnessHistory.prepare(rate);
        reset();
    }
    void reset()
    {
        std::fill(energy.begin(), energy.end(), 0); history = {}; position = 0; sumM = sumS = 0; validSamples=0;
        loudnessHistory.reset();
        peakHold = truePeakHold = 0; holdRemaining = 0;
        peakDb.store(-100); truePeakDb.store(-100); momentary.store(-100); shortTerm.store(-100);
        if (oversampler) oversampler->reset();
    }
    void process(juce::AudioBuffer<float>& buffer)
    {
        const int channels = juce::jmin(2, buffer.getNumChannels());
        if (!oversampler || !channels) return;
        if(loudnessHistory.beginBlock())
        {
            history={};position=0;sumM=sumS=0;validSamples=0;peakHold=truePeakHold=0;holdRemaining=0;
        }
        float peak = 0, reconstructed = 0;
        for (int start = 0; start < buffer.getNumSamples(); start += maximumBlock)
        {
            const auto length = static_cast<size_t>(juce::jmin(maximumBlock, buffer.getNumSamples() - start));
            juce::dsp::AudioBlock<float> block(buffer);
            auto part = block.getSubsetChannelBlock(0, static_cast<size_t>(channels)).getSubBlock(static_cast<size_t>(start), length);
            auto up = oversampler->processSamplesUp(part);
            for (int ch = 0; ch < channels; ++ch)
                for (size_t i = 0; i < up.getNumSamples(); ++i) reconstructed = juce::jmax(reconstructed, std::abs(up.getSample(ch, static_cast<int>(i))));
        }
        for (int i = 0; i < buffer.getNumSamples(); ++i)
        {
            double power = 0;
            for (int ch = 0; ch < channels; ++ch)
            {
                const float sample = buffer.getSample(ch, i); peak = juce::jmax(peak, std::abs(sample));
                const double filtered = filter(filter(sample, shelf, history[static_cast<size_t>(ch)][0]), highPass, history[static_cast<size_t>(ch)][1]);
                power += filtered * filtered;
            }
            sumM += power - (validSamples>=momentarySize?energy[(position + energy.size() - static_cast<size_t>(momentarySize)) % energy.size()]:0);
            sumS += power - (validSamples>=shortSize?energy[position]:0); energy[position] = power; position = (position + 1) % energy.size();
            validSamples=juce::jmin(shortSize,validSamples+1);
            loudnessHistory.sample(juce::jmax(0.0,sumM/momentarySize),juce::jmax(0.0,sumS/shortSize));
        }
        if (holdRemaining <= 0) { peakHold = peak; truePeakHold = reconstructed; holdRemaining = momentarySize; }
        else { peakHold = juce::jmax(peakHold, peak); truePeakHold = juce::jmax(truePeakHold, reconstructed); }
        holdRemaining -= buffer.getNumSamples();
        peakDb.store(juce::Decibels::gainToDecibels(peakHold, -100.0f));
        truePeakDb.store(juce::Decibels::gainToDecibels(truePeakHold, -100.0f));
        momentary.store(loudness(sumM / momentarySize)); shortTerm.store(loudness(sumS / shortSize));
    }
private:
    using Coefficients = std::array<double, 5>;
    static Coefficients transform(Coefficients c, double rate)
    {
        const double r = rate / 48000.0, n0 = 1-r, n1 = 1+r, d0 = 1+r, d1 = 1-r;
        const auto expand = [&](double a, double b, double d) { return std::array<double, 3>{ a*d0*d0+b*n0*d0+d*n0*n0, 2*a*d0*d1+b*(n0*d1+n1*d0)+2*d*n0*n1, a*d1*d1+b*n1*d1+d*n1*n1 }; };
        const auto b = expand(c[0], c[1], c[2]), a = expand(1, c[3], c[4]);
        return { b[0]/a[0], b[1]/a[0], b[2]/a[0], a[1]/a[0], a[2]/a[0] };
    }
    static double filter(double x, const Coefficients& c, std::array<double, 2>& z)
    {
        const double y = c[0]*x+z[0]; z[0] = c[1]*x-c[3]*y+z[1]; z[1] = c[2]*x-c[4]*y; return y;
    }
    static float loudness(double value) { return value > 1e-10 ? static_cast<float>(-.691 + 10*std::log10(value)) : -100.0f; }
    Coefficients shelf {}, highPass {};
    std::array<std::array<std::array<double, 2>, 2>, 2> history {};
    std::unique_ptr<juce::dsp::Oversampling<float>> oversampler;
    std::vector<double> energy;
    size_t position = 0;
    int validSamples = 0;
    int momentarySize = 1, shortSize = 1, maximumBlock = 1, holdRemaining = 0;
    double sumM = 0, sumS = 0;
    float peakHold = 0, truePeakHold = 0;
};
